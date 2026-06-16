// Voice-chat wiring check. The mic + Gemini (network) can't be driven
// deterministically headless, so this asserts everything AROUND them:
//   1. the dialogue PIPELINE — inject a transcript, with the brain + TTS
//      stubbed, and assert it shows the player's text, gets a reply, "speaks"
//      it, and returns to idle (proves voicechat → brain → speak → play → panel).
//   2. the PANEL — appears and sits ~1.5 m in front of the player.
//   3. the A BUTTON — toggle: TAP A starts recording, TAP again transcribes +
//      answers (recorder + transcribe stubbed). A probe maps the emulator's
//      face-button internal index → exposed gamepad index to confirm
//      VOICE_TUNING.buttonIndex.
// The live mic + real Gemini round-trip are verified manually in Chrome.

export async function run(rig, ctx) {
    const { VOICE_TUNING } = await import('/src/voicechat.js?v=' + Date.now());
    const vc = ctx.voicechat;
    rig.mark("script:start");

    if (!vc) { rig.mark("assert voicechat exists", "FAIL (ctx.voicechat missing)"); rig.mark("script:done"); return; }
    rig.mark("assert voicechat exists", "PASS");
    rig.mark("mic", `recorder.supported=${vc.recorder?.supported}`); // info: getUserMedia present?

    // Stub brain + both TTS paths so the demo stays offline/deterministic.
    let askedWith = null, spokeWith = null;
    vc.brain = { respond: async (t) => { askedWith = t; return "Aye, the targets are downrange."; } };
    vc.speakStream = async (t, { onChunk } = {}) => { spokeWith = t; onChunk?.(new Float32Array(2400), 24000); return { sampleRate: 24000, totalSamples: 2400 }; };
    vc.speak = async (t) => { spokeWith = t; return { samples: new Float32Array(2400), sampleRate: 24000 }; }; // 0.1 s

    // --- 1. PIPELINE (inject transcript; no mic, no network) ----------------
    const said = "Hello there, can I try the bow?";
    const reply = await vc.injectTranscript(said);

    rig.mark("pipeline", `state=${vc.state} played=${vc.lastPlayedSec.toFixed(2)}s reply="${reply}"`);
    rig.mark("assert shows player's text", vc.lastText === said ? "PASS" : `FAIL (${vc.lastText})`);
    rig.mark("assert brain got transcript", askedWith === said ? "PASS" : `FAIL (${askedWith})`);
    rig.mark("assert reply displayed", vc.lastReply === reply && reply.length > 0 ? "PASS" : `FAIL (${vc.lastReply})`);
    rig.mark("assert TTS got reply", spokeWith === reply ? "PASS" : `FAIL (${spokeWith})`);
    rig.mark("assert audio played", vc.lastPlayedSec > 0 ? "PASS" : "FAIL (no audio)");
    rig.mark("assert returns to idle", vc.state === "idle" && vc.busy === false ? "PASS" : `FAIL (${vc.state}/${vc.busy})`);

    // --- 2. PANEL appears ~1.5 m in front of the head ----------------------
    await rig.wait(0.3); // let _tick fade it in + position it
    const cam = ctx.scene.activeCamera;
    const plane = vc._plane;
    const dx = plane.position.x - cam.globalPosition.x;
    const dz = plane.position.z - cam.globalPosition.z;
    const horiz = Math.hypot(dx, dz);
    rig.mark("panel", `enabled=${plane.isEnabled()} vis=${plane.visibility.toFixed(2)} horiz=${horiz.toFixed(2)}m`);
    rig.mark("assert panel visible", plane.isEnabled() && plane.visibility > 0.5 ? "PASS" : "FAIL");
    rig.mark("assert panel ~1.5m ahead", Math.abs(horiz - VOICE_TUNING.distance) < 0.25 ? "PASS" : `FAIL (${horiz.toFixed(2)})`);

    // --- 3. A BUTTON: probe the emulator's internal→exposed mapping --------
    const rc = ctx.xr.input.controllers.find(c => c.inputSource?.handedness === VOICE_TUNING.hand);
    const gp = rc?.inputSource?.gamepad;
    rig.mark("gamepad", `present=${!!gp} nButtons=${gp?.buttons?.length}`);
    let internalForA = null;
    if (gp) {
        for (const internal of [3, 4, 5, 6, 7]) {
            rig.setButton(VOICE_TUNING.hand, internal, 1);
            await rig.wait(0.1);
            const pressed = gp.buttons.map((b, i) => (b.pressed ? i : -1)).filter(i => i >= 0);
            if (pressed.includes(VOICE_TUNING.buttonIndex)) internalForA = internal;
            rig.mark(`probe internal ${internal}`, `exposed pressed=[${pressed}]`);
            rig.setButton(VOICE_TUNING.hand, internal, 0);
            await rig.wait(0.05);
        }
    }
    rig.mark("buttonIndex map", internalForA !== null
        ? `exposed ${VOICE_TUNING.buttonIndex} (A) <- emulator internal ${internalForA}`
        : `could not drive exposed ${VOICE_TUNING.buttonIndex} from the emulator`);

    // --- 3b. TOGGLE: tap A starts recording, tap again sends ----------------
    // Stub the recorder + transcribe so no real mic / network is touched.
    vc.recorder = { supported: true, start: async () => {}, stop: async () => ({ wav: new Uint8Array(8), sampleRate: 48000, peak: 0.5, durationSec: 1, sampleCount: 48000 }) };
    vc.transcribe = async () => "tap to talk works";
    const tap = async () => {
        rig.setButton(VOICE_TUNING.hand, internalForA, 1); await rig.wait(0.1);
        rig.setButton(VOICE_TUNING.hand, internalForA, 0); await rig.wait(0.15);
    };
    if (internalForA !== null) {
        await tap();                       // tap 1 → start recording
        const recAfterTap1 = vc.recording;
        await tap();                       // tap 2 → stop + transcribe + answer
        await rig.wait(0.5);
        rig.mark("toggle", `recAfterTap1=${recAfterTap1} lastText="${vc.lastText}" state=${vc.state}`);
        rig.mark("assert tap1 starts recording", recAfterTap1 === true ? "PASS" : "FAIL (not recording after first tap)");
        rig.mark("assert tap2 → transcript", vc.lastText === "tap to talk works" ? "PASS" : `FAIL (${vc.lastText})`);
        rig.mark("assert turn completes", vc.state === "idle" && vc.busy === false ? "PASS" : `FAIL (${vc.state}/${vc.busy})`);
    } else {
        rig.mark("toggle", "SKIP (emulator A index unknown — set VOICE_TUNING.buttonIndex from probe)");
    }

    rig.mark("DONE npc-voice");
    rig.mark("script:done");
}
