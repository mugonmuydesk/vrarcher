// SpatialAudio — the shared 3D-audio ENGINE for the whole game: NPC speech AND
// every sound effect emit from their world position, heard relative to the
// player's head. One listener, one handedness convention, one HRTF panner
// factory — so "positional sound" means the same thing everywhere and the Unity
// port is a transcription.
//
// WHO USES IT
//   • feedback.js  — one-shot SFX: sound(name, { at }) routes through outputFor(at).
//   • voice-audio.js (SpatialVoice) — the NPC voice's persistent emitter.
//   • a single per-frame updater (main.js) calls setListener() with the head pose.
//
// WHY ONE ENGINE: the Web Audio AudioContext has exactly ONE AudioListener; if two
// subsystems wrote it independently they'd fight. Centralising it here means the
// head pose is written once per frame and every emitter (voice + SFX) is placed
// against the same listener with the same handedness fix.
//
// ENGINE-CLEAN: imports nothing engine-specific; consumes plain {x,y,z} vectors,
// so it never sees Babylon. The Babylon callers read transforms and hand numbers
// in; the Unity port reads Transform.position. That is what makes the swap cheap.
//
// PORT / handedness (LOAD-BEARING): Web Audio's panner/listener use a RIGHT-handed,
// −Z-forward frame; Babylon is LEFT-handed, +Z-forward. We MIRROR Z (flipZ) on
// every incoming position and direction to land in Web Audio's frame, so
// left/right and front/back come out correct. Unity consumes engine-native
// transforms, so its port sets flipZ=false. A sign error here doesn't crash — it
// silently swaps L/R — so it MUST be confirmed by ear in-headset (it cannot be
// verified in the emulator). See docs/spatial-audio.md.

// Tuning — the port's re-tuning checklist (Phase-8 in-headset pass). Per-category
// distance presets: the companion VOICE wants gentle falloff (stay audible at
// conversational range) + an optional cone; SFX want a more natural falloff so a
// far target's hit reads as distant. Starting points; expect to re-tune.
export const SPATIAL_AUDIO_TUNING = {
    hrtf: true,             // PannerNode "HRTF" binaural ↔ Meta XR Audio spatializer (Unity).
    flipZ: true,            // mirror Z: Babylon (LH,+Z fwd) → Web Audio (RH,−Z fwd). See header.
    stereoFallback: true,   // if HRTF/PannerNode is unavailable, approximate with L/R balance.
    voice: {
        distanceModel: "inverse",
        refDistance: 3.0,   // m — full volume within this radius (companion sits ~2 m away).
        maxDistance: 20.0,  // m — attenuation floor distance.
        rolloff: 0.5,       // gentle, so Wren stays audible across the range.
        coneInnerDeg: 90,   // voice cone (only applied when an emitter forward is given).
        coneOuterDeg: 240,
        coneOuterGain: 0.5, // gain behind the NPC (never 0 — still heard from behind).
    },
    sfx: {
        distanceModel: "inverse",
        refDistance: 2.0,   // m — full volume within this radius.
        maxDistance: 30.0,  // m — covers an archery range (far target ≈ 10–18 m).
        rolloff: 0.9,       // more natural than the voice falloff; a far hit reads distant.
    },
};

// One spatial-audio engine over a shared Web Audio context. Owns the single
// AudioListener and builds positioned PannerNodes for voice + SFX.
export class SpatialAudio {
    constructor(audioCtx) {
        this._a = audioCtx;
        this._listener = null;      // last listener written (for the stereo fallback)
    }

    get ctx() { return this._a; }
    get listener() { return this._listener; }

    // True 3D available (HRTF PannerNode). Else callers use the stereo fallback.
    get hrtf() { return SPATIAL_AUDIO_TUNING.hrtf && typeof this._a.createPanner === "function"; }

    // Write the single AudioListener from the player's head. Call ONCE per frame.
    // `L = { position, forward, up, right }` plain {x,y,z} in the caller's world
    // frame; `right` is retained only for the stereo fallback. No-op if absent.
    setListener(L) {
        this._listener = L || null;
        if (!L || !L.position) return;
        const Lr = this._a.listener;
        const pz = this._z(L.position.z);
        if (Lr.positionX) {                          // modern AudioParam form
            Lr.positionX.value = L.position.x; Lr.positionY.value = L.position.y; Lr.positionZ.value = pz;
            if (L.forward && L.up) {
                Lr.forwardX.value = L.forward.x; Lr.forwardY.value = L.forward.y; Lr.forwardZ.value = this._z(L.forward.z);
                Lr.upX.value = L.up.x; Lr.upY.value = L.up.y; Lr.upZ.value = this._z(L.up.z);
            }
        } else {                                     // legacy setters
            Lr.setPosition && Lr.setPosition(L.position.x, L.position.y, pz);
            if (L.forward && L.up && Lr.setOrientation) {
                Lr.setOrientation(L.forward.x, L.forward.y, this._z(L.forward.z), L.up.x, L.up.y, this._z(L.up.z));
            }
        }
    }

    // The node a sound source should connect INTO so it emits from `position`.
    //   • HRTF available → a fresh PannerNode placed at `position` (→ destination).
    //   • else stereo fallback → a StereoPanner set to the L/R balance (→ destination).
    //   • else, or position null → destination (centred / head-relative).
    // `category` selects the distance preset ("voice" | "sfx"); `forward` (optional)
    // enables the directional cone.
    outputFor(position, { category = "sfx", forward = null } = {}) {
        if (!position) return this._a.destination;
        if (this.hrtf) return this.panner(position, { category, forward });
        if (SPATIAL_AUDIO_TUNING.stereoFallback && typeof this._a.createStereoPanner === "function") {
            const sp = this._a.createStereoPanner();
            sp.pan.value = this.stereoPan(position);
            sp.connect(this._a.destination);
            return sp;
        }
        return this._a.destination;
    }

    // Build a PannerNode at `position` with the category's distance tuning, wired
    // to destination. Returns the node to connect a source into. (Voice reuses one
    // persistent panner and repositions it via place(); SFX make a fresh one each
    // shot — both are cheap one-shots that GC after the sound ends.)
    panner(position, { category = "sfx", forward = null } = {}) {
        const t = SPATIAL_AUDIO_TUNING[category] || SPATIAL_AUDIO_TUNING.sfx;
        const p = this._a.createPanner();
        p.panningModel = "HRTF";
        p.distanceModel = t.distanceModel;
        p.refDistance = t.refDistance;
        p.maxDistance = t.maxDistance;
        p.rolloffFactor = t.rolloff;
        this.place(p, position, forward, t);
        p.connect(this._a.destination);
        return p;
    }

    // Reposition an existing panner (a moving emitter, e.g. the NPC voice). `tuning`
    // supplies the cone angles when `forward` is given; without a forward the panner
    // is omnidirectional. No-op on a non-panner (passthrough/stereo) node.
    place(panner, position, forward = null, tuning = null) {
        if (!panner || !position || typeof panner.refDistance !== "number") return;
        const pz = this._z(position.z);
        if (panner.positionX) { panner.positionX.value = position.x; panner.positionY.value = position.y; panner.positionZ.value = pz; }
        else if (panner.setPosition) panner.setPosition(position.x, position.y, pz);
        const t = tuning || {};
        if (forward && t.coneInnerDeg != null) {
            panner.coneInnerAngle = t.coneInnerDeg;
            panner.coneOuterAngle = t.coneOuterDeg;
            panner.coneOuterGain = t.coneOuterGain;
            const oz = this._z(forward.z);
            if (panner.orientationX) { panner.orientationX.value = forward.x; panner.orientationY.value = forward.y; panner.orientationZ.value = oz; }
            else if (panner.setOrientation) panner.setOrientation(forward.x, forward.y, oz);
        } else {
            panner.coneInnerAngle = 360;     // omnidirectional
            panner.coneOuterAngle = 360;
        }
    }

    // Stereo fallback: project the emitter direction onto the listener's RIGHT axis
    // → a −1..1 L/R balance. Uses the stored listener.right so it matches the
    // engine's exact right axis (avoids a cross-product handedness mistake).
    stereoPan(position) {
        const L = this._listener;
        if (!L || !L.right || !position) return 0;
        const dx = position.x - L.position.x;
        const dz = position.z - L.position.z;
        const len = Math.hypot(dx, dz) || 1;
        return Math.max(-1, Math.min(1, (dx * L.right.x + dz * L.right.z) / len));
    }

    // One-shot convenience: play a decoded AudioBuffer at `position` through the
    // spatial chain. gain/pitch mirror feedback.sound(). Returns the source node
    // (stoppable). Used by the sample/clip path.
    playBufferAt(buffer, position, { gain = 1, pitch = 1, category = "sfx" } = {}) {
        const a = this._a;
        const src = a.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = pitch;
        const g = a.createGain();
        g.gain.value = Math.min(1, gain);
        src.connect(g);
        g.connect(this.outputFor(position, { category }));
        src.start();
        return src;
    }

    // Mirror Z (and only Z) when flipZ is set: LH (Babylon) → RH (Web Audio).
    _z(v) { return SPATIAL_AUDIO_TUNING.flipZ ? -v : v; }
}
