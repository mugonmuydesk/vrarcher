// SpatialVoice — the NPC voice's persistent emitter, a thin wrapper over the
// shared SpatialAudio engine (spatial-audio.js). The voice differs from a one-shot
// SFX in only one way: it streams MANY buffers per utterance through ONE emitter
// that tracks the NPC as it moves, so it keeps a single persistent PannerNode and
// repositions it, rather than making a fresh panner per sound. Everything else —
// the listener, the HRTF/handedness/flipZ convention, the distance tuning — lives
// in SpatialAudio, so voice and SFX are genuinely "the same positional approach".
//
// INTERFACE (unchanged; voicechat.js drives this):
//   attachTo(emitter)  bind to a source — { position:{x,y,z}, forward?:{x,y,z} },
//                      read LIVE each update() so a moving NPC tracks for free.
//   update()           reposition the emitter against the (centrally-written)
//                      listener. The listener itself is written once per frame by
//                      the shared engine, NOT here.
//   get output         the node speech sources connect INTO (persistent).
//   playClip(buf,{onended})  one-shot through the spatial chain (fillers).
//   stop()             stop clips this voice owns.
//
// PORT: maps onto a Unity AudioSource on the NPC GameObject (spatialBlend=1, the
// "voice" distance preset). See docs/spatial-audio.md.

import { SPATIAL_AUDIO_TUNING } from "./spatial-audio.js";

export class SpatialVoice {
    // `spatial` is the shared SpatialAudio engine (ctx.feedback.spatial).
    constructor(spatial) {
        this._sp = spatial;
        this._emitter = null;       // { position, forward? } — the NPC
        this._clips = [];           // one-shot sources started here (stoppable)
        const a = spatial.ctx;
        if (spatial.hrtf) {
            // One persistent voice panner, repositioned each update().
            this._panner = spatial.panner({ x: 0, y: 0, z: 0 }, { category: "voice" });
            this._out = this._panner;
            this._mode = "hrtf";
        } else if (typeof a.createStereoPanner === "function") {
            this._stereo = a.createStereoPanner();
            this._stereo.connect(a.destination);
            this._out = this._stereo;
            this._mode = "stereo";
        } else {
            this._out = a.createGain();
            this._out.connect(a.destination);
            this._mode = "passthrough";
        }
    }

    get output() { return this._out; }
    get mode() { return this._mode; }

    attachTo(emitter) { this._emitter = emitter || null; return this; }
    detach() { this._emitter = null; }

    // Reposition the emitter against the shared listener (written centrally per
    // frame). Call per audible frame and per streamed chunk.
    update() {
        const e = this._emitter;
        if (this._mode === "hrtf") {
            if (e && e.position) this._sp.place(this._panner, e.position, e.forward || null, SPATIAL_AUDIO_TUNING.voice);
        } else if (this._mode === "stereo") {
            this._stereo.pan.value = (e && e.position) ? this._sp.stereoPan(e.position) : 0;
        }
        // passthrough: nothing to position.
    }

    // Play a one-shot AudioBuffer through the spatial chain (e.g. a baked filler).
    // Returns the source; also tracked for stop(). onended fires on completion.
    playClip(buffer, { onended } = {}) {
        const src = this._sp.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this._out);
        src.onended = () => {
            this._clips = this._clips.filter((s) => s !== src);
            onended && onended();
        };
        this._clips.push(src);
        src.start();
        return src;
    }

    // Stop every clip this voice started (one-shot barge-in). Sources routed
    // through `output` by an external scheduler are that scheduler's to stop.
    stop() {
        for (const s of this._clips) { try { s.stop(); } catch { /* already stopped */ } }
        this._clips = [];
    }
}
