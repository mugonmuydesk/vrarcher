// On-device Kokoro-82M TTS check. Loads the real model (WebGPU→WASM fallback),
// synthesises a line, and asserts the {samples, sampleRate} contract VoiceChat
// consumes — plus the streaming path fires onChunk and the chunks sum to a
// sane clip length. This is NETWORK + heavy: it downloads ~86 MB of weights on
// first run and warms ONNX Runtime, so allow ~30–60 s before PASS markers.
//
// Run: http://localhost:8000/index.html?demo=kokoro-tts&autorun=1  (enter XR).
// Unlike the cloud voice, this needs no key/proxy — only WebGPU + a network for
// the one-time model fetch.

export async function run(rig, ctx) {
    rig.mark("script:start");
    const k = await import('/src/kokoro.js?v=' + Date.now());
    rig.mark("import kokoro.js", "PASS");

    // --- 1. LOAD the model (WebGPU, auto-fallback to WASM) -----------------
    const tLoad = performance.now();
    let loaded = false;
    try {
        await k.loadKokoro();
        loaded = true;
    } catch (e) {
        rig.mark("assert model loads", `FAIL (${e.message})`);
        rig.mark("script:done"); return;
    }
    rig.mark("load", `ready=${k.kokoroReady()} in ${((performance.now() - tLoad) / 1000).toFixed(1)}s`);
    rig.mark("assert model loads", loaded && k.kokoroReady() ? "PASS" : "FAIL");

    // --- 2. WHOLE-CLIP synth (the fallback path) ---------------------------
    const line = "Nice shot. Settle your stance and breathe.";
    const t0 = performance.now();
    let clip;
    try { clip = await k.kokoroSpeak(line); }
    catch (e) { rig.mark("assert synth", `FAIL (${e.message})`); rig.mark("script:done"); return; }
    const sec = clip.samples.length / clip.sampleRate;
    rig.mark("synth", `samples=${clip.samples.length} rate=${clip.sampleRate} ` +
        `dur=${sec.toFixed(2)}s in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    rig.mark("assert returns samples", clip.samples?.length > 1000 ? "PASS" : `FAIL (${clip.samples?.length})`);
    rig.mark("assert 24kHz mono", clip.sampleRate === 24000 ? "PASS" : `FAIL (${clip.sampleRate})`);
    rig.mark("assert sane duration", sec > 0.5 && sec < 12 ? "PASS" : `FAIL (${sec.toFixed(2)}s)`);
    // Audio should not be silent (peak well above zero).
    let peak = 0; for (let i = 0; i < clip.samples.length; i++) { const a = Math.abs(clip.samples[i]); if (a > peak) peak = a; }
    rig.mark("assert audible (not silence)", peak > 0.02 ? "PASS" : `FAIL (peak ${peak.toFixed(3)})`);

    // --- 3. STREAMING path: onChunk fires, chunks sum to a clip ------------
    let chunks = 0, streamed = 0, rate = 0;
    try {
        const r = await k.kokoroSpeakStream("Lift the bow. Draw to your cheek. Loose.", {
            onChunk: (s, sr) => { chunks++; streamed += s.length; rate = sr; },
        });
        rig.mark("stream", `chunks=${chunks} samples=${streamed} rate=${rate} reported=${r.totalSamples}`);
        rig.mark("assert stream fires onChunk", chunks >= 1 ? "PASS" : "FAIL (no chunks)");
        rig.mark("assert stream sums match", r.totalSamples === streamed && streamed > 1000 ? "PASS" : `FAIL (${r.totalSamples} vs ${streamed})`);
    } catch (e) {
        rig.mark("assert stream fires onChunk", `FAIL (${e.message})`);
    }

    // --- 4. AUDIBLE: play the clip so it can be heard in-headset -----------
    const a = ctx.feedback?.audio;
    if (a && clip.samples.length) {
        try {
            if (a.state === "suspended") await a.resume();
            const buf = a.createBuffer(1, clip.samples.length, clip.sampleRate);
            buf.copyToChannel(clip.samples, 0);
            const src = a.createBufferSource(); src.buffer = buf; src.connect(a.destination); src.start();
            rig.mark("playback", "started (listen for Wren)");
        } catch (e) { rig.mark("playback", `skipped (${e.message})`); }
    }

    rig.mark("DONE kokoro-tts");
    rig.mark("script:done");
}
