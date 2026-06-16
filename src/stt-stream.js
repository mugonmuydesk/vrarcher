// Streaming-feel speech-to-text — emits PARTIAL transcripts while the user is
// still talking, then a FINAL transcript when capture stops. The adapter
// (voicechat.js) feeds it mic PCM frame-by-frame; the turn-end logic and LLM
// can fire the instant the user stops, instead of waiting for one batch
// transcription after the fact. NO Babylon imports: a plain JSON/HTTP client
// that transcribes 1:1 to a Unity layer for the native port.
//
// APPROACH — incremental re-transcription (NOT Gemini Live).
//   The true low-latency path is the Gemini Live bidirectional API, but that
//   speaks over a WebSocket (BidiGenerateContent) and the shipped Cloudflare
//   proxy (proxy/gemini-proxy.worker.js) only forwards plain POSTs for the
//   generateContent / streamGenerateContent methods to allow-listed models —
//   it has no WebSocket upgrade path. Routing Live through it would mean
//   editing the worker, which is out of scope here. So instead we re-transcribe
//   a GROWING audio buffer on a fixed cadence (PARTIAL_INTERVAL_MS) via the
//   existing, proxy-safe geminiTranscribe() batch call: every tick we WAV-encode
//   everything captured so far and transcribe it, surfacing the result as a
//   partial. On stop() we transcribe the final buffer once more for the clean
//   end-of-turn transcript. Each tick is a complete, independent call, so the
//   transcript can revise as more audio arrives (typical of incremental ASR).
//
// PORT: same record→transcribe HTTP idiom as gemini.js; the start/pushAudio/
// onPartial/onFinal/stop contract maps onto a native incremental recogniser
// (Meta/Android) or a server streaming-ASR socket without changing callers.
//
// PORT: re-transcribing the GROWING buffer every tick is O(N²) in audio length —
// inherent to this proxy-no-WebSocket stand-in, not a tuning choice. The real
// Phase-4 fix is a true streaming-ASR / Gemini Live WebSocket path (deferred,
// needs the worker's WS upgrade). Until then we soften the constant: downsample
// to 16 kHz before encoding (Fix C, ~3× fewer bytes) and reuse a fresh partial
// as the final result when the buffer hasn't grown (Fix B, no extra batch call).

import { geminiTranscribe } from "./gemini.js";
import { resampleLinear } from "./vad.js";

// Tunables (the port's re-tuning checklist).
export const STT_STREAM_TUNING = {
    partialIntervalMs: 700,     // re-transcribe the growing buffer this often (ms)
    minPartialSec: 0.30,        // skip a tick until at least this much audio exists (s)
                                // — a <0.3 s clip rarely has a usable word and
                                // wastes a call.
    maxBufferSec: 30,           // safety cap on retained audio (s); older audio is
                                // never dropped below this — guards a stuck stream
                                // from sending ever-larger clips forever.
    sampleRate: 16000,          // default capture rate (Hz) if start() omits it;
                                // overridden by the mic's actual AudioContext rate.
    encodeRate: 16000,          // resample to this rate (Hz) before WAV-encoding —
                                // Gemini accepts 16 kHz, so a 48 kHz capture uploads
                                // ~3× fewer bytes and the O(N²) cost constant shrinks.
    finalReuseMaxGrowthMs: 500, // on stop(): if a recent partial exists AND the buffer
                                // grew by less than this since it, REUSE that partial as
                                // the final result instead of re-transcribing — cuts the
                                // end-of-turn → final latency in the common case (ms).
};

// One in-flight streaming-STT session. Construct once and reuse across turns
// (start()/stop() per utterance); pushAudio() between them. Engine-clean.
export class SttStream {
    constructor() {
        this._chunks = null;        // Float32Array[] captured this utterance
        this._samples = 0;          // total samples buffered
        this._rate = STT_STREAM_TUNING.sampleRate;
        this._timer = null;         // partial-tick interval handle
        this._busy = false;         // a transcription is in flight (skip overlap)
        this._epoch = 0;            // bumped on stop()/cancel() so stale calls are ignored
        this._lastPartial = "";     // last emitted partial (dedupe identical ticks)
        this._lastPartialSamples = 0; // buffer length (samples) when _lastPartial was set
                                      // — lets stop() reuse it if little new audio arrived.
        this._ctrl = null;          // AbortController for the in-flight transcription
                                    // (so cancel() can abort it mid-flight).
        this.running = false;
        // Callbacks — set via onPartial()/onFinal() or passed to start().
        this._onPartial = null;
        this._onFinal = null;
    }

    // Register/replace the partial-transcript callback. fn(text) fires each tick
    // the transcript changes while capturing. Returns this for chaining.
    onPartial(fn) { this._onPartial = fn; return this; }

    // Register/replace the final-transcript callback. fn(text) fires once when
    // stop() resolves. Returns this for chaining.
    onFinal(fn) { this._onFinal = fn; return this; }

    // Begin a new utterance. Clears any previous buffer and starts the partial
    // ticker. Options:
    //   sampleRate — capture rate in Hz (pass the mic AudioContext's rate so the
    //                WAV header is correct); defaults to the tuning value.
    //   onPartial / onFinal — convenience: set the callbacks here instead of the
    //                methods.
    start({ sampleRate, onPartial, onFinal } = {}) {
        if (onPartial) this._onPartial = onPartial;
        if (onFinal) this._onFinal = onFinal;
        if (sampleRate) this._rate = sampleRate;
        this._chunks = [];
        this._samples = 0;
        this._busy = false;
        this._lastPartial = "";
        this._lastPartialSamples = 0;
        this._ctrl = null;
        this._epoch++;
        this.running = true;
        this._timer = setInterval(() => this._tick(), STT_STREAM_TUNING.partialIntervalMs);
    }

    // Feed a frame of mono Float32 PCM (e.g. one ScriptProcessor block). Copies
    // the frame (the caller's buffer is typically reused by Web Audio). No-op if
    // not running. Trims the front of the buffer past maxBufferSec.
    pushAudio(pcm) {
        if (!this.running || !pcm || !pcm.length) return;
        this._chunks.push(pcm.slice ? pcm.slice(0) : new Float32Array(pcm));
        this._samples += pcm.length;
        const cap = STT_STREAM_TUNING.maxBufferSec * this._rate;
        while (this._samples > cap && this._chunks.length > 1) {
            this._samples -= this._chunks.shift().length;
        }
    }

    // Stop capturing, produce the final transcript, fire onFinal(text) and
    // resolve to that text (""=no speech). Safe to call when not running
    // (resolves ""). The session can be start()ed again after.
    //
    // Fix B: if a recent partial already covers the buffer (it grew by less than
    // finalReuseMaxGrowthMs of audio since that partial was emitted), REUSE the
    // partial as the final result rather than re-running a full batch transcription
    // — that saves one whole transcribe latency exactly at end-of-turn. Otherwise
    // (no usable partial, or fresh tail audio arrived) do the final transcription.
    async stop() {
        if (!this.running) return "";
        this.running = false;
        clearInterval(this._timer);
        this._timer = null;
        this._epoch++;                 // invalidate any in-flight partial tick
        const growth = this._samples - this._lastPartialSamples;
        const reuseCap = (STT_STREAM_TUNING.finalReuseMaxGrowthMs / 1000) * this._rate;
        const canReuse = this._lastPartial && growth >= 0 && growth < reuseCap;
        const text = canReuse ? this._lastPartial : await this._transcribeBuffer();
        this._chunks = null;
        this._samples = 0;
        this._onFinal?.(text);
        return text;
    }

    // Public barge-in / interrupt path: abort any in-flight transcription, drop
    // the current utterance and leave the stream IDLE (safe to start() again).
    // Contract (the voicechat agent calls `this.stt?.cancel()`):
    //   • bumps the epoch so a late in-flight result is ignored;
    //   • sets running=false and stops the partial ticker;
    //   • aborts the in-flight geminiTranscribe via its AbortController;
    //   • fires NO onFinal (a cancelled turn produces no transcript);
    //   • is idempotent and never throws — safe to call when not running.
    cancel() {
        this.running = false;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this._epoch++;                 // stale partial/final results now dropped
        if (this._ctrl) { try { this._ctrl.abort(); } catch { /* already aborted */ } }
        this._ctrl = null;
        this._chunks = null;
        this._samples = 0;
        this._busy = false;
    }

    // --- internals ---------------------------------------------------------

    // One partial tick: skip if busy, too short, or empty. Transcribe the
    // growing buffer and emit a partial if the text changed and we're still the
    // current epoch (a late reply from before stop()/restart is dropped).
    async _tick() {
        if (this._busy || !this.running) return;
        if (this._samples < STT_STREAM_TUNING.minPartialSec * this._rate) return;
        const epoch = this._epoch;
        const samplesAtTick = this._samples;   // buffer length this partial covers
        this._busy = true;
        try {
            const text = await this._transcribeBuffer();
            if (epoch === this._epoch && this.running && text && text !== this._lastPartial) {
                this._lastPartial = text;
                this._lastPartialSamples = samplesAtTick; // for stop()'s reuse check
                this._onPartial?.(text);
            }
        } catch {
            /* transient transcription error — next tick retries */
        } finally {
            this._busy = false;
        }
    }

    // Downsample the buffered audio to encodeRate (16 kHz), WAV-encode it and run
    // geminiTranscribe over it. Returns "" for an empty buffer (no call made).
    // Fix C: encoding at 16 kHz instead of the capture rate (e.g. 48 kHz) uploads
    // ~3× fewer bytes per tick. The AbortController is held on the instance so
    // cancel() can abort the request mid-flight.
    async _transcribeBuffer() {
        if (!this._chunks || !this._samples) return "";
        const rate = STT_STREAM_TUNING.encodeRate;
        // Flatten the captured chunks, then resample the whole buffer to 16 kHz.
        // resampleLinear is a no-op (slice) when this._rate already equals rate.
        const flat = flattenChunks(this._chunks, this._samples);
        const down = resampleLinear(flat, this._rate, rate);
        const wav = encodeWAV([down], rate, down.length);
        this._ctrl = new AbortController();
        try {
            const text = await geminiTranscribe(wav, { mimeType: "audio/wav", signal: this._ctrl.signal });
            return text || "";
        } finally {
            this._ctrl = null;
        }
    }
}

// Concatenate Float32 chunks into one contiguous Float32Array of length n.
function flattenChunks(chunks, n) {
    const out = new Float32Array(n);
    let off = 0;
    for (const b of chunks) { out.set(b, off); off += b.length; }
    return out;
}

// Float32 PCM chunks -> 16-bit mono WAV (Uint8Array), matching speech.js's
// encoder so transcripts are byte-for-byte comparable. Gemini accepts audio/wav.
function encodeWAV(chunks, rate, n) {
    const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, n * 2, true);
    let off = 44;
    for (const b of chunks) {
        for (let i = 0; i < b.length; i++) {
            const s = Math.max(-1, Math.min(1, b[i]));
            v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            off += 2;
        }
    }
    return new Uint8Array(ab);
}
