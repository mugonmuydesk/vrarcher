// Combat-bark system — short reactive companion callouts ("Behind you!", "Nice
// shot!") fired by GAME EVENTS, not the dialogue brain. A bark is one of the 12
// pre-baked BARKS clips (fillers.js → assets/fillers/b<NN>.wav), played directly
// the instant an event lands, panned toward the companion. Distinct from the
// filled-pause bank (which masks TTS latency inside an LLM turn) and from the
// VoiceChat conversation loop (tap-to-talk) — barks never go through the model
// and never block a turn.
//
// Two halves, kept visibly apart so the native port stays a transcription job:
//   • BarkController (ENGINE-CLEAN) — an event→bark map plus the cooldown state
//     machine that decides WHICH bark (if any) an event should fire. Pure: no
//     Babylon, no audio, `now` injected, node-testable. This is the port's
//     re-tuning + re-mapping checklist.
//   • BarkAudio (ADAPTER, below the banner) — lazily fetches/decodes the bNN.wav
//     clips through ctx.feedback.audio and schedules one, panned toward the
//     addressed/attending companion (mirrors voicechat's bank loader + _npcPan).
//
// Wiring (main.js) glues the two: ctx.barks.fire(event) asks the controller for
// a bark index and, if it isn't suppressed, plays it through the adapter. Most
// combat events (enemy_behind, wave_start, player_hit, …) have NO trigger yet —
// there's no wave/enemy system — so they're documented, ready-to-fire entries a
// future combat system calls as ctx.barks.fire("wave_start"). Only the events
// that exist TODAY are hooked: player_hit_target (target's onArrowHit seam).
//
// PORT: the native port bakes the same bNN clips in its companion voice; this
// event map + the cooldown tuning transcribe directly. Only BarkAudio (the
// Web Audio scheduling + pan) is re-authored against the native audio API.

import { BARKS, barkClip } from "./fillers.js";
import { SpatialVoice } from "./voice-audio.js";

// Tuning — the cooldowns that keep barks from spamming or stepping on each
// other. Module-top so the native port re-tunes here. Values are starting
// points; expect to feel them out in-headset.
export const BARK_TUNING = {
    globalCooldownMs: 2500,   // ms — minimum gap between ANY two barks (anti-spam)
    perEventCooldownMs: 8000, // ms — the SAME event can't re-bark sooner than this
};

// Event → bark. Each game event names one BARKS index (the clip to play). The
// index is validated against BARKS at construction. Inline notes justify each
// choice; the wave_start choice is called out in the header comment too.
//
//   enemy_behind      → 0  "Behind you!"        — threat at the player's back
//   incoming          → 1  "Incoming!"          — projectiles / a charge inbound
//   look_out          → 2  "Look out!"          — generic imminent-danger warn
//   player_hit_target → 3  "Nice shot!"         — praise on a target arrow hit
//   wave_start        → 1  "Incoming!"          — rally as a wave begins. BARKS
//        has NO exact "Here they come!"; "Incoming!" (1) reads as the enemies
//        arriving (vs. 8 "Push forward!", which is an advance order, wrong beat
//        for a wave that's just spawning). Chosen: 1.
//   player_hit        → 9  "I'm hit!"           — companion took damage
//   low_health        → 8  "Push forward!"      — encouragement when low on HP.
//        BARKS has no morale line; "Push forward!" reads as "keep going". (8)
//   wave_clear        → 11 "Last one— finish it!" — last enemy of the wave down
//   victory           → 11 "Last one— finish it!" — alias of wave_clear (triumph)
//
// Extra ready-to-fire combat events mapped to existing barks so a future
// combat system has them on hand (no new clips needed):
//   flanking          → 6  "They're flanking us!"
//   take_cover        → 7  "Get down!"
//   advance           → 8  "Push forward!"
//   left_flank        → 4  "On your left!"
//   cover_me          → 5  "Cover me!"
//   killing_blow      → 10 "Right in the teeth!"
export const BARK_EVENTS = {
    enemy_behind: 0,
    incoming: 1,
    look_out: 2,
    player_hit_target: 3,
    wave_start: 1,
    player_hit: 9,
    low_health: 8,
    wave_clear: 11,
    victory: 11,
    flanking: 6,
    take_cover: 7,
    advance: 8,
    left_flank: 4,
    cover_me: 5,
    killing_blow: 10,
};

// ENGINE-CLEAN cooldown state machine. fire(event, nowMs) → the BARKS index to
// play, or -1 if the event is unknown or suppressed by a cooldown. Tracks one
// global last-fire time plus a per-event last-fire time. `now` is injected so
// it's deterministic in tests; it defaults to a wall clock for live use.
export class BarkController {
    constructor(opts = {}) {
        this.T = { ...BARK_TUNING, ...opts.tuning };
        this.events = { ...BARK_EVENTS, ...opts.events };
        // Sanity: every mapped event must resolve to a real BARKS index. A bad
        // map would silently play the wrong line or crash the adapter.
        for (const [ev, idx] of Object.entries(this.events)) {
            if (!Number.isInteger(idx) || idx < 0 || idx >= BARKS.length) {
                throw new Error(`[barks] event "${ev}" maps to invalid bark index ${idx}`);
            }
        }
        this._lastFireMs = -Infinity;       // when ANY bark last fired
        this._lastEventMs = new Map();      // event → when IT last fired
        this._now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    }

    // Resolve an event to a bark index, applying both cooldowns. Returns -1 when
    // suppressed (unknown event, global gap not elapsed, or this event barked
    // too recently). On a fire it stamps both clocks.
    fire(event, nowMs) {
        const idx = this.events[event];
        if (idx === undefined) return -1;               // unknown event
        const now = nowMs ?? this._now();
        if (now - this._lastFireMs < this.T.globalCooldownMs) return -1; // too soon after any bark
        const last = this._lastEventMs.get(event);
        if (last !== undefined && now - last < this.T.perEventCooldownMs) return -1; // same event too soon
        this._lastFireMs = now;
        this._lastEventMs.set(event, now);
        return idx;
    }

    // The clip basename ("b03") for a bark index — handy for the adapter/tests.
    clipFor(idx) { return barkClip(idx); }
}

// --- Babylon/audio adapter ---------------------------------------------------
// Below this banner is the only engine-touching code: it reaches the shared
// AudioContext (ctx.feedback.audio) and schedules a baked bark clip. Keep the
// controller above engine-clean; this half is re-authored for the native port.

// Lazily fetch + decode the 12 baked bark clips into AudioBuffers (mirrors
// VoiceChat._ensureFillerBank), then play one EMBODIED at the companion: through
// the shared SpatialAudio engine (HRTF PannerNode at the NPC, listener at the
// head) via the same SpatialVoice adapter her spoken lines use, so a bark is
// co-located with her voice rather than a flat stereo clip on the master bus.
// (Falls back to a stereo pan only when the engine isn't HRTF-capable.) The
// AudioContext is unlocked on the XR-entry gesture; before that, play() is a
// near-silent no-op (it tries to resume, then plays muted at most).
export class BarkAudio {
    constructor(ctx) {
        this.ctx = ctx;
        this._bank = null;     // AudioBuffer[] (baked bark clips), lazy
        this._bankP = null;    // in-flight load (shared by concurrent callers)
        this._voice = null;    // SpatialVoice over the shared engine (HRTF panner at the NPC), lazy
        this._lastSrc = null;  // the most recent scheduled source (demo assert)
        // Warm the bank in the background so the first bark is snappy.
        this._ensureBank();
    }

    async _ensureBank() {
        if (this._bank) return this._bank;
        if (this._bankP) return this._bankP;
        const a = this.ctx.feedback?.audio;
        if (!a) return null;               // no AudioContext yet — retry next call
        this._bankP = (async () => {
            const bank = new Array(BARKS.length).fill(null);
            await Promise.all(BARKS.map(async (_, i) => {
                try {
                    const res = await fetch(`assets/fillers/${barkClip(i)}.wav`);
                    if (!res.ok) return;
                    bank[i] = await a.decodeAudioData(await res.arrayBuffer());
                } catch { /* leave null → this bark just stays silent */ }
            }));
            this._bank = bank;
            return bank;
        })();
        return this._bankP;
    }

    // Play bark `index`, EMBODIED at the companion. Returns the source started
    // (or null if it couldn't play — no context, missing clip).
    async play(index) {
        const a = this.ctx.feedback?.audio;
        if (!a) return null;
        if (a.state === "suspended") { try { await a.resume(); } catch { /* gesture pending */ } }
        const buf = (await this._ensureBank())?.[index];
        if (!buf) return null;             // clip missing → silent

        // Embodied path: emit the bark from the companion's world position through
        // the SAME HRTF/distance chain as her spoken voice (SpatialVoice over the
        // shared SpatialAudio engine), so "Nice shot!" comes from HER, co-located
        // with her speech — not a flat stereo clip on the master bus.
        const sp = this.ctx.feedback?.spatial;
        const npc = this._pickNpc();
        if (sp && npc) {
            if (!this._voice || this._voice._sp !== sp) this._voice = new SpatialVoice(sp);
            this._voice.attachTo({ position: npc.mover.position }); // same anchor as VoiceChat
            this._voice.update();                                   // place the panner at the NPC
            const src = this._voice.playClip(buf);
            this._lastSrc = src;
            return src;
        }

        // Fallback (no NPC, or the spatial engine isn't HRTF-capable): flat stereo
        // pan toward the companion, straight to master.
        const src = a.createBufferSource();
        src.buffer = buf;
        let node = src;
        const pan = this._npcPan();
        if (pan !== null && a.createStereoPanner) {
            const p = a.createStereoPanner();
            p.pan.value = pan;
            src.connect(p); node = p;
        }
        node.connect(a.destination);
        src.start();
        this._lastSrc = src;
        return src;
    }

    // The NPC a bark emits from: the addressed (gaze+proximity) target, else the
    // nearest "attending" NPC, else the nearest NPC of ANY state. Unlike
    // VoiceChat._emitterNpc (which returns null when no NPC is addressed/attending,
    // so conversational TTS centres), a REACTIVE bark must still come from the
    // companion's body — "Nice shot!" fires while you're looking downrange at the
    // target, not at her, so neither addressing nor "attend" will hold. With a
    // single companion that means the bark always emits from her.
    // PORT: WHO to emit from (addressing → attending → nearest) is engine-clean.
    _pickNpc() {
        const npcs = this.ctx.npcs?.npcs;
        if (!npcs?.length) return null;
        const addressed = this.ctx.addressing?.target ?? null;
        if (addressed) return addressed;
        const cam = this.ctx.scene?.activeCamera;
        if (!cam) return npcs[0];                 // no camera to range against — any body
        let best = null, bestD = Infinity, nearest = null, nearestD = Infinity;
        for (const n of npcs) {
            const d = Math.hypot(n.mover.position.x - cam.globalPosition.x, n.mover.position.z - cam.globalPosition.z);
            if (d < nearestD) { nearestD = d; nearest = n; }         // nearest of any state
            if (n.brain?.state === "attend" && d < bestD) { bestD = d; best = n; } // prefer attending
        }
        return best ?? nearest;
    }

    // Stereo-pan fallback toward the picked NPC (used only when the HRTF spatial
    // engine isn't available). Projects the companion direction onto camera-right.
    _npcPan() {
        const npc = this._pickNpc();
        const cam = this.ctx.scene?.activeCamera;
        if (!npc || !cam) return null;
        const right = cam.getDirection(BABYLON.Axis.X);
        const dx = npc.mover.position.x - cam.globalPosition.x;
        const dz = npc.mover.position.z - cam.globalPosition.z;
        const r = (dx * right.x + dz * right.z) / (Math.hypot(dx, dz) || 1);
        return Math.max(-1, Math.min(1, r));
    }
}

// Glue: the BarkController (decision) + BarkAudio (sound). ctx.barks.fire(event)
// resolves the bark through the cooldown machine and, if it isn't suppressed,
// schedules the clip. Returns the bark index played, or -1 if suppressed. The
// audio is fire-and-forget (play() is async; the event doesn't await it).
export class Barks {
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.controller = new BarkController(opts);
        this.audio = new BarkAudio(ctx);
    }

    fire(event, nowMs) {
        const idx = this.controller.fire(event, nowMs);
        if (idx >= 0) this.audio.play(idx);   // fire-and-forget; suppressed → silent
        return idx;
    }
}
