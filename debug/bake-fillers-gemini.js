// Bake the conversational fillers in the SHIPPING Gemini companion voice (so the
// prebaked clips seam with live geminiSpeak), POSTing each as a WAV to the local
// bake receiver (tools/bake-fillers-receiver.py on :8077 → assets/fillers/fNN.wav).
//
// Run from the page console at a served build with the proxy reachable + the
// receiver running. Uses gemini.js geminiSpeak (same voice + style directive as
// live), so re-bake whenever GEMINI_TUNING.voice/ttsStyle or FILLERS changes.
// Throttled to stay under the proxy's per-IP rate limit. Set window.__bakeBarks
// = true before running to also bake BARKS (bNN.wav).

export async function bakeFillersGemini() {
    const { FILLERS, BARKS, fillerClip, barkClip } = await import("/src/fillers.js?bake=" + Date.now());
    const { geminiSpeak } = await import("/src/gemini.js?bake=" + Date.now());
    const items = [
        ...FILLERS.map((t, i) => ({ text: t, name: fillerClip(i) })),
        ...(window.__bakeBarks ? BARKS.map((t, i) => ({ text: t, name: barkClip(i) })) : []),
    ];
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
            await fetch(`http://127.0.0.1:8077/save?name=${name}.wav`, {
                method: "POST", headers: { "Content-Type": "text/plain" }, body: bytesToB64(wav),
            });
            done.push({ name, text, ms: Math.round(s.length / (sampleRate || RATE) * 1000) });
        } catch (e) {
            failed.push({ name, text, err: String(e && e.message || e).slice(0, 80) });
        }
        window.__bake = { phase: "baking", done: done.length, failed: failed.length, total: items.length, last: done.at(-1) || null };
        await new Promise((r) => setTimeout(r, 350));                  // throttle (proxy rate limit)
    }
    window.__bake = { phase: "done", baked: done.length, failed, clips: done };
    return window.__bake;
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
