// Haptics + audio abstraction.
//
// Haptics route to WebXR gamepad.hapticActuators when present; under the
// emulator there are none, so every pulse also drives the HUD indicator
// (debug.pulse) — that's the only way to "see" haptics in scripted tests.
//
// House rule: every analog interaction gets detent ticks.
//
// Audio: procedural WebAudio one-shots for now (no assets needed); Phase 7
// swaps in CC0 samples through the same sound() entry point. The
// AudioContext unlocks on the XR-entry user gesture.
//
// POSITIONAL: every sound() can emit from a world position — pass `at` (a {x,y,z},
// a Babylon Vector3, or a mesh/node). When given, the sound routes through the
// shared SpatialAudio engine (spatial-audio.js: HRTF panner at `at`, listener at
// the head) exactly like the NPC voice; without `at` it plays centred/head-relative
// as before. The single AudioListener is written once per frame by main.js. This
// is the same positional approach used for speech — see docs/spatial-audio.md.

import { SpatialAudio } from "./spatial-audio.js";

const US_FULL_SCALE = 1500; // µs pulse that maps to amplitude 1.0 (rifle fire)
const MIN_HAPTIC_MS = 30;   // sub-~30ms pulses are imperceptible on Quest

// CC0/recorded samples that override the procedural recipe of the same name.
// Decoded lazily once the AudioContext exists; until then sound() falls back
// to the procedural recipe. A value may be a single URL, or an ARRAY of URLs
// (a "bank") — sound() then plays a random clip from the bank, avoiding the
// one it played last so repeats don't stand out (creaks, draw-releases).
const SND = "assets/sounds/";

// Object-impact matrix: striker material+size struck onto a surface material.
// One file per combination (drop_<mat>_<size>_on_<surface>.wav). The striker's
// material vocab is {wood,metal,rock,sand}; the surface vocab is
// {wood,rock,soil,metal} — a sand striker maps to a soil SURFACE (see
// throwable.js toSurface()).
const DROP_MATERIALS = ["wood", "metal", "rock", "sand"];
const DROP_SIZES = ["small", "medium", "big"];
const DROP_SURFACES = ["wood", "rock", "soil", "metal"];

function buildSamples() {
    const s = {
        // --- archery ---
        nock: SND + "nooked.wav",
        nockReady: SND + "nock_ready.wav",
        whoosh: SND + "arrow_whoosh.wav",
        arrowDraw: SND + "arrow_draw_from_quiver.wav",
        strain: SND + "strain.wav",                       // full-draw hold
        drawrelease: [                                    // the loose (bank)
            SND + "drawrelease.wav",
            SND + "drawrelease2.wav",
            SND + "drawrelease3.wav",
        ],
        // --- arrow surface impacts (chosen by struck material in arrow.js) ---
        arrow_hit_wood: SND + "arrow_hit_wood.wav",
        arrow_hit_ground: SND + "arrow_hit_ground.wav",
        arrow_hit_rock: SND + "arrow_hit_rock.wav",
        arrow_hit_metal: SND + "arrow_hit_metal.wav",
        arrow_hit_target: [SND + "target_thud1.wav", SND + "target_thud2.wav"],
        // Legacy recipe names kept as generic fallbacks.
        impact: SND + "arrow_hit_wood.wav",
        impactTarget: SND + "arrow_hit_target.wav",
        // --- UI / interaction ---
        click: SND + "ui_click.wav",
        tick: SND + "ui_tick.wav",
        hover: SND + "ui_hover.wav",
        grab: SND + "item_grab.wav",
        release: SND + "item_release.wav",
        score: SND + "score_ding.wav",
        // --- door ---
        doorSlam: SND + "door_slam.wav",
        doorCreak: SND + "door_creak.wav",
    };
    // Bow-limb creaks: a 16-clip bank cycled while the string is drawn.
    s.creak = [];
    for (let i = 1; i <= 16; i++) s.creak.push(SND + "creak_" + String(i).padStart(2, "0") + ".wav");
    // Object-impact matrix (48 clips, looked up by computed name).
    for (const m of DROP_MATERIALS)
        for (const z of DROP_SIZES)
            for (const f of DROP_SURFACES)
                s[`drop_${m}_${z}_on_${f}`] = `${SND}drop_${m}_${z}_on_${f}.wav`;
    return s;
}
const SAMPLES = buildSamples();

export class Feedback {
    constructor(ctx) {
        this.ctx = ctx;
        this._audio = null;
        this._lastTick = {}; // rate limiting per key
        this._counts = { left: 0, right: 0 }; // calls per hand (HUD diagnostics)
        this._samples = {};      // name -> decoded AudioBuffer (or array, for banks)
        this._lastBank = {};     // bank name -> last buffer played (avoid repeats)
        this._samplesStarted = false;
    }

    // Decode the sample files once (needs the AudioContext). sound() plays a
    // sample as soon as its buffer is ready; earlier calls use the recipe.
    _ensureSamples() {
        if (this._samplesStarted) return;
        this._samplesStarted = true;
        const a = this.audio;
        const load = (url) => fetch(url).then(r => r.arrayBuffer()).then(buf => a.decodeAudioData(buf));
        for (const [name, val] of Object.entries(SAMPLES)) {
            if (Array.isArray(val)) {
                // Bank: decode each clip into a slot; sound() picks among the
                // ones that have arrived (the array fills in as they load).
                this._samples[name] = [];
                val.forEach((url, i) => load(url)
                    .then(decoded => { this._samples[name][i] = decoded; })
                    .catch(() => {}));
            } else {
                load(val)
                    .then(decoded => { this._samples[name] = decoded; })
                    .catch(() => {}); // missing/undecodable -> stay on the recipe
            }
        }
    }

    // Both actuators for a hand. Quest exposes both a modern vibrationActuator
    // (playEffect) and the legacy hapticActuators[].pulse — and which one
    // actually drives the motor for WebXR controllers varies by browser build,
    // so we fire BOTH (see haptic()).
    _actuator(hand) {
        for (const c of this.ctx.xr.input.controllers) {
            if (c.inputSource?.handedness !== hand) continue;
            const gp = c.inputSource?.gamepad;
            return { vib: gp?.vibrationActuator ?? null, leg: gp?.hapticActuators?.[0] ?? null };
        }
        return { vib: null, leg: null };
    }

    // amplitude 0–1, duration seconds.
    // KNOWN PLATFORM BUG (not ours): Quest Browser OS v2.1.x misroutes WebXR
    // haptics — signalling the RIGHT controller buzzes the LEFT, and signalling
    // the LEFT does nothing. Confirmed by our diagnostic (handedness labels and
    // actuator lookup are correct) and by Meta's own investigation
    // (developers.meta.com/horizon/feedback/vr/investigations/1691711595330760).
    // Meta shipped a fix then regressed it with a UI update. Wolvic is fine.
    // Over a Link cable, pulse() is a silent no-op (runtime doesn't expose it).
    // Nothing to fix in code — fire both APIs and let the runtime do its thing.
    haptic(hand, amplitude, duration = 0.02) {
        amplitude = Math.min(1, Math.max(0, amplitude));
        this.ctx.debug.pulse(hand, amplitude);
        const { vib, leg } = this._actuator(hand);
        this._counts[hand] = (this._counts[hand] ?? 0) + 1;
        const kind = vib && leg ? "both" : vib ? "vib" : leg ? "legacy" : "NONE";
        this.ctx.debug.set(`haptic ${hand}`, `#${this._counts[hand]} ${kind}`);
        if (!vib && !leg) return;
        const ms = Math.max(duration * 1000, MIN_HAPTIC_MS);
        // Fire BOTH paths; whichever the runtime honours vibrates the motor.
        if (leg && typeof leg.pulse === "function") leg.pulse(amplitude, ms);
        if (vib && typeof vib.playEffect === "function") {
            vib.playEffect("dual-rumble", {
                startDelay: 0, duration: ms,
                strongMagnitude: amplitude, weakMagnitude: amplitude * 0.7,
            });
        }
    }

    // Valve-style microsecond pulse lengths (e.g. 1500/800/500 µs) — map
    // duration-as-intensity onto amplitude.
    hapticUs(hand, microseconds) {
        this.haptic(hand, microseconds / US_FULL_SCALE, 0.015);
    }

    // Short detent tick, rate-limited per key so analog scrubbing can call
    // it every frame change without saturating.
    detent(hand, amplitude = 0.3, key = "detent", minInterval = 0.02, at = null) {
        const now = performance.now() / 1000;
        const k = `${hand}:${key}`;
        if (now - (this._lastTick[k] ?? 0) < minInterval) return;
        this._lastTick[k] = now;
        this.haptic(hand, amplitude, 0.005);
        this.sound("tick", { pitch: 0.8 + amplitude * 0.6, volume: 0.15 + amplitude * 0.3, at });
    }

    get audio() {
        if (!this._audio) this._audio = new (window.AudioContext || window.webkitAudioContext)();
        return this._audio;
    }

    // True once the AudioContext exists — lets the per-frame listener updater skip
    // creating the context before any sound has played (avoids a premature, gestured
    // autoplay-policy warning).
    get hasAudio() { return !!this._audio; }

    // The shared 3D-audio engine (one AudioListener, HRTF panner factory, handedness)
    // over the same AudioContext used for every sound. Lazily built; the NPC voice
    // (voice-audio.js) wraps this same instance.
    get spatial() {
        if (!this._spatial) this._spatial = new SpatialAudio(this.audio);
        return this._spatial;
    }

    // Resolve a sound's `at` into a plain {x,y,z}, accepting a Babylon mesh/node
    // (getAbsolutePosition), a Vector3-like ({position} or bare {x,y,z}), or null.
    _resolvePos(at) {
        if (!at) return null;
        if (typeof at.getAbsolutePosition === "function") { const p = at.getAbsolutePosition(); return { x: p.x, y: p.y, z: p.z }; }
        if (at.position && typeof at.position.x === "number") return { x: at.position.x, y: at.position.y, z: at.position.z };
        if (typeof at.x === "number") return { x: at.x, y: at.y, z: at.z };
        return null;
    }

    // Shared 1 s white-noise buffer for the noise-based recipes.
    _noise() {
        if (!this._noiseBuf) {
            const a = this.audio;
            const buf = a.createBuffer(1, a.sampleRate, a.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            this._noiseBuf = buf;
        }
        return this._noiseBuf;
    }

    // One-shot sounds. Procedural recipes keyed by name; options
    // { volume 0–1, pitch multiplier }. CC0 samples can replace any recipe
    // later through this same entry point.
    sound(name, { volume = 0.5, pitch = 1, at = null, category = "sfx" } = {}) {
        try {
            const a = this.audio;
            if (a.state === "suspended") a.resume();
            this._ensureSamples();

            // Where the sound emits from: a positioned spatial node (HRTF panner at
            // `at`, listener at the head) when `at` is given, else destination
            // (centred). Same path for samples/clips and procedural recipes.
            const pos = this._resolvePos(at);
            const out = pos ? this.spatial.outputFor(pos, { category }) : a.destination;

            // Recorded sample overrides the recipe once decoded. A bank (array)
            // resolves to a random loaded clip, avoiding the last one played.
            let sample = this._samples[name];
            if (Array.isArray(sample)) {
                const loaded = sample.filter(Boolean);
                if (loaded.length) {
                    let pick = loaded[Math.floor(Math.random() * loaded.length)];
                    if (loaded.length > 1 && pick === this._lastBank[name]) {
                        pick = loaded[(loaded.indexOf(pick) + 1) % loaded.length];
                    }
                    this._lastBank[name] = pick;
                    sample = pick;
                } else {
                    sample = null; // none decoded yet -> fall through to recipe
                }
            }
            if (sample) {
                const src = a.createBufferSource();
                src.buffer = sample;
                src.playbackRate.value = pitch;
                const g = a.createGain();
                g.gain.value = Math.min(1, volume);
                src.connect(g); g.connect(out);
                src.start();
                return;
            }

            const t0 = a.currentTime;
            const gain = a.createGain();
            gain.connect(out);

            const recipes = {
                tick: { type: "square", freq: 1800, decay: 0.015 },
                click: { type: "square", freq: 900, decay: 0.03 },
                hover: { type: "sine", freq: 600, decay: 0.05 },
                grab: { type: "triangle", freq: 300, decay: 0.08 },
                release: { type: "triangle", freq: 220, decay: 0.1 },
                nockReady: { type: "sine", freq: 880, decay: 0.12 },
                nock: { type: "square", freq: 440, decay: 0.06 },
                fire: { type: "sawtooth", freq: 160, decay: 0.25 },
                score: { type: "sine", freq: 660, decay: 0.3 },
                // Noise recipes: white noise through a swept biquad filter.
                whoosh: { noise: true, filter: "bandpass", freq: 900, freqEnd: 250, q: 1.5, decay: 0.3 },
                impact: { noise: true, filter: "lowpass", freq: 320, decay: 0.12 },
                impactTarget: { noise: true, filter: "lowpass", freq: 160, decay: 0.25 },
            };
            const r = recipes[name] ?? recipes.click;
            gain.gain.setValueAtTime(volume * 0.4, t0);
            gain.gain.exponentialRampToValueAtTime(0.001, t0 + r.decay);

            let src;
            if (r.noise) {
                src = a.createBufferSource();
                src.buffer = this._noise();
                const filt = a.createBiquadFilter();
                filt.type = r.filter;
                filt.frequency.setValueAtTime(r.freq * pitch, t0);
                if (r.freqEnd) {
                    filt.frequency.exponentialRampToValueAtTime(r.freqEnd * pitch, t0 + r.decay);
                }
                filt.Q.value = r.q ?? 1;
                src.connect(filt);
                filt.connect(gain);
            } else {
                src = a.createOscillator();
                src.type = r.type;
                src.frequency.value = r.freq * pitch;
                src.connect(gain);
            }
            src.start(t0);
            src.stop(t0 + r.decay + 0.02);
        } catch (_e) {
            // Audio is best-effort; never let it break interaction logic.
        }
    }
}
