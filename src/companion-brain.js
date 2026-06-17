// Tier-1 SCRIPTED companion brain — a finite-state machine driven by the
// on-device intent classifier (src/intent.js). No LLM, no network: a spoken
// command is embedded locally, matched to the nearest companion state, and the
// brain replies with a short in-character acknowledgement ("Wren" — brave, warm,
// quick-witted, dry). This is the "all on-device, no-LLM" companion tier.
//
// DROP-IN for voicechat.js: matches the GeminiBrain contract exactly —
//   async respond(userText, state = "") => replyString
//   reset()
//   .history   (kept for interface parity; the scripted brain doesn't use it)
//   .fillers   (no-op flag; scripted replies are already terse, no filled pause)
// so it swaps straight into `ctx.voicechat.brain`.
//
// It ALSO exposes the COMPANION-control surface the NPC/movement system will
// drive off later:
//   .companionState           current FSM state (string, one of STATES)
//   .onStateChange(fn)         subscribe; fn(newState, oldState, { reason })
//   .lastCommand              { text, state, score, confident } of last turn
//   .lastTurnRecognized       true if the last respond() was a recognised command
//
// It also answers ASK / query intents (e.g. "what's my score?", "how many
// arrows do I have?") by REPORTING from live game state — these do NOT switch
// companionState (no movement). The live state is read through an injected
// `gameState` provider (() => ({ score, hits, arrows })), keeping this module
// engine-clean. If no provider is wired, ask intents degrade to a generic line.
//   .onQuery(fn)              subscribe; fn({ intent, gameState }) on a confident ask
//   .lastQuery                { text, intent, score } of the last ask, or null
//
// It ALSO answers SOCIAL / small-talk intents (greet, thanks, "where are we?",
// "how are you?", …) with a short scripted in-character line. Like asks, these do
// NOT switch companionState (no movement) and report nothing from game state —
// they're pure conversation, classified as a THIRD centroid table and gated by a
// top1-top2 margin so ambiguous near-ties fall back to banter rather than misfire.
//   .onSocial(fn)             subscribe; fn({ intent, score, line, index }) on a confident social intent
//   .lastSocial               { text, intent, score } of the last small-talk, or null
//
// Engine-clean: NO Babylon, NO network. Pure functions + the local classifier.
//
// PORT: this FSM transcribes 1:1 to a native state machine; classify() is the
// only seam, and it's a static-embedding lookup with a native equivalent.

import * as intent from "./intent.js";
import { INTENT_TUNING } from "./intent.js";
import {
    COMMAND_BANK, ACK_LINES, FALLBACK_LINES, STATES,
    ASK_BANK, ASK_TEMPLATES, ASK_FALLBACK,
    SOCIAL_BANK, SOCIAL_LINES, SOCIAL_INTENTS,
} from "./command-bank.js";

// --- Tuning (the port's re-tuning checklist) -------------------------------
export const BRAIN_TUNING = {
    defaultState: "FOLLOW",   // home state; reset() returns here
    recallState: "FOLLOW",    // universal recall target ("to me" / "follow me")
    standDownState: "REST",   // universal stand-down target
};

export class CompanionBrain {
    constructor({
        bank = COMMAND_BANK, acks = ACK_LINES, fallbacks = FALLBACK_LINES,
        askBank = ASK_BANK, askTemplates = ASK_TEMPLATES, askFallback = ASK_FALLBACK,
        socialBank = SOCIAL_BANK, socialLines = SOCIAL_LINES,
        gameState = null,   // optional () => ({ score, hits, arrows, ... }) provider
    } = {}) {
        this._bank = bank;
        this._acks = acks;
        this._fallbacks = fallbacks;
        this._askBank = askBank;
        this._askTemplates = askTemplates;
        this._askFallback = askFallback;
        this._socialBank = socialBank;
        this._socialLines = socialLines;
        this._gameState = typeof gameState === "function" ? gameState : null;

        this.companionState = BRAIN_TUNING.defaultState;
        this.lastCommand = null;          // { text, state, score, confident }
        this.lastTurnRecognized = false;  // was the last respond() a command?
        this.lastQuery = null;            // { text, intent, score } of last ask
        this.lastSocial = null;           // { text, intent, score } of last small-talk

        // GeminiBrain interface parity (unused by the scripted brain, but kept so
        // voicechat.js's barge-in/history bookkeeping never trips on undefined).
        this.history = [];
        this.fillers = false;

        this._stateListeners = [];
        this._commandListeners = [];      // fire on EVERY confident command
        this._queryListeners = [];        // fire on EVERY confident ask intent
        this._socialListeners = [];       // fire on EVERY confident social intent
        this._ackIdx = {};                // per-state rotation cursor
        for (const st of STATES) this._ackIdx[st] = 0;
        this._socialIdx = {};             // per-social-intent rotation cursor
        for (const k of SOCIAL_INTENTS) this._socialIdx[k] = 0;
        this._fallbackIdx = 0;

        // Kick off the lazy model load + centroid build. respond() awaits this,
        // so the first turn waits for the (one-time, ~30 MB) load; later turns are
        // instant (~0.004 ms classify). Failures are surfaced per-turn, not thrown
        // at construction (keeps the brain swap-in non-blocking).
        this._ready = intent.init(this._bank, this._askBank, this._socialBank).catch((e) => {
            console.warn("[companion-brain] intent model load failed:", e?.message || e);
            this._loadError = e;
        });
    }

    // Subscribe to state transitions. Returns an unsubscribe fn.
    onStateChange(fn) {
        this._stateListeners.push(fn);
        return () => {
            const i = this._stateListeners.indexOf(fn);
            if (i >= 0) this._stateListeners.splice(i, 1);
        };
    }

    // Subscribe to EVERY confident command (unlike onStateChange, this fires even
    // when the command repeats the current state — "follow me" while already
    // FOLLOW must still re-issue the movement order). fn({ state, score }).
    // Returns an unsubscribe fn.
    onCommand(fn) {
        this._commandListeners.push(fn);
        return () => {
            const i = this._commandListeners.indexOf(fn);
            if (i >= 0) this._commandListeners.splice(i, 1);
        };
    }

    _emitCommand(state, score, ackIndex) {
        for (const fn of this._commandListeners) {
            try { fn({ state, score, ackIndex }); }
            catch (e) { console.warn("[companion-brain] onCommand listener threw:", e?.message || e); }
        }
    }

    // Subscribe to EVERY confident ASK / query intent (a report from game state,
    // NOT a movement command — companionState is untouched). fn({ intent, score,
    // gameState }). Returns an unsubscribe fn.
    onQuery(fn) {
        this._queryListeners.push(fn);
        return () => {
            const i = this._queryListeners.indexOf(fn);
            if (i >= 0) this._queryListeners.splice(i, 1);
        };
    }

    _emitQuery(intent, score, gameState) {
        for (const fn of this._queryListeners) {
            try { fn({ intent, score, gameState }); }
            catch (e) { console.warn("[companion-brain] onQuery listener threw:", e?.message || e); }
        }
    }

    // Subscribe to EVERY confident SOCIAL / small-talk intent (a scripted reply,
    // NOT a movement command — companionState is untouched). fn({ intent, score,
    // line, index }) where index identifies the prebaked clip
    // (SOCIAL_LINES[intent][index]). Used by the prebaked-clip voice (acks.js).
    // Returns an unsubscribe fn.
    onSocial(fn) {
        this._socialListeners.push(fn);
        return () => {
            const i = this._socialListeners.indexOf(fn);
            if (i >= 0) this._socialListeners.splice(i, 1);
        };
    }

    _emitSocial(intent, score, line, index) {
        for (const fn of this._socialListeners) {
            try { fn({ intent, score, line, index }); }
            catch (e) { console.warn("[companion-brain] onSocial listener threw:", e?.message || e); }
        }
    }

    // Pick a social reply line (rotated so it doesn't repeat). Returns { line,
    // index } — the index identifies the prebaked clip (SOCIAL_LINES[intent][i]).
    _social(intentKey) {
        const lines = this._socialLines?.[intentKey] || [];
        if (lines.length === 0) return { line: "Mm.", index: -1 };
        const i = (this._socialIdx[intentKey] || 0) % lines.length;
        this._socialIdx[intentKey] = (i + 1) % lines.length;
        return { line: lines[i], index: i };
    }

    // Read the injected live game state, or a safe default if none is wired.
    _readGameState() {
        if (!this._gameState) return null;
        try {
            const s = this._gameState();
            return s && typeof s === "object" ? s : null;
        } catch (e) {
            console.warn("[companion-brain] gameState provider threw:", e?.message || e);
            return null;
        }
    }

    // Format an ask intent's reply from live game state (or its graceful fallback
    // when no state is wired / a template is missing).
    _answerAsk(intentKey, score, text) {
        this.lastQuery = { text, intent: intentKey, score };
        const tpl = this._askTemplates?.[intentKey];
        const gs = this._readGameState();
        if (gs && typeof tpl === "function") {
            this._emitQuery(intentKey, score, gs);
            try {
                return tpl(gs);
            } catch (e) {
                console.warn("[companion-brain] ask template threw:", e?.message || e);
            }
        }
        // No live state, no template, or template error → degrade gracefully.
        return this._askFallback?.[intentKey] ?? "Hard to say right now.";
    }

    _setState(next, reason) {
        const prev = this.companionState;
        if (next === prev) return;
        this.companionState = next;
        for (const fn of this._stateListeners) {
            try { fn(next, prev, { reason }); }
            catch (e) { console.warn("[companion-brain] onStateChange listener threw:", e?.message || e); }
        }
    }

    // Pick an acknowledgement line (rotated). Returns { line, index } — index
    // identifies the prebaked clip (ACK_LINES[state][i]); -1 when none defined.
    _ack(state) {
        const lines = this._acks[state] || [];
        if (lines.length === 0) return { line: "Understood.", index: -1 };
        const i = this._ackIdx[state] % lines.length;
        this._ackIdx[state] = (i + 1) % lines.length;
        return { line: lines[i], index: i };
    }

    _fallback() {
        const lines = this._fallbacks;
        if (!lines || lines.length === 0) return "Say again?";
        const i = this._fallbackIdx % lines.length;
        this._fallbackIdx = (i + 1) % lines.length;
        return lines[i];
    }

    // Drop-in respond. `state` is the LIVE GAME state string (score etc.) that
    // voicechat passes through for the Gemini brain; the scripted brain ignores
    // it (kept for signature parity). Returns the line the companion "says".
    async respond(userText, _gameState = "") {
        await this._ready;
        const text = (userText ?? "").trim();

        if (!text || this._loadError || !intent.isReady()) {
            // No usable input or the model never loaded — fall back, stay put.
            this.lastTurnRecognized = false;
            this.lastCommand = { text, state: this.companionState, score: 0, confident: false };
            return this._fallback();
        }

        const { state, score, confident, kind, intent: matchIntent, margin } = intent.classify(text);
        this.lastCommand = { text, state, score, confident };

        if (!confident) {
            // Chatter / unclear order → no transition, banter fallback.
            this.lastTurnRecognized = false;
            return this._fallback();
        }

        // Recognised ASK / query → REPORT from live game state. No FSM move, no
        // movement command fired; companionState is untouched. Not counted as a
        // recognised movement command (lastTurnRecognized stays false).
        if (kind === "ask") {
            this.lastTurnRecognized = false;
            return this._answerAsk(matchIntent, score, text);
        }

        // Recognised SOCIAL / small-talk → a scripted in-character line. No FSM
        // move, no game-state read. The conversational centroids sit close, so a
        // confident-but-AMBIGUOUS win (small top1-top2 gap) is downgraded to the
        // banter fallback rather than risk answering the wrong small-talk.
        if (kind === "social") {
            this.lastTurnRecognized = false;
            // Two gates: a higher acceptance floor than commands (social is broad
            // + chatter-adjacent) AND a top1-top2 margin (the social centroids sit
            // close). Fail either → in-character banter, never a wrong small-talk.
            if (score < INTENT_TUNING.socialThreshold || margin < INTENT_TUNING.socialMargin) {
                this.lastSocial = null;
                return this._fallback();
            }
            const { line, index } = this._social(matchIntent);
            this.lastSocial = { text, intent: matchIntent, score };
            this._emitSocial(matchIntent, score, line, index);
            return line;
        }

        // Recognised command. Universal recall and stand-down are already encoded
        // in the bank (FOLLOW examples cover "to me"/"follow me"; REST covers
        // "stand down"), so classify() routes them to FOLLOW / REST directly —
        // these constants just document the intent and let the FSM force them if
        // the bank is ever re-tuned away from that mapping.
        let target = state;
        if (state === "FOLLOW") target = BRAIN_TUNING.recallState;
        else if (state === "REST") target = BRAIN_TUNING.standDownState;

        this.lastTurnRecognized = true;
        this._setState(target, { command: text, score });
        const { line, index } = this._ack(target);
        // Fire on EVERY confident command (even a re-issue of the current state)
        // so the movement layer re-asserts the order — _setState only fires on a
        // CHANGE, which would swallow "follow me" while already FOLLOW. The ack
        // index identifies the prebaked clip for the voice (acks.js).
        this._emitCommand(target, score, index);
        return line;
    }

    reset() {
        this.history = [];
        this.lastCommand = null;
        this.lastTurnRecognized = false;
        this.lastQuery = null;
        this.lastSocial = null;
        for (const st of STATES) this._ackIdx[st] = 0;
        for (const k of SOCIAL_INTENTS) this._socialIdx[k] = 0;
        this._fallbackIdx = 0;
        this._setState(BRAIN_TUNING.defaultState, { reason: "reset" });
    }

    // Optional: await this if a caller wants to know the model is warm before the
    // first turn (e.g. to show a "ready" indicator). respond() awaits it anyway.
    ready() { return this._ready; }
}
