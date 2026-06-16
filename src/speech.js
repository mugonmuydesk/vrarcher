// Microphone recorder for tap-to-talk speech input. Captures mic audio as PCM
// (via Web Audio) and encodes it to a WAV the dialogue brain can transcribe
// (gemini.js geminiTranscribe). NO Babylon — a platform service.
//
// Why not the Web Speech API: it's absent on the Quest browser (verified), so
// VRarcher records audio and sends it to Gemini for transcription instead. That
// works in desktop Chrome AND the standalone Quest browser.
//
// The mic stream + AudioContext are opened once and kept WARM between turns, so
// the 2nd+ recording starts instantly (no getUserMedia/device latency clipping
// the start of your speech). release() tears it down.
//
// PORT: on native Quest this becomes the Meta/Android recogniser, or the same
// record→transcribe call. start()/stop() contract stays the same.

export class MicRecorder {
    constructor() {
        this._ac = null; this._stream = null; this._src = null;
        this._proc = null; this._zero = null; this._chunks = null;
        this.recording = false;
    }

    get supported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
            && (window.AudioContext || window.webkitAudioContext));
    }

    // Open the mic + audio graph once and keep it warm. Throws if the mic is
    // blocked/unavailable — the permission must already be granted (an immersive
    // XR session can't show a prompt; grant it on the flat page first).
    async _ensure() {
        if (this._stream) return;
        this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const AC = window.AudioContext || window.webkitAudioContext;
        this._ac = new AC();
        this._src = this._ac.createMediaStreamSource(this._stream);
        this._zero = this._ac.createGain(); this._zero.gain.value = 0; // silent sink (no echo)
    }

    // Begin capturing. After the first call the mic is already warm, so this is
    // effectively instant.
    async start() {
        if (this.recording) return;
        await this._ensure();
        try { await this._ac.resume(); } catch { /* best effort */ }
        // ScriptProcessor is deprecated but present everywhere incl. the Quest
        // browser; AudioWorklet would need a separate module file.
        this._proc = this._ac.createScriptProcessor(4096, 1, 1);
        this._chunks = [];
        this._proc.onaudioprocess = (e) => {
            if (this.recording) this._chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        this._src.connect(this._proc); this._proc.connect(this._zero); this._zero.connect(this._ac.destination);
        this.recording = true;
    }

    // Stop capturing and return:
    //   { wav: Uint8Array, sampleRate, peak (0–1), durationSec, sampleCount }.
    // The mic stream + context stay warm for the next turn. `peak` distinguishes
    // real speech (>~0.01) from a silent/dead mic.
    async stop() {
        if (!this.recording) return null;
        this.recording = false;
        const rate = this._ac.sampleRate;
        try { this._src.disconnect(this._proc); this._proc.disconnect(); } catch { /* already torn down */ }
        const chunks = this._chunks; this._chunks = null; this._proc = null;
        let n = 0, peak = 0;
        for (const b of chunks) { n += b.length; for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > peak) peak = a; } }
        return { wav: encodeWAV(chunks, rate, n), sampleRate: rate, peak, durationSec: n / rate, sampleCount: n };
    }

    // Fully release the mic (close the stream + context). Call on teardown.
    release() {
        try {
            this._proc?.disconnect(); this._src?.disconnect(); this._zero?.disconnect();
            this._stream?.getTracks().forEach(t => t.stop());
            this._ac?.close();
        } catch { /* ignore */ }
        this._ac = this._stream = this._src = this._proc = this._zero = this._chunks = null;
        this.recording = false;
    }
}

// Float32 PCM chunks -> 16-bit mono WAV (Uint8Array). Gemini accepts audio/wav.
function encodeWAV(chunks, rate, n) {
    const pcm = new Float32Array(n);
    let o = 0; for (const b of chunks) { pcm.set(b, o); o += b.length; }
    const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2; }
    return new Uint8Array(ab);
}
