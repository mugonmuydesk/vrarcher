// Prebaked companion-VOICE clips for the on-device (Tier-1, no-TTS) brain — the
// thing that gives an otherwise text-only tier an audible companion. Two stages,
// both played from baked clips (like barks.js), never synthesised:
//
//   • STAGE A — RECEIPT tokens. The instant the turn detector says the player
//     FINISHED a turn (before STT-final + intent classification), play a short
//     content-free "I heard you, thinking" sound ("Hm.", "Let me see.", "Hm?").
//     It commits to NOTHING about content — safe even if we end up not
//     understanding — so it masks the processing gap without risking a wrong
//     "yep". Fired on EVERY turn (see voicechat _finishHandsFree).
//   • STAGE B — the RESPONSE. After the brain classifies, play the clip for the
//     line it chose: a movement-ack (ACK_LINES), a small-talk line (SOCIAL_LINES),
//     or a "say again" (FALLBACK_LINES). These CAN commit ("On it.") because the
//     intent is now known. Driven by brain.onCommand / onSocial (wired in main.js).
//
// Stage A and Stage B are SERIALISED through one promise chain so the receipt
// token finishes (or hits a short cap) before the response plays — no double-talk
// on a quick "hello" (the "ack on everything" decision). A clip that hasn't been
// baked yet is a silent no-op (exactly like a missing bark), so this ships safely
// BEFORE the clips exist: the text replies already show on the NPC HUD, and the
// audio lights up once assets/acks/*.wav are baked in Wren's voice.
//
// ENGINE-CLEAN vs ADAPTER, same split as barks.js:
//   • The clip lists + MANIFEST + key resolution live in ack-lines.js (pure data
//     — the bake tool's source of truth and the port's re-tuning checklist).
//   • AckVoice (below) is the only engine-touching half: it fetches/decodes the
//     wavs and schedules them EMBODIED at the companion via the shared
//     SpatialVoice/HRTF chain her spoken lines use.
//
// PORT: the native build bakes the same clips in its companion voice; the manifest
// + key scheme transcribe directly. Only AckVoice (Web Audio scheduling) is
// re-authored against the native audio API.

import { RECEIPTS, ACK_BY_KEY } from "./ack-lines.js";
import { SpatialVoice } from "./voice-audio.js";

// Tuning — module-top so the native port re-tunes here.
export const ACK_TUNING = {
    receiptCooldownMs: 1500,   // ms — min gap between receipt tokens (anti-spam on chatty turns)
    receiptCapMs: 900,         // ms — max time the response waits on a receipt token before playing anyway
    receiptOnEvery: true,      // fire a Stage-A receipt on every captured turn (the "ack on everything" decision)
};

// --- Babylon/audio adapter --------------------------------------------------
// The only engine-touching half: fetch/decode the baked clips and schedule one
// EMBODIED at the companion (HRTF PannerNode at the NPC, listener at the head)
// through the same SpatialVoice the spoken voice uses. A missing clip → silent
// no-op. Mirrors barks.js BarkAudio.
export class AckVoice {
    constructor(ctx) {
        this.ctx = ctx;
        this._bank = new Map();   // file → AudioBuffer | null (null = tried + missing)
        this._voice = null;       // SpatialVoice over the shared engine, lazy
        this._lastReceiptMs = -Infinity;
        // Serialises playback so Stage A finishes (or caps) before Stage B —
        // "ack on everything" without double-talk. Each play() appends here.
        this._chain = Promise.resolve();
        this._now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    }

    // Fetch + decode one clip by file basename (cached, including the miss). PORT:
    // native loads the same baked clip from its asset bundle.
    async _buffer(file) {
        if (this._bank.has(file)) return this._bank.get(file);
        const a = this.ctx.feedback?.audio;
        if (!a) return null;                 // no AudioContext yet — retry next call
        let buf = null;
        try {
            const res = await fetch(`assets/acks/${file}.wav`);
            if (res.ok) buf = await a.decodeAudioData(await res.arrayBuffer());
        } catch { /* not baked yet / decode fail → stays null (silent) */ }
        this._bank.set(file, buf);
        return buf;
    }

    // Schedule a buffer embodied at the companion and resolve when it ends (or
    // after `capMs` if longer, so the serialising chain never stalls on a long
    // clip). Mirrors barks.js's embodied path.
    _playBuffer(buf, capMs = 0) {
        return new Promise((resolve) => {
            const a = this.ctx.feedback?.audio;
            if (!a || !buf) { resolve(); return; }
            const start = () => {
                let src;
                const sp = this.ctx.feedback?.spatial;
                const npc = this._pickNpc();
                if (sp && npc) {
                    if (!this._voice || this._voice._sp !== sp) this._voice = new SpatialVoice(sp);
                    this._voice.attachTo({ position: npc.mover.position });
                    this._voice.update();
                    src = this._voice.playClip(buf);
                } else {
                    src = a.createBufferSource();
                    src.buffer = buf;
                    src.connect(a.destination);
                    src.start();
                }
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                if (src) src.onended = finish;
                const waitMs = capMs > 0 ? Math.min(capMs, buf.duration * 1000) : buf.duration * 1000;
                setTimeout(finish, waitMs + 20);
            };
            if (a.state === "suspended") a.resume().then(start, start); else start();
        });
    }

    // Append a clip (resolved by manifest key) to the serial chain. capMs bounds
    // how long the NEXT clip waits on this one. Returns the chain tail.
    _enqueue(key, capMs = 0) {
        const entry = ACK_BY_KEY.get(key);
        if (!entry) return this._chain;        // unknown key → nothing
        this._chain = this._chain.then(async () => {
            const buf = await this._buffer(entry.file);
            await this._playBuffer(buf, capMs);
        }).catch(() => { /* keep the chain alive */ });
        return this._chain;
    }

    // The NPC a clip emits from — addressed target, else nearest attending, else
    // nearest of any state (lifted from barks.js: a reply may land while the
    // player looks downrange, so neither addressing nor "attend" holds).
    _pickNpc() {
        const npcs = this.ctx.npcs?.npcs;
        if (!npcs?.length) return null;
        const addressed = this.ctx.addressing?.target ?? null;
        if (addressed) return addressed;
        const cam = this.ctx.scene?.activeCamera;
        if (!cam) return npcs[0];
        let best = null, bestD = Infinity, nearest = null, nearestD = Infinity;
        for (const n of npcs) {
            const d = Math.hypot(n.mover.position.x - cam.globalPosition.x, n.mover.position.z - cam.globalPosition.z);
            if (d < nearestD) { nearestD = d; nearest = n; }
            if (n.brain?.state === "attend" && d < bestD) { bestD = d; best = n; }
        }
        return best ?? nearest;
    }
}

// --- Glue (public API) ------------------------------------------------------
// ctx.acks.playReceipt() at turn-complete; ctx.acks.playAck/playSocial/playFallback
// after the brain classifies (wired off brain.onCommand / onSocial in main.js).
// All fire-and-forget + graceful-silent.
export class Acks {
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.T = { ...ACK_TUNING, ...opts.tuning };
        this.voice = new AckVoice(ctx);
        this._receiptIdx = 0;   // rotation cursor over RECEIPTS
    }

    // STAGE A. Play a rotating receipt token (cooldown-gated). The response that
    // follows (Stage B) is serialised behind it via the shared chain, so it waits
    // up to receiptCapMs for this to finish. Returns the receipt index, or -1 if
    // suppressed by the cooldown.
    playReceipt() {
        if (!this.T.receiptOnEvery) return -1;
        const now = this.voice._now();
        if (now - this.voice._lastReceiptMs < this.T.receiptCooldownMs) return -1;
        this.voice._lastReceiptMs = now;
        const i = this._receiptIdx % RECEIPTS.length;
        this._receiptIdx = (i + 1) % RECEIPTS.length;
        this.voice._enqueue(`receipt:${i}`, this.T.receiptCapMs);
        return i;
    }

    // STAGE B. Play the clip for the brain's chosen line. index comes from the
    // brain (ackIndex / social index); -1 means "no specific line" → skip audio.
    playAck(state, index) { if (index >= 0) this.voice._enqueue(`ack:${state}:${index}`); }
    playSocial(intent, index) { if (index >= 0) this.voice._enqueue(`social:${intent}:${index}`); }
    playFallback(index) { if (index >= 0) this.voice._enqueue(`fallback:${index}`); }
}
