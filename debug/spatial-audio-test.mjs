// Engine-clean unit test for the shared spatial-audio stack:
//   src/spatial-audio.js (SpatialAudio engine) + src/voice-audio.js (SpatialVoice).
// No browser: a minimal fake AudioContext exercises backend selection, the flipZ
// handedness conversion (Babylon LH → Web Audio RH), per-category distance tuning,
// the directional cone, the stereo-fallback L/R projection, outputFor routing, and
// the SpatialVoice persistent emitter. L/R-by-ear stays the in-headset gate.
//
//   node debug/spatial-audio-test.mjs   →  PASS/FAIL per case, exit 1 on any fail.

import { SpatialAudio, SPATIAL_AUDIO_TUNING } from "../src/spatial-audio.js";
import { SpatialVoice } from "../src/voice-audio.js";

let fails = 0;
const ok = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
    if (!cond) fails++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- fakes ----------------------------------------------------------------
const param = () => ({ value: 0 });
function fakePanner() {
    return {
        panningModel: "", distanceModel: "", refDistance: 0, maxDistance: 0, rolloffFactor: 0,
        coneInnerAngle: 0, coneOuterAngle: 0, coneOuterGain: 0,
        positionX: param(), positionY: param(), positionZ: param(),
        orientationX: param(), orientationY: param(), orientationZ: param(),
        connect() {},
    };
}
function fakeListener() {
    return {
        positionX: param(), positionY: param(), positionZ: param(),
        forwardX: param(), forwardY: param(), forwardZ: param(),
        upX: param(), upY: param(), upZ: param(),
    };
}
function makeCtx({ panner = true, stereo = true } = {}) {
    const ctx = {
        listener: fakeListener(), destination: { id: "dest" },
        createGain: () => ({ connect() {}, gain: param() }),
        createBufferSource: () => ({ connect() {}, start() { this._started = true; }, stop() { this._stopped = true; }, onended: null, buffer: null, playbackRate: param() }),
    };
    if (panner) ctx.createPanner = () => fakePanner();
    if (stereo) ctx.createStereoPanner = () => ({ pan: param(), connect() {} });
    return ctx;
}
const listenerLookingPlusZ = {
    position: { x: 0, y: 1.6, z: 0 },
    forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 },
};

// --- 1. backend availability ----------------------------------------------
ok("hrtf available when createPanner present", new SpatialAudio(makeCtx()).hrtf === true);
ok("hrtf unavailable without createPanner", new SpatialAudio(makeCtx({ panner: false })).hrtf === false);

// --- 2. setListener writes head pose with flipZ ---------------------------
{
    const ctx = makeCtx(); const sa = new SpatialAudio(ctx);
    sa.setListener(listenerLookingPlusZ);
    const L = ctx.listener;
    ok("listener pos X/Y unchanged", near(L.positionX.value, 0) && near(L.positionY.value, 1.6));
    ok("listener forward Z mirrored (flipZ)", near(L.forwardZ.value, -1), `fwdZ=${L.forwardZ.value}`);
}

// --- 3. panner: per-category tuning + flipZ position ----------------------
{
    const ctx = makeCtx(); const sa = new SpatialAudio(ctx);
    const pv = sa.panner({ x: 1, y: 0, z: 4 }, { category: "voice" });
    ok("voice category tuning applied",
        near(pv.refDistance, SPATIAL_AUDIO_TUNING.voice.refDistance) &&
        near(pv.rolloffFactor, SPATIAL_AUDIO_TUNING.voice.rolloff));
    ok("panner pos Z mirrored", near(pv.positionX.value, 1) && near(pv.positionZ.value, -4), `z=${pv.positionZ.value}`);
    const ps = sa.panner({ x: 0, y: 0, z: 0 }, { category: "sfx" });
    ok("sfx category tuning differs from voice",
        near(ps.refDistance, SPATIAL_AUDIO_TUNING.sfx.refDistance) &&
        ps.refDistance !== pv.refDistance);
}

// --- 4. cone: omni without forward, narrowed with forward -----------------
{
    const ctx = makeCtx(); const sa = new SpatialAudio(ctx);
    const p = sa.panner({ x: 0, y: 0, z: 2 }, { category: "voice" });          // no forward
    ok("cone omni when forward absent", p.coneInnerAngle === 360);
    sa.place(p, { x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: -1 }, SPATIAL_AUDIO_TUNING.voice);
    ok("cone narrowed when forward present",
        p.coneInnerAngle === SPATIAL_AUDIO_TUNING.voice.coneInnerDeg &&
        p.coneOuterGain === SPATIAL_AUDIO_TUNING.voice.coneOuterGain);
}

// --- 5. stereoPan reproduces the old _npcPan projection -------------------
function refPan(ex, ez, rx, rz) {
    const len = Math.hypot(ex, ez) || 1;
    return Math.max(-1, Math.min(1, (ex * rx + ez * rz) / len));
}
{
    const ctx = makeCtx({ panner: false }); const sa = new SpatialAudio(ctx);
    sa.setListener({ position: { x: 0, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } });
    const cases = [
        { e: { x: 3, z: 0 }, want: 1 }, { e: { x: -2, z: 0 }, want: -1 },
        { e: { x: 0, z: 5 }, want: 0 }, { e: { x: 2, z: 2 }, want: refPan(2, 2, 1, 0) },
    ];
    let allMatch = true;
    for (const c of cases) {
        const got = sa.stereoPan({ x: c.e.x, y: 0, z: c.e.z });
        if (!near(got, c.want)) { allMatch = false; console.log(`   pan=${got} want=${c.want}`); }
    }
    ok("stereoPan matches _npcPan projection (4 cases)", allMatch);
}

// --- 6. outputFor routing -------------------------------------------------
{
    const ctx = makeCtx(); const sa = new SpatialAudio(ctx);
    ok("outputFor(null) → destination", sa.outputFor(null) === ctx.destination);
    const node = sa.outputFor({ x: 1, y: 0, z: 1 }, { category: "sfx" });
    ok("outputFor(pos) → a panner (has refDistance)", typeof node.refDistance === "number");
    const ctx2 = makeCtx({ panner: false }); const sa2 = new SpatialAudio(ctx2);
    sa2.setListener({ position: { x: 0, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } });
    const sp = sa2.outputFor({ x: 5, y: 0, z: 0 });
    ok("outputFor falls back to stereo when no HRTF", sp.pan && near(sp.pan.value, 1), `pan=${sp.pan?.value}`);
}

// --- 7. playBufferAt starts a positioned source ---------------------------
{
    const ctx = makeCtx(); const sa = new SpatialAudio(ctx);
    const src = sa.playBufferAt({ duration: 1 }, { x: 2, y: 0, z: 0 }, { gain: 0.5, pitch: 1.2 });
    ok("playBufferAt started + pitched a source", src._started === true && near(src.playbackRate.value, 1.2));
}

// --- 8. SpatialVoice over the engine --------------------------------------
{
    const ctx = makeCtx(); const sa = new SpatialAudio(ctx);
    const v = new SpatialVoice(sa);
    ok("voice hrtf mode + panner output", v.mode === "hrtf" && typeof v.output.refDistance === "number");
    v.attachTo({ position: { x: 0, y: 0, z: 6 } });
    v.update();
    ok("voice emitter positioned (flipZ)", near(v.output.positionZ.value, -6), `z=${v.output.positionZ.value}`);
    const s1 = v.playClip({ duration: 1 });
    ok("voice playClip started", s1._started === true);
    v.stop();
    ok("voice stop() halted clip", s1._stopped === true);
    // stereo-mode voice falls back cleanly
    const sa2 = new SpatialAudio(makeCtx({ panner: false }));
    sa2.setListener({ position: { x: 0, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } });
    const v2 = new SpatialVoice(sa2);
    v2.attachTo({ position: { x: 4, y: 0, z: 0 } });
    v2.update();
    ok("stereo-mode voice pans to the emitter", v2.mode === "stereo" && near(v2.output.pan.value, 1));
}

console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
process.exit(fails ? 1 : 0);
