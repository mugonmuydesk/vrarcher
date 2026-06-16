// One-off bake: synthesise the 32 fillers with the SHIPPING Kokoro voice
// (bf_emma, q8, WASM — must match the live remainder TTS so the seam is
// seamless) and POST each as a 24 kHz mono WAV to the local bake receiver
// (tools/bake-fillers-receiver.py on :8077), which writes assets/fillers/fNN.wav.
//
// Run by pasting into the page console at http://localhost:8000/ (any tab where
// the vendored Kokoro bundle is reachable), with the receiver running. Re-bake
// whenever FILLERS or the shipping voice/dtype changes.
//
// Trims trailing near-silence (keeps a 60 ms tail) so the hand-off to the
// remainder TTS is tight. Returns a progress summary on window.__bake.

export async function bakeFillers() {
    const { FILLERS, fillerClip } = await import("/src/fillers.js?bake=" + Date.now());
    // The patched bundle resolves its vendored paths against self.__KOKORO_BASE
    // (so it also works inside the synth worker). Set it for this main-thread bake.
    self.__KOKORO_BASE = new URL("./", document.baseURI).href;
    const mod = await import("/vendor/kokoro/lib/kokoro.web.js?bake=" + Date.now());
    const tts = await mod.KokoroTTS.from_pretrained(
        "onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "wasm" });

    const RATE = 24000, THRESH = 0.012, TAIL = Math.round(0.06 * RATE);
    const done = [];
    for (let i = 0; i < FILLERS.length; i++) {
        const a = await tts.generate(FILLERS[i], { voice: "bf_emma" });
        let s = a.audio;                       // Float32, -1..1
        // Trim trailing silence (keep a short tail for a natural seam).
        let end = s.length;
        while (end > 1 && Math.abs(s[end - 1]) < THRESH) end--;
        end = Math.min(s.length, end + TAIL);
        s = s.subarray(0, end);
        const wav = encodeWAV(s, a.sampling_rate || RATE);
        await fetch(`http://127.0.0.1:8077/save?name=${fillerClip(i)}.wav`, {
            method: "POST", headers: { "Content-Type": "text/plain" }, body: bytesToB64(wav),
        });
        done.push({ i, clip: fillerClip(i), text: FILLERS[i], ms: Math.round(s.length / RATE * 1000) });
        window.__bake = { phase: "baking", count: done.length, total: FILLERS.length, last: done.at(-1) };
    }
    window.__bake = { phase: "done", count: done.length, clips: done };
    return window.__bake;
}

// Float32 mono -> 16-bit PCM WAV (Uint8Array).
function encodeWAV(pcm, rate) {
    const n = pcm.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true); o += 2; }
    return new Uint8Array(ab);
}

function bytesToB64(bytes) {
    let bin = ""; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
}
