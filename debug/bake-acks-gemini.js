// Bake the companion ACK clips (Stage-A receipt tokens + Stage-B response lines)
// in the SHIPPING Gemini companion voice, POSTing each as a WAV to the local bake
// receiver (tools/bake-acks-receiver.py on :8078 → assets/acks/akNN.wav). Mirrors
// debug/bake-fillers-gemini.js exactly; the only differences are the source list
// (ACK_MANIFEST from ack-lines.js) and the receiver port/dir.
//
// Run from the page console at a served build with the proxy reachable + the
// receiver running:
//   1) python3 tools/bake-acks-receiver.py        # in a terminal, from repo root
//   2) load http://localhost:8000 (proxy origin allowed), then in the console:
//        import("/debug/bake-acks-gemini.js").then(m => m.bakeAcksGemini())
// Re-bake whenever GEMINI_TUNING.voice/ttsStyle changes, or RECEIPTS / the line
// banks (command-bank.js ACK_LINES/SOCIAL_LINES/FALLBACK_LINES) change.
// Throttled to stay under the proxy's per-IP rate limit.

export async function bakeAcksGemini() {
    const { ACK_MANIFEST } = await import("/src/ack-lines.js?bake=" + Date.now());
    const { geminiSpeak } = await import("/src/gemini.js?bake=" + Date.now());
    const items = ACK_MANIFEST.map((e) => ({ text: e.text, name: e.file }));
    const RATE = 24000, THRESH = 0.01, TAIL = Math.round(0.05 * RATE);
    const done = [], failed = [];
    for (let i = 0; i < items.length; i++) {
        const { text, name } = items[i];
        try {
            const { samples, sampleRate } = await geminiSpeak(text);   // companion voice + style
            let s = samples, end = s.length;
            while (end > 1 && Math.abs(s[end - 1]) < THRESH) end--;     // trim trailing silence
            end = Math.min(s.length, end + TAIL);
            s = s.subarray(0, end);
            const wav = encodeWAV(s, sampleRate || RATE);
            await fetch(`http://127.0.0.1:8078/save?name=${name}.wav`, {
                method: "POST", headers: { "Content-Type": "text/plain" }, body: bytesToB64(wav),
            });
            done.push({ name, text, ms: Math.round(s.length / (sampleRate || RATE) * 1000) });
        } catch (e) {
            failed.push({ name, text, err: String(e && e.message || e).slice(0, 80) });
        }
        window.__bakeAcks = { phase: "baking", done: done.length, failed: failed.length, total: items.length, last: done.at(-1) || null };
        await new Promise((r) => setTimeout(r, 350));                  // throttle (proxy rate limit)
    }
    window.__bakeAcks = { phase: "done", baked: done.length, failed, clips: done };
    return window.__bakeAcks;
}

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
