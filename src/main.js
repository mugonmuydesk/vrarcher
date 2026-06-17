// Entry point: builds the scene, wires the systems together, runs the loop.
// All systems hang off a single shared `ctx` object so cross-module access
// is explicit and there are no hidden globals (except window.rig for the
// emulator test rig and window.ctx for console poking).

import { createScene } from "./scene.js";
import { HandSystem } from "./hands.js";
import { initDebug } from "./debug.js";
import { Feedback } from "./feedback.js";
import { InteractionSystem } from "./interaction.js";
import { initPhysics } from "./physics.js";
import { PhysicsHandSystem } from "./handphysics.js";
import { makeThrowable, makeHeavyThrowable, makeTwoHandedThrowable } from "./throwable.js";
import { Bow } from "./bow.js";
import { ArrowSystem, STREAK_TUNING, PUFF_TUNING } from "./arrow.js";
import { ControlBoard } from "./controlboard.js";
import { ForcePull } from "./forcepull.js";
import { NpcSystem } from "./npcsystem.js";
import { VoiceChat } from "./voicechat.js";
import { geminiSpeak, geminiSpeakStream, GEMINI_BACKEND } from "./gemini.js";
import { prof } from "./profiler.js";
import { VoicePanel } from "./voicepanel.js";
import { Addressing } from "./addressing.js";
import { Barks } from "./barks.js";
import { Acks } from "./acks.js";
import { TurnDetector } from "./turn.js";
// VAD + the turn-detector model scorers run in a Web Worker (voice-worker.js) so
// their ORT/wasm inference never stalls the XR render loop — these are the off-main
// drop-ins for createVad / createSmartTurnScorer / createTurnSenseScorer, each with
// a main-thread fallback if the worker fails. See src/voiceworker.js.
import { createVadProxy, loadWorkerAudioScorer, loadWorkerTextScorer } from "./voiceworker.js";
import { SttStream } from "./stt-stream.js";
import { Target } from "./target.js";
import { HoverButton, FingertipButton } from "./buttons.js";
import { CircularDrive, LinearDrive } from "./drives.js";
import { Joystick, IKArm } from "./handles.js";
import { Door } from "./door.js";
import { attachHoverLabel } from "./labels.js";
import { Locomotion } from "./locomotion.js";
import { applyLightmaps } from "./lightmaps.js";
import { BlobShadows } from "./blobshadow.js";
import { BirdSystem } from "./birds.js";
import { NpcHud } from "./npchud.js";
import { Interactable } from "./interaction.js";
import { installRig } from "../debug/rigctl.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, { stencil: true });

const ctx = { engine, canvas };
// Per-frame work registry: props and helpers push `(dt) => void` here at
// construction and the render loop ticks them in registration order — the
// ONE per-frame entry point besides the core systems below. Never register
// scene.onBeforeRenderObservable callbacks for game logic (hidden ordering,
// unportable, invisible to headless ticks).
ctx.updatables = [];
await createScene(ctx); // sets ctx.scene, ctx.xr, ctx.ground

ctx.debug = initDebug(ctx);
ctx.feedback = new Feedback(ctx);
// Central per-frame writer of the single Web Audio listener (the player's head),
// shared by ALL positional sound — the NPC voice AND every `sound(name, { at })`.
// One writer avoids two subsystems fighting over the lone AudioListener. Skips
// until the AudioContext exists (first sound) and only while a camera is live.
ctx.updatables.push(() => {
    const fb = ctx.feedback;
    if (!fb?.hasAudio) return;
    const cam = ctx.scene?.activeCamera;
    if (!cam) return;
    const p = cam.globalPosition;
    const f = cam.getDirection(BABYLON.Axis.Z);   // head forward (Babylon LH, +Z)
    const u = cam.getDirection(BABYLON.Axis.Y);
    const r = cam.getDirection(BABYLON.Axis.X);   // right axis (stereo fallback)
    fb.spatial.setListener({
        position: { x: p.x, y: p.y, z: p.z },
        forward: { x: f.x, y: f.y, z: f.z },
        up: { x: u.x, y: u.y, z: u.z },
        right: { x: r.x, y: r.y, z: r.z },
    });
});
await initPhysics(ctx);
ctx.hands = new HandSystem(ctx);
ctx.physicsHands = new PhysicsHandSystem(ctx);
ctx.interaction = new InteractionSystem(ctx);
installRig(ctx); // window.rig — IWE emulator puppeteering

// Test props (Babylon +Z = XR -Z, player at origin).
{
    const mat = (name, r, g, b) => {
        const m = new BABYLON.StandardMaterial(name, ctx.scene);
        m.diffuseColor = new BABYLON.Color3(r, g, b);
        return m;
    };

    // Static crate, top surface at y = 0.8.
    const crate = BABYLON.MeshBuilder.CreateBox("crate", { width: 0.5, height: 0.8, depth: 0.5 }, ctx.scene);
    crate.position.set(5.45, 0.4, 0.55); // +5 X: non-archery props moved right
    crate.material = mat("crateMat", 0.5, 0.35, 0.2);
    new BABYLON.PhysicsAggregate(crate, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, ctx.scene);
    crate.metadata = Object.assign(crate.metadata || {}, { soundMaterial: "wood" });

    // Throwable ball resting on the crate (auto-catch enabled: throw it at
    // a free hand and it attaches).
    const ball = BABYLON.MeshBuilder.CreateSphere("ball", { diameter: 0.1 }, ctx.scene);
    ball.position.set(5.45, 0.86, 0.55);
    ball.material = mat("ballMat", 0.2, 0.5, 0.9);
    const ballIt = makeThrowable(ctx, ball, {
        shapeType: BABYLON.PhysicsShapeType.SPHERE, mass: 0.25,
        restitution: 0.5, holdPose: "Hold", autoCatch: true, forcePull: true,
    });
    ball.metadata = Object.assign(ball.metadata || {}, { soundMaterial: "metal", soundSize: "small" });

    // Heavy crate on the floor to the right: force-dragged, never kinematic.
    const heavyBox = BABYLON.MeshBuilder.CreateBox("heavyBox", { size: 0.35 }, ctx.scene);
    heavyBox.position.set(6.0, 0.18, 0.5);
    heavyBox.material = mat("heavyBoxMat", 0.25, 0.25, 0.3);
    const heavyIt = makeHeavyThrowable(ctx, heavyBox, { mass: 8, holdPose: "Hold" });
    heavyBox.metadata = Object.assign(heavyBox.metadata || {}, { soundMaterial: "metal", soundSize: "big" });

    // Two-handed beam on the floor to the left: spring-held by both hands.
    const beam = BABYLON.MeshBuilder.CreateBox("beam",
        { width: 1.0, height: 0.12, depth: 0.12 }, ctx.scene);
    beam.position.set(4.1, 0.07, 0.7);
    beam.material = mat("beamMat", 0.6, 0.5, 0.25);
    const beamIt = makeTwoHandedThrowable(ctx, beam, { mass: 4, holdPose: "Hold" });
    beam.metadata = Object.assign(beam.metadata || {}, { soundMaterial: "wood", soundSize: "big" });

    // Throwable cube within arm's reach.
    const cube = BABYLON.MeshBuilder.CreateBox("grabCube", { size: 0.12 }, ctx.scene);
    cube.position.set(4.65, 1.1, 0.45);
    cube.material = mat("grabCubeMat", 0.9, 0.6, 0.2);
    makeThrowable(ctx, cube, {
        shapeType: BABYLON.PhysicsShapeType.BOX, mass: 0.2, holdPose: "Hold",
    });
    cube.metadata = Object.assign(cube.metadata || {}, { soundMaterial: "wood", soundSize: "small" });

    // Ring target downrange (+Z): tagged stick surface + scoring +
    // scoreboard (Phase 7).
    ctx.target = new Target(ctx, { position: new BABYLON.Vector3(0, 1.4, 6) });

    // The bow, floating grabbable at the player's left.
    ctx.bow = new Bow(ctx);
    ctx.bow.root.position.set(-0.5, 1.2, 0.2);
    ctx.bow.root.rotation.y = Math.PI / 2;
    const bowIt = ctx.interaction.register(new Interactable(ctx.bow.root, {
        grabTypes: ["grip"],
        holdPose: "Hold",
        hoverRadius: 0.25, // stave is long and thin; bounding sphere is generous anyway
        // Parent + zero only; the real grip pose is per-hand and applied
        // by bow.grabbed() (SNAP_POS / SNAP_ROT in bow.js).
        snapToPose: {
            position: new BABYLON.Vector3(0, 0, 0),
            rotation: BABYLON.Quaternion.Identity(),
        },
        onGrab: (hand) => ctx.bow.grabbed(hand),
        onRelease: () => ctx.bow.released(),
    }));

    ctx.arrows = new ArrowSystem(ctx);

    // Remote grab (force-pull): point at a flagged grabbable and flick to
    // summon it to the hand (see forcepull.js). The ball is flagged forcePull.
    ctx.forcePull = new ForcePull(ctx);

    // Button pedestal to the player's right: hover button (start round) on
    // top, fingertip button on the player-facing side.
    const pedestal = BABYLON.MeshBuilder.CreateBox("pedestal",
        { width: 0.15, height: 0.9, depth: 0.15 }, ctx.scene);
    pedestal.position.set(0.7, 0.45, 0.05);
    pedestal.material = mat("pedestalMat", 0.3, 0.3, 0.33);
    new BABYLON.PhysicsAggregate(pedestal, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, ctx.scene);

    ctx.buttons = {
        // Big red button: starts a new archery game (zeroes the score).
        // Stays at the player's right — NOT moved with the other props.
        start: new HoverButton(ctx, {
            name: "startButton",
            position: new BABYLON.Vector3(0.7, 0.9, 0.05),
            onDown: () => {
                ctx.target.resetRound(); // new game: score back to 0
                ctx.feedback.sound("score", { pitch: 1.2, at: ctx.buttons.start.root });
            },
        }),
        fancy: new FingertipButton(ctx, {
            name: "fancyButton",
            position: new BABYLON.Vector3(0.7, 0.65, -0.025),
            // local +Y (press axis) -> world -Z, facing the player
            rotation: BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Right(), -Math.PI / 2),
            onDown: () => ctx.feedback.sound("nockReady", { pitch: 1.5, at: ctx.buttons.fancy.root }),
        }),
    };

    // Crank to the player's left: raises/lowers the target
    // (value 0 -> y 0.6, value 1 -> y 1.4; starts raised).
    const crankMax = 2.5 * Math.PI;
    const pole = BABYLON.MeshBuilder.CreateBox("crankPole",
        { width: 0.05, height: 1.05, depth: 0.05 }, ctx.scene);
    pole.position.set(4.15, 0.525, 0.74);
    pole.material = mat("crankPoleMat", 0.3, 0.25, 0.2);
    ctx.crank = new CircularDrive(ctx, {
        name: "targetCrank",
        position: new BABYLON.Vector3(4.15, 1.05, 0.7),
        limits: [0, crankMax],
        startAngle: crankMax,
        mode: "direct",
        onValue: (v) => { ctx.target.root.position.y = 0.6 + 0.8 * v; },
    });

    // Slider rail to the player's right (unwired; exposes value 0-1).
    ctx.slider = new LinearDrive(ctx, {
        name: "slider",
        start: new BABYLON.Vector3(5.1, 1.02, 0.85),
        end: new BABYLON.Vector3(5.6, 1.02, 0.85),
    });

    // Joystick dead ahead on a pole (outputs -1..1 per axis to the HUD).
    const joyPole = BABYLON.MeshBuilder.CreateBox("joyPole",
        { width: 0.05, height: 0.95, depth: 0.05 }, ctx.scene);
    joyPole.position.set(5, 0.475, 1.15);
    joyPole.material = mat("joyPoleMat", 0.3, 0.25, 0.2);
    ctx.joystick = new Joystick(ctx, {
        position: new BABYLON.Vector3(5, 0.95, 1.15),
        onValue: (x, z) => ctx.debug.set("joystick", `x:${x.toFixed(2)} z:${z.toFixed(2)}`),
    });

    // Desk-lamp IK arm on a side table to the left.
    const lampTable = BABYLON.MeshBuilder.CreateBox("lampTable",
        { width: 0.3, height: 0.75, depth: 0.3 }, ctx.scene);
    lampTable.position.set(4.55, 0.375, 0.95);
    lampTable.material = mat("lampTableMat", 0.35, 0.3, 0.25);
    new BABYLON.PhysicsAggregate(lampTable, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, ctx.scene);
    ctx.ikarm = new IKArm(ctx, {
        position: new BABYLON.Vector3(4.55, 0.75, 0.95),
    });

    // Latched door off to the right of the range: turn the handle, then
    // push it open. Hinge post at x 0.95; handle near the free edge.
    ctx.door = new Door(ctx, {
        position: new BABYLON.Vector3(5.95, 0, 1.3),
    });

    // Two particle-tuning boards to the player's left (-X), facing the start
    // point. Physical sliders write live into the arrow TUNING blocks: board 1
    // tunes the flight smoke trail (STREAK_TUNING), board 2 the impact puff
    // (PUFF_TUNING). Ranges below are the slider bounds.
    const int = (v) => Math.round(v).toString();
    const mm = (v) => v.toFixed(3);            // millimetre-scale sizes
    ctx.trailBoard = new ControlBoard(ctx, {
        name: "trailBoard",
        position: new BABYLON.Vector3(-1.1, 1.35, 0.9),
        title: "ARROW SMOKE TRAIL",
        params: [
            { label: "Emit rate", unit: "/s",   min: 50,    max: 1500,  value: STREAK_TUNING.emitRate, fmt: int, apply: (v) => { STREAK_TUNING.emitRate = v; } },
            { label: "Lifetime",  unit: "s",     min: 0.2,   max: 3.0,   value: STREAK_TUNING.lifetime, apply: (v) => { STREAK_TUNING.lifetime = v; } },
            { label: "Min size",  unit: "m",     min: 0.004, max: 0.06,  value: STREAK_TUNING.minSize,  fmt: mm, apply: (v) => { STREAK_TUNING.minSize = v; } },
            { label: "Max size",  unit: "m",     min: 0.01,  max: 0.12,  value: STREAK_TUNING.maxSize,  fmt: mm, apply: (v) => { STREAK_TUNING.maxSize = v; } },
            { label: "Opacity",   unit: "",      min: 0,     max: 1,     value: STREAK_TUNING.opacity,  apply: (v) => { STREAK_TUNING.opacity = v; } },
            { label: "Spread",    unit: "m/s",   min: 0,     max: 0.6,   value: STREAK_TUNING.spread,   apply: (v) => { STREAK_TUNING.spread = v; } },
            { label: "Rise",      unit: "m/s2",  min: -1.5,  max: 1.5,   value: STREAK_TUNING.riseY,    apply: (v) => { STREAK_TUNING.riseY = v; } },
        ],
    });
    ctx.puffBoard = new ControlBoard(ctx, {
        name: "puffBoard",
        position: new BABYLON.Vector3(-1.85, 1.35, 1.4),
        title: "ARROW HIT PUFF",
        params: [
            { label: "Burst count", unit: "",     min: 5,     max: 150,  value: PUFF_TUNING.count,       fmt: int, apply: (v) => { PUFF_TUNING.count = v; } },
            { label: "Min life",    unit: "s",     min: 0.1,   max: 1.5,  value: PUFF_TUNING.minLifetime, apply: (v) => { PUFF_TUNING.minLifetime = v; } },
            { label: "Max life",    unit: "s",     min: 0.2,   max: 2.5,  value: PUFF_TUNING.maxLifetime, apply: (v) => { PUFF_TUNING.maxLifetime = v; } },
            { label: "Min size",    unit: "m",     min: 0.004, max: 0.06, value: PUFF_TUNING.minSize,     fmt: mm, apply: (v) => { PUFF_TUNING.minSize = v; } },
            { label: "Max size",    unit: "m",     min: 0.01,  max: 0.12, value: PUFF_TUNING.maxSize,     fmt: mm, apply: (v) => { PUFF_TUNING.maxSize = v; } },
            { label: "Spread",      unit: "m/s",   min: 0,     max: 0.4,  value: PUFF_TUNING.spread,      apply: (v) => { PUFF_TUNING.spread = v; } },
            { label: "Rise",        unit: "m/s2",  min: -1.5,  max: 1.5,  value: PUFF_TUNING.riseY,       apply: (v) => { PUFF_TUNING.riseY = v; } },
            { label: "Opacity",     unit: "",      min: 0,     max: 1,    value: PUFF_TUNING.opacity,     apply: (v) => { PUFF_TUNING.opacity = v; } },
        ],
    });

    // Hover labels on the graspables (catalog §Ambient/contextual).
    attachHoverLabel(ctx, ballIt, "BALL");
    attachHoverLabel(ctx, heavyIt, "HEAVY CRATE");
    attachHoverLabel(ctx, beamIt, "BEAM (2-HAND)");
    attachHoverLabel(ctx, bowIt, "BOW");
    attachHoverLabel(ctx, ctx.crank.interactable, "TARGET CRANK");
    attachHoverLabel(ctx, ctx.slider.interactable, "SLIDER");
    attachHoverLabel(ctx, ctx.joystick.interactable, "JOYSTICK");
    attachHoverLabel(ctx, ctx.ikarm.interactable, "LAMP");
    attachHoverLabel(ctx, ctx.door.interactable, "DOOR HANDLE");

    // Blob contact shadows under the free-moving props (door panel and
    // fixture-mounted handles excluded — never free-floating).
    ctx.blobShadows = new BlobShadows(ctx);
    ctx.blobShadows.register(ball);
    ctx.blobShadows.register(cube);
    ctx.blobShadows.register(heavyBox);
    ctx.blobShadows.register(beam);
    // Target: a medium pool beneath the stand. It sits ~1.4 m up, so a large
    // fadeHeight keeps it visible and it grows slightly with that height.
    ctx.blobShadows.register(ctx.target.root, {
        radiusX: 0.6, radiusZ: 0.6, alpha: 0.32, fadeHeight: 6, scaleAtFade: 1.6,
    });

    // Soaring eagles (register their own faint shadows — blobShadows exists now).
    ctx.birds = new BirdSystem(ctx);

    // Wandering NPC (CC0 mannequin). Keeps `clearance` from these props and
    // the player; stops + faces the player when they approach and look at it.
    // (x,z,r) of the static props it should walk around.
    const npcObstacles = [
        { x: 0, z: 6, r: 0.7 },      // target
        { x: 0.7, z: 0.05, r: 0.35 },// button pedestal
        { x: -0.5, z: 0.2, r: 0.3 }, // bow
        { x: -1.1, z: 0.9, r: 0.45 },// trail board
        { x: -1.85, z: 1.4, r: 0.45 },// puff board
        { x: 4.1, z: 0.7, r: 0.6 },  // beam
        { x: 4.15, z: 0.74, r: 0.25 },// crank pole
        { x: 4.55, z: 0.95, r: 0.3 },// lamp table
        { x: 4.65, z: 0.45, r: 0.2 },// grab cube
        { x: 5, z: 1.15, r: 0.25 },  // joystick pole
        { x: 5.45, z: 0.55, r: 0.5 },// crate
        { x: 5.95, z: 1.3, r: 0.5 }, // door
        { x: 6.0, z: 0.5, r: 0.4 },  // heavy box
    ];
    ctx.npcs = new NpcSystem(ctx, { obstacles: npcObstacles, spawns: [{ x: -3.5, z: 3.5 }] });

    // Voice dialogue: TAP A (right controller) — or V on desktop — to start
    // recording, tap again to send. The mic transcript shows on a panel 1.5 m
    // ahead, goes to Gemini (recorded audio → transcript → chat → spoken reply,
    // panned toward an attending NPC). Brain/STT/TTS are engine-clean
    // (gemini.js / speech.js); this is just the WebXR adapter.
    ctx.voicechat = new VoiceChat(ctx);
    // Frame-hitch profiler (always on): flags render frames slower than 20 fps and
    // reports which voice ops ran + a state snapshot, POSTed to the proxy's /hitch
    // so a `wrangler tail` can watch hitches live on the headset. ctx.profiler is
    // also exposed for console poking (prof.* via the shared singleton).
    ctx.profiler = prof;
    prof.enable(ctx, { endpoint: GEMINI_BACKEND.proxyBase + "/hitch", hitchMs: 50 });

    // TTS backend, switchable live from the voice panel (voicepanel.js):
    //   "wasm"   — on-device Kokoro-82M, CPU Web Worker, fully offline (default;
    //              smooth — inference is off the render thread — but ~5-7 s/turn)
    //   "q32"    — on-device Kokoro fp32 on WebGPU (transformers v4, CDN-loaded
    //              on demand): much faster but runs on the render GPU; experimental
    //   "gemini" — cloud Gemini via the proxy (geminiSpeak/geminiSpeakStream)
    // Only the VOICE differs; STT + the dialogue brain always use Gemini.
    // ctx.setVoiceBackend(name) swaps ctx.voicechat.speak/speakStream and warms
    // the chosen model in the background. ctx.voiceBackend (current name) and
    // ctx.voiceStatus (human string) are what the panel renders. Default "wasm";
    // ?tts=wasm|q32|gemini overrides.
    ctx.voiceBackend = null;
    ctx.voiceStatus = "";
    let _wasm = null, _gpu = null;
    ctx.setVoiceBackend = async (name) => {
        ctx.voiceBackend = name;
        try {
            if (name === "wasm") {
                ctx.voiceStatus = "WASM: loading…";
                _wasm = _wasm || await import("./kokoro.js");
                ctx.voicechat.speak = _wasm.kokoroSpeak;
                ctx.voicechat.speakStream = _wasm.kokoroSpeakStream;
                _wasm.loadKokoro()
                    .then(() => { if (ctx.voiceBackend === "wasm") ctx.voiceStatus = "WASM: ready"; })
                    .catch((e) => { if (ctx.voiceBackend === "wasm") ctx.voiceStatus = "WASM: load failed"; console.warn("[main] WASM load:", e.message); });
                ctx.voiceStatus = _wasm.kokoroReady() ? "WASM: ready" : "WASM: loading…";
            } else if (name === "q32") {
                ctx.voiceStatus = "q32: loading…";
                _gpu = _gpu || await import("./kokoro-gpu.js");
                ctx.voicechat.speak = _gpu.kokoroGpuSpeak;
                ctx.voicechat.speakStream = _gpu.kokoroGpuSpeakStream;
                _gpu.loadKokoroGpu()
                    .then(() => { if (ctx.voiceBackend === "q32") ctx.voiceStatus = "q32: ready (webgpu)"; })
                    .catch((e) => { if (ctx.voiceBackend === "q32") ctx.voiceStatus = /WebGPU/.test(e.message) ? "q32: no WebGPU here" : "q32: load failed"; console.warn("[main] q32 load:", e.message); });
                ctx.voiceStatus = _gpu.kokoroGpuReady() ? "q32: ready (webgpu)" : "q32: loading…";
            } else if (name === "none") {
                // Tier-1 text-only: no speech. The reply text shows on the NPC
                // head HUD (npchud.js) instead of being voiced. speak returns a
                // 1-sample silence so any whole-clip fallback path stays safe;
                // speakStream emits no chunks and resolves immediately.
                ctx.voicechat.speak = async () => ({ samples: new Float32Array(1), sampleRate: 24000 });
                ctx.voicechat.speakStream = async () => {};
                ctx.voiceStatus = "text only";
            } else {
                ctx.voicechat.speak = geminiSpeak;
                ctx.voicechat.speakStream = geminiSpeakStream;
                ctx.voiceStatus = "Gemini: cloud";
            }
        } catch (e) {
            ctx.voiceStatus = name + ": unavailable"; console.warn("[main] backend import failed:", e.message);
        }
        // Filled-pause masking: the companion voice is Gemini, and the filler
        // bank is baked in the Gemini voice, so fillers apply on the Gemini path.
        if (ctx.voicechat.brain) ctx.voicechat.brain.fillers = (name === "gemini");
        console.log("[main] TTS backend:", ctx.voiceBackend, "—", ctx.voiceStatus);
    };
    const _ttsParam = new URLSearchParams(location.search).get("tts");
    await ctx.setVoiceBackend(["wasm", "q32", "gemini"].includes(_ttsParam) ? _ttsParam : "gemini");

    // STT (speech-to-text) backend, switchable live — mirrors the TTS switch above:
    //   "gemini" — cloud transcription via the proxy (geminiTranscribe); DEFAULT.
    //   "vosk"   — on-device Vosk (Kaldi WASM, src/vosk.js); fully offline, no cloud.
    //              Lazy-loaded ONLY when selected: the ~40 MB model is never fetched
    //              on the default Gemini path. While the model downloads/untars the
    //              transcriber isn't ready, so we keep Gemini live until it resolves,
    //              then swap ctx.voicechat.transcribe to Vosk (and fall back to Gemini
    //              if the load fails). ctx.sttBackend = current name; ctx.sttStatus =
    //              human string. ?stt=vosk overrides the default.
    // Selecting "vosk" moves BOTH STT surfaces on-device: the batch transcribe
    // (`ctx.voicechat.transcribe`, used by push-to-talk / the final fallback) AND the
    // LIVE streaming partials (`ctx.voicechat.stt`, the hands-free per-turn driver).
    // The cloud SttStream (stt-stream.js) is held in `_geminiStt` and restored when
    // switching back to "gemini", so the default cloud path is fully reinstated.
    const _geminiTranscribe = ctx.voicechat.transcribe;   // the default injected fn
    // The cloud SttStream is created later (ctx.stt, line below) and attached via
    // attachHandsFree, so resolve it lazily at swap time rather than capturing now.
    const _geminiStt = () => ctx.stt;                     // the default cloud SttStream
    ctx.sttBackend = "gemini";
    ctx.sttStatus = "Gemini: cloud";
    let _voskTr = null;                                    // cached Vosk transcriber handle
    let _voskStt = null;                                   // cached VoskSttStream (live partials)
    let _liveStt = null;                                   // cached GeminiLiveSttStream (true streaming)
    ctx.setSttBackend = async (name) => {
        if (name === "gemini-live") {
            // True streaming STT over the Gemini Live WebSocket (gemini-live-stt.js):
            // replaces only the LIVE streaming-partials surface (ctx.voicechat.stt).
            // The batch transcribe (push-to-talk / final fallback) stays cloud Gemini
            // — Live is a per-turn streaming socket, not a one-shot transcriber. Same
            // start/pushAudio/stop/cancel contract, so voicechat.js is unchanged.
            ctx.sttBackend = "gemini-live";
            try {
                const mod = await import("./gemini-live-stt.js");
                if (ctx.sttBackend !== "gemini-live") return;   // switched away mid-load
                ctx.voicechat.transcribe = _geminiTranscribe;   // batch stays cloud Gemini
                _liveStt = _liveStt || new mod.GeminiLiveSttStream();
                ctx.voicechat.stt = _liveStt;
                ctx.sttStatus = "Gemini Live: streaming (cloud WS)";
                console.log("[main] STT backend: gemini-live — true streaming over Live WebSocket");
            } catch (e) {
                ctx.sttBackend = "gemini";
                ctx.voicechat.transcribe = _geminiTranscribe;
                ctx.voicechat.stt = _geminiStt();
                ctx.sttStatus = "Gemini Live: load failed → Gemini";
                console.warn("[main] Gemini Live STT load failed; staying on cloud re-transcription:", e?.message || e);
            }
        } else if (name === "vosk") {
            ctx.sttBackend = "vosk";
            ctx.sttStatus = "Vosk: loading…";
            console.log("[main] STT backend: vosk — loading (on-device, ~40 MB model)…");
            try {
                const mod = await import("./vosk.js");
                _voskTr = _voskTr || await mod.createVoskTranscriber();   // warms the shared model
                if (ctx.sttBackend !== "vosk") return;     // switched away mid-load
                ctx.voicechat.transcribe = (audio, rate) => _voskTr.transcribe(audio, rate);
                // Swap the live-partials stream on-device too. The model is now warm
                // (createVoskTranscriber resolved), so VoskSttStream.start() is fast.
                _voskStt = _voskStt || new mod.VoskSttStream();
                ctx.voicechat.stt = _voskStt;
                ctx.sttStatus = "Vosk: ready (on-device)";
                console.log("[main] STT backend: vosk — ready (on-device, offline; partials + final)");
            } catch (e) {
                // Load failed → stay on Gemini so STT keeps working (both surfaces).
                ctx.sttBackend = "gemini";
                ctx.voicechat.transcribe = _geminiTranscribe;
                ctx.voicechat.stt = _geminiStt();
                ctx.sttStatus = "Vosk: load failed → Gemini";
                console.warn("[main] Vosk STT load failed; staying on Gemini:", e?.message || e);
            }
        } else {
            ctx.sttBackend = "gemini";
            ctx.voicechat.transcribe = _geminiTranscribe;
            ctx.voicechat.stt = _geminiStt();              // restore the cloud streaming partials
            ctx.sttStatus = "Gemini: cloud";
            console.log("[main] STT backend: gemini — cloud");
        }
    };
    const _sttQuery = new URLSearchParams(location.search);
    const _sttParam = _sttQuery.get("stt");
    // ?livestt=1 is shorthand for ?stt=gemini-live (true streaming over the Live WS).
    const _wantLive = _sttParam === "gemini-live" || _sttQuery.get("livestt") === "1";
    if (_sttParam === "vosk") ctx.setSttBackend("vosk");          // lazy; don't block startup
    else if (_wantLive) ctx.setSttBackend("gemini-live");        // lazy; don't block startup
    else console.log("[main] STT backend:", ctx.sttBackend, "—", ctx.sttStatus);

    // Dialogue-BRAIN backend, switchable live — mirrors the STT/TTS switches:
    //   "gemini"   — cloud LLM (gemini.js GeminiBrain); DEFAULT. Open-ended chat.
    //   "scripted" — Tier-1 on-device FSM (companion-brain.js): an intent
    //                classifier (Model2Vec, ~30 MB, no LLM/network) maps spoken
    //                commands to companion STATES and replies with a short
    //                in-character ack. Lazy-loaded ONLY when selected (the matrix
    //                is never fetched on the default Gemini path). Selecting it
    //                swaps ctx.voicechat.brain to a CompanionBrain; selecting
    //                "gemini" restores the original Gemini brain we keep a handle
    //                to. ctx.brainBackend = current name. ?brain=scripted overrides.
    const _geminiBrain = ctx.voicechat.brain;   // the default brain VoiceChat built
    ctx.brainBackend = "gemini";
    let _scriptedBrain = null;                   // cached CompanionBrain handle
    ctx.setBrainBackend = async (name) => {
        if (name === "scripted") {
            try {
                const mod = await import("./companion-brain.js");
                if (!_scriptedBrain) {
                    _scriptedBrain = new mod.CompanionBrain({
                        // Live game state for ASK / query intents ("what's my
                        // score?", "how many arrows do I have?"). Reported, never
                        // a movement command. Engine-clean: the brain only sees
                        // this plain snapshot, never ctx/Babylon.
                        gameState: () => ({
                            score: ctx.target?.score ?? 0,
                            hits: ctx.target?.hits ?? 0,
                            arrows: ctx.arrows?.live?.length ?? 0,
                        }),
                    });
                    // Drive the NPC's commanded-movement layer off EVERY confident
                    // command (onCommand, not onStateChange — a re-issued "follow me"
                    // must re-assert FOLLOW even when already in it). The NPC boots on
                    // wander (command=null) until the first command arrives.
                    _scriptedBrain.onCommand(cmd => ctx.npcs?.npcs?.[0]?.brain?.setCommand(cmd.state));
                    // Voice the brain's Stage-B response from the prebaked clip bank
                    // (acks.js) — a movement-ack on a command, a small-talk line on a
                    // social intent. The clip index comes from the brain (which line
                    // it rotated to); graceful-silent until the clips are baked. This
                    // gives the text-only Tier-1 companion an audible reply.
                    _scriptedBrain.onCommand(cmd => ctx.acks?.playAck(cmd.state, cmd.ackIndex));
                    _scriptedBrain.onSocial(s => ctx.acks?.playSocial(s.intent, s.index));
                }
                ctx.voicechat.brain = _scriptedBrain;
                ctx.brainBackend = "scripted";
                // Scripted replies are terse, so no filled-pause masking.
                ctx.voicechat.brain.fillers = false;
                console.log("[main] brain backend: scripted — on-device FSM (no LLM)");
            } catch (e) {
                ctx.voicechat.brain = _geminiBrain;
                ctx.brainBackend = "gemini";
                console.warn("[main] scripted brain load failed; staying on Gemini:", e?.message || e);
            }
        } else {
            ctx.voicechat.brain = _geminiBrain;
            ctx.brainBackend = "gemini";
            // Leaving the scripted FSM: release the companion back to autonomous
            // wander (no voice commands drive it on the Gemini path).
            ctx.npcs?.npcs?.[0]?.brain?.setCommand(null);
            // Restore filled-pause masking for the Gemini path on the Gemini voice.
            if (_geminiBrain) _geminiBrain.fillers = (ctx.voiceBackend === "gemini");
            console.log("[main] brain backend: gemini — cloud LLM");
        }
    };
    const _brainParam = new URLSearchParams(location.search).get("brain");
    if (_brainParam === "scripted") ctx.setBrainBackend("scripted");   // lazy
    else console.log("[main] brain backend:", ctx.brainBackend, "— cloud LLM");

    // Voice TIER preset — composes the STT/brain/TTS switches into the three
    // product tiers (docs/voice-tiers.md). ctx.voiceTier = current tier; the
    // signboard panel reads/sets it. Tier 1 is the DEFAULT; ?tier=1|2|3 overrides,
    // and an explicit per-axis param (?stt/?tts/?brain/?livestt) opts out of the
    // preset and keeps that manual choice.
    ctx.voiceTier = null;
    ctx.setVoiceTier = async (tier) => {
        ctx.voiceTier = tier;
        if (tier === 1) {                 // all on-device · scripted FSM · text-only
            await ctx.setSttBackend("vosk");
            await ctx.setBrainBackend("scripted");
            await ctx.setVoiceBackend("none");
        } else if (tier === 2) {          // hybrid · cheap LLM · on-device Kokoro voice
            await ctx.setSttBackend("vosk");
            await ctx.setBrainBackend("gemini");
            await ctx.setVoiceBackend("wasm");
        } else {                          // tier 3: all-cloud · frontier LLM · premium voice
            await ctx.setSttBackend("gemini-live");
            await ctx.setBrainBackend("gemini");
            await ctx.setVoiceBackend("gemini");
        }
        console.log("[main] voice tier:", tier);
    };
    const _tierParam = parseInt(new URLSearchParams(location.search).get("tier"), 10);
    const _anyAxisOverride = !!(_ttsParam || _sttParam || _brainParam || _wantLive);
    if ([1, 2, 3].includes(_tierParam)) await ctx.setVoiceTier(_tierParam);
    else if (!_anyAxisOverride) await ctx.setVoiceTier(1);   // DEFAULT: Tier 1 (on-device, free)

    // Companion-tier switch panel (Tier 1 / 2 / 3), to the player's left-front.
    ctx.voicePanel = new VoicePanel(ctx, { position: new BABYLON.Vector3(-0.7, 1.15, 0.5) });

    // Gaze + proximity addressing — which companion/NPC the player is talking to
    // (replaces push-to-talk's "who"). The locked target routes speech + pans the
    // reply; a hands-free mic/VAD layer (Silero, next phase) will use it to decide
    // WHEN to listen. Marks the addressed NPC as "attending" so it orients/reacts.
    ctx.addressing = new Addressing(ctx);
    ctx.addressing.onTargetChange((npc) => {
        for (const n of (ctx.npcs?.npcs ?? [])) if (n.brain) n.brain.state = (n === npc) ? "attend" : (n.brain.state === "attend" ? "idle" : n.brain.state);
    });

    // DEBUG telemetry HUD — a billboarded panel above the companion NPC's head
    // showing its FSM state + a live trace of the voice/decision pipeline (heard →
    // intent → vad → turn → npc). UI-only adapter (npchud.js): READS ctx.voicechat
    // / .vad / .npcs each frame, null-guarding until they load. On by default for
    // in-headset tuning; ctx.npchud.toggle() hides it. Built here because it reads
    // ctx.npcs + ctx.voicechat + ctx.addressing, all of which exist by now.
    ctx.npchud = new NpcHud(ctx);

    // Hands-free voice loop (Phase 2–4): always-on mic + Silero VAD + turn
    // detection + streaming STT, gated by the gaze addressing target. The mic
    // listens continuously; VAD onset while ctx.addressing.target is held starts a
    // capture, the turn detector promotes a silence boundary to an end-of-turn
    // (gaze-leave / silence default + optional models), and barge-in over the
    // companion's TTS cuts it off and splices the truncated turn into history.
    // All three pieces are engine-clean (vad.js / turn.js / stt-stream.js); this
    // is just the wiring. VAD loads its ONNX model async (falls back to energy-RMS
    // if that fails), so attachHandsFree() runs once createVad() resolves. In
    // push-to-talk mode (VOICE_TUNING.pushToTalk) attachHandsFree is a no-op and
    // the legacy A-button / V-key path stays live.
    //   • turn-end uses gaze-leave (from ctx.addressing) + the silence default +
    //     the built-in heuristic text EoU, PLUS Smart Turn v3 (acoustic EoU) once it
    //     loads: a confident P(complete) drives the decision (end if ≥0.5, keep-veto
    //     if <0.35). TurnSense (text EoU) stays OFF until dialed in on-device.
    //   • streaming STT re-transcribes the growing buffer on a cadence so the
    //     partial transcript feeds the turn detector and the panel live.
    ctx.turn = new TurnDetector();          // gaze-leave + silence + heuristic text; Smart Turn injected once it loads
    // Smart Turn v3 (audio EoU) loads its ORT wasm + ~8.68 MB model + the vendored
    // mel matrix asynchronously IN THE VOICE WORKER — build it, and on resolve inject
    // the (worker-backed) scorer into ctx.turn via setAudioScorer(). On any failure
    // loadWorkerAudioScorer falls back to the main-thread scorer (and that throws if
    // it too can't load); we log and leave the heuristic-only turn path unchanged.
    loadWorkerAudioScorer()
        .then((audioEouScore) => {
            ctx.turn.setAudioScorer(audioEouScore);
            console.log("[main] Smart Turn v3 audio EoU armed (worker)");
        })
        .catch((e) => console.warn("[main] Smart Turn unavailable; turn-end uses gaze+silence+heuristic:", e?.message || e));
    // TurnSense (text EoU) — the text complement to Smart Turn's acoustics. OFF by
    // default: the int8 ONNX is ~176 MB (20× Smart Turn's 8.7 MB) and Smart Turn already
    // covers EoU, so this is opt-in. Enable with ?turnsense=1 (or window.VR_USE_TURNSENSE
    // = true before main runs) to load + inject it, mirroring Smart Turn's setAudioScorer
    // wiring. On any load failure we log and leave the audio+heuristic+silence path intact.
    const _useTurnSense = (typeof window !== "undefined") &&
        (window.VR_USE_TURNSENSE === true ||
         (typeof location !== "undefined" && /[?&]turnsense=1\b/.test(location.search)));
    if (_useTurnSense) {
        loadWorkerTextScorer()
            .then((textEouScore) => {
                ctx.turn.setTextScorer(textEouScore);
                console.log("[main] TurnSense text EoU armed (worker, int8 ~176 MB)");
            })
            .catch((e) => console.warn("[main] TurnSense unavailable; turn-end uses audio+gaze+silence+heuristic:", e?.message || e));
    }
    ctx.stt = new SttStream();              // streaming-feel transcription over the warm mic
    createVadProxy({
        // TEN-VAD is the default: it recognizes the real (quiet) browser mic where
        // Silero v5 scored near-silence on the same audio (eval: TEN-VAD max 0.98 /
        // mean 0.60 vs Silero max ~0.12) and it's gain-robust (no normalization).
        // The VAD model now runs in the voice worker (off the render thread); if its
        // wasm fails to load there, the worker's createVad falls back to energy-RMS,
        // and if the WORKER itself fails, createVadProxy falls back to a main-thread
        // VAD — so the loop always has one. backend:"silero" is still available for
        // clean audio / the native port; backend:"rms" forces the loudness-only gate.
        backend: "tenvad",
        // Gaze-leave (turn.js) reads ctx.addressing; VAD only needs the raw mic.
    }).then((vad) => {
        ctx.vad = vad;
        ctx.voicechat.attachHandsFree({ vad, turn: ctx.turn, stt: ctx.stt });
        // attachHandsFree just set ctx.voicechat.stt to the cloud stream (ctx.stt).
        // If a non-default STT backend was selected before the mic came up (e.g.
        // ?stt=vosk or ?livestt=1), re-apply it so attachHandsFree's reset to the
        // cloud re-transcription stream doesn't clobber it. setSttBackend is
        // idempotent and any model load is cached.
        if (ctx.sttBackend === "vosk") ctx.setSttBackend("vosk");
        else if (ctx.sttBackend === "gemini-live") ctx.setSttBackend("gemini-live");
        console.log("[main] hands-free voice armed — VAD backend:", vad.backend);
    }).catch((e) => {
        // createVad() never throws (graceful fallback), but guard anyway so a
        // wiring slip can't break the rest of the scene.
        console.warn("[main] hands-free voice unavailable; push-to-talk still works:", e?.message || e);
    });

    // Combat barks — short reactive companion callouts ("Nice shot!", "Behind
    // you!") fired by game events and panned toward the addressed companion.
    // Needs ctx.addressing (pan target) so it's built here. Most combat events
    // (wave_start, enemy_behind, player_hit, …) have no trigger yet — a future
    // wave/enemy system calls ctx.barks.fire("wave_start") etc. The only event
    // wired today is player_hit_target: we wrap the target's onArrowHit seam so
    // every scoring arrow earns a "Nice shot!" (subject to the bark cooldowns).
    ctx.barks = new Barks(ctx);
    // Prebaked companion-VOICE clips (acks.js): Stage-A receipt tokens at
    // turn-complete + Stage-B response clips (movement-ack / small-talk) driven by
    // the scripted brain's onCommand/onSocial (wired above). Gives the text-only
    // Tier-1 companion an audible reply; graceful-silent until assets/acks/*.wav
    // are baked. voicechat fires the receipt token (ctx.acks.playReceipt()).
    ctx.acks = new Acks(ctx);
    const _onArrowHit = ctx.target?.face?.metadata?.onArrowHit;
    if (_onArrowHit) {
        ctx.target.face.metadata.onArrowHit = (info) => {
            _onArrowHit(info);                  // original scoring/SFX
            ctx.barks.fire("player_hit_target"); // companion praise (cooldown-gated)
        };
    }

    // Haptic diagnostic. Per controller the HUD shows its handedness label and
    // which actuators exist (vib/legacy). Squeeze a controller's TRIGGER to
    // pulse THAT SAME controller's own actuator directly (bypassing the
    // handedness lookup); the TEST line logs the handedness/index/kind that
    // fired. So: squeeze the right trigger — does the right controller buzz,
    // and what does it say? Pins down "B pulses left / A does nothing".
    const _trigPrev = new WeakMap();
    ctx.updatables.push(() => {
        if (ctx.xr.baseExperience?.state !== 2) return;
        ctx.xr.input.controllers.forEach((c, i) => {
            const gp = c.inputSource?.gamepad;
            const h = c.inputSource?.handedness ?? "?";
            const vib = gp?.vibrationActuator, leg = gp?.hapticActuators?.[0];
            ctx.debug.set(`ctlr${i}`, `hand=${h} vib=${vib ? "Y" : "N"} leg=${leg ? "Y" : "N"}`);
            const trig = !!gp?.buttons?.[0]?.pressed;
            if (trig && !_trigPrev.get(c)) {
                const act = vib || leg;
                const kind = vib ? "vib" : leg ? "legacy" : "NONE";
                if (act?.playEffect) act.playEffect("dual-rumble", { duration: 200, strongMagnitude: 1, weakMagnitude: 0.8 });
                else if (act?.pulse) act.pulse(1, 200);
                ctx.debug.set("haptic TEST", `trigger@${h} idx${i} -> self-pulse (${kind})`);
            }
            _trigPrev.set(c, trig);
        });
    });
}

// ?demo=<name> preloads debug/demos/<name>.js; &autorun=1 fires it on XR
// entry so a scripted session needs only the one "enter XR" click.
const params = new URLSearchParams(location.search);
const demoName = params.get("demo");
if (demoName) {
    // Cache-bust: dynamic imports survive even hard reloads, so an edited
    // demo would otherwise run stale (cost a test cycle to spot).
    const mod = await import(`../debug/demos/${demoName}.js?v=${Date.now()}`);
    window.runDemo = () => mod.run(window.rig, ctx);
    if (params.get("autorun") === "1") {
        ctx.xr.baseExperience.onStateChangedObservable.add((state) => {
            // 2 = IN_XR (the emulator settles on 2; it also fires a spurious
            // 0 during entry — see BabylonHands lessons_learned.md)
            // Calibrate the rig mapping first (idempotent; see rigctl) so
            // demo poses land where they're aimed regardless of entry path.
            if (state === 2) setTimeout(async () => {
                await window.rig.calibrate?.();
                window.runDemo();
            }, 500);
        });
    }
    console.log(`[rigdemo] loaded demo "${demoName}" — call runDemo()`);
}

// ?cam=x,y,z,tx,ty,tz parks the flat (pre-XR) camera — used by headless
// screenshot verification (tools, CI) to frame a specific view.
const camParam = params.get("cam");
if (camParam) {
    const [x, y, z, tx, ty, tz] = camParam.split(",").map(Number);
    ctx.camera.position.set(x, y, z);
    ctx.camera.setTarget(new BABYLON.Vector3(tx, ty, tz));
}

ctx.locomotion = new Locomotion(ctx);
applyLightmaps(ctx); // async; scene renders unlit-by-bake until PNGs land

engine.runRenderLoop(() => {
    prof.frame();   // measure the inter-frame period; flag + report <20fps hitches
    const dt = engine.getDeltaTime() / 1000;
    ctx.hands.update(dt);
    ctx.locomotion.update(dt);
    ctx.physicsHands.update(dt);
    ctx.interaction.update(dt);
    ctx.arrows?.update(dt);
    ctx.bow?.update(dt);
    for (const u of ctx.updatables) u(dt); // props: buttons, drives, door, labels…
    ctx.debug.update(dt);
    ctx.scene.render();
    // End-of-frame velocity sampling: must see the final post-render
    // transforms (the visual hand rides nodes other systems move mid-tick).
    ctx.hands.recordFrame(dt);
});

window.addEventListener("resize", () => engine.resize());
window.ctx = ctx;
