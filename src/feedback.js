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

const US_FULL_SCALE = 1500; // µs pulse that maps to amplitude 1.0 (rifle fire)
const MIN_HAPTIC_MS = 30;   // sub-~30ms pulses are imperceptible on Quest

// CC0/recorded samples that override the procedural recipe of the same name.
// Decoded lazily once the AudioContext exists; until then sound() falls back
// to the procedural recipe.
const SAMPLES = {
    whoosh: "assets/sounds/arrow_whoosh.wav",       // arrow release
    impact: "assets/sounds/arrow_hit_wood.wav",     // any impact
    impactTarget: "assets/sounds/arrow_hit_wood.wav",
};

export class Feedback {
    constructor(ctx) {
        this.ctx = ctx;
        this._audio = null;
        this._lastTick = {}; // rate limiting per key
        this._counts = { left: 0, right: 0 }; // calls per hand (HUD diagnostics)
        this._samples = {};      // name -> decoded AudioBuffer
        this._samplesStarted = false;
    }

    // Decode the sample files once (needs the AudioContext). sound() plays a
    // sample as soon as its buffer is ready; earlier calls use the recipe.
    _ensureSamples() {
        if (this._samplesStarted) return;
        this._samplesStarted = true;
        const a = this.audio;
        for (const [name, url] of Object.entries(SAMPLES)) {
            fetch(url)
                .then(r => r.arrayBuffer())
                .then(buf => a.decodeAudioData(buf))
                .then(decoded => { this._samples[name] = decoded; })
                .catch(() => {}); // missing/undecodable -> stay on the recipe
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
    detent(hand, amplitude = 0.3, key = "detent", minInterval = 0.02) {
        const now = performance.now() / 1000;
        const k = `${hand}:${key}`;
        if (now - (this._lastTick[k] ?? 0) < minInterval) return;
        this._lastTick[k] = now;
        this.haptic(hand, amplitude, 0.005);
        this.sound("tick", { pitch: 0.8 + amplitude * 0.6, volume: 0.15 + amplitude * 0.3 });
    }

    get audio() {
        if (!this._audio) this._audio = new (window.AudioContext || window.webkitAudioContext)();
        return this._audio;
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
    sound(name, { volume = 0.5, pitch = 1 } = {}) {
        try {
            const a = this.audio;
            if (a.state === "suspended") a.resume();
            this._ensureSamples();

            // Recorded sample overrides the recipe once decoded.
            const sample = this._samples[name];
            if (sample) {
                const src = a.createBufferSource();
                src.buffer = sample;
                src.playbackRate.value = pitch;
                const g = a.createGain();
                g.gain.value = Math.min(1, volume);
                src.connect(g); g.connect(a.destination);
                src.start();
                return;
            }

            const t0 = a.currentTime;
            const gain = a.createGain();
            gain.connect(a.destination);

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
