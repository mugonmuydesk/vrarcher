// Turn detection — at a VAD silence boundary, decide whether the player has
// FINISHED their turn or is just mid-thought pausing ("Let me see…"), so the
// companion doesn't barge in over a filled pause. The VAD (vad.js) only emits a
// *candidate* endpoint when the mic goes quiet; this module is what promotes a
// candidate to a *confirmed* turn-end. It fuses up to three independent signals,
// every one of which is OPTIONAL — the detector degrades gracefully to a robust
// default (min-silence timeout + gaze-leave) when no model is loaded:
//
//   • silence/maxlen — ALWAYS available, no model. The VAD already enforced a
//                      min-silence hangover before calling us, so reaching this
//                      module IS evidence of an endpoint; we add a hard max-len
//                      cap so a never-confident model can't hold the mic forever,
//                      and a min-len floor so a lip-smack isn't a whole turn.
//   • gaze-leave     — FREE from addressing.js: the caller passes `gazeHeld`. When
//                      the player's gaze is NO LONGER held on the addressed
//                      companion (gazeHeld === false), that alone is an explicit
//                      "I'm done talking to you" → end the turn. No model needed.
//   • audio EoU      — Smart Turn v3 (pipecat-ai), an end-of-turn model run on the
//                      buffered utterance audio (Float32 16 kHz). P(turn ended).
//   • text EoU       — TurnSense (SmolLM2-135M based), an end-of-utterance model
//                      run on the partial transcript. P(utterance complete).
//
// MODEL LOADING — ON DEMAND FROM CDN, NEVER VENDORED HERE (see CLAUDE.md: do not
// vendor a 360 MB blob blindly). Both models are lazy-loaded the first time the
// caller opts into them, via transformers.js / onnxruntime-web pulled from a CDN
// (esm.sh / jsDelivr). Until a model has loaded — and forever, if the caller
// never enables it — the corresponding scorer ABSTAINS (returns null) and the
// ensemble runs on the default signals alone. The load is fire-and-once-cached:
// the first isTurnComplete() that requests a model kicks off the import in the
// background and abstains for that turn; subsequent turns use it once warm. See
// loadSmartTurn() / loadTurnSense() for the exact (TODO-flagged) call sites.
//
// SMART TURN v3 SIZE FINDING (researched 2026-06-15 — vendor NOTHING here):
// the roadmap's "~360 MB, evaluate before committing" warning is STALE — that was
// Smart Turn *v2* (wav2vec2-based). Smart Turn *v3* (pipecat-ai, 2026) rebased on
// Whisper-Tiny (~8 M params) and ships ONNX: ~8 MB int8 (CPU, ~12 ms inference)
// or ~32 MB fp32 (GPU). At 8 MB it is comfortably loadable on demand — same
// ballpark as Silero VAD. TurnSense (SmolLM2-135M ONNX) is larger; weigh it
// server-side first. We CDN-load both lazily so the cold-start page never pays
// for them and the model choice stays open.
//   refs: daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/
//         huggingface.co/pipecat-ai/smart-turn-v3
//         huggingface.co/latishab/turnsense
//
// ENGINE-CLEAN: pure logic only. No Babylon, no ORT, no model weights imported at
// parse time — the CDN imports are LAZY (inside the loader functions) and the
// model scorers are otherwise INJECTABLE, so this whole file runs under plain
// `node --check` and the ensemble is unit-testable headless. `isTurnComplete()`
// is deterministic given fixed scorer outputs, cheap, idempotent, and cancellable
// (await scorers, no shared mutable decision state), so Phase 4 can call it inside
// the real-time VAD loop.
//
// PORT: the native Quest port runs the IDENTICAL ensemble — gaze-leave is the same
// addressing signal; Smart Turn / TurnSense become native ONNX (Meta XR / NNAPI)
// or a server call behind the same loader seams. No behaviour lives in JS that the
// port can't transcribe one-to-one. // PORT: scorers are async on every platform
// (model inference / network) — keep `isTurnComplete` async.

import { ADDRESS_TUNING } from "./addressing.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — native-port re-tuning checklist. Spec values are starting points;
// expect to re-tune against a real mic in-headset (Phase 5 threshold pass).
// ─────────────────────────────────────────────────────────────────────────────
export const TURN_TUNING = {
    audioCompleteThreshold: 0.5, // [0..1] Smart Turn P(complete) ≥ this ⇒ a CONFIDENT
                              //        audio "the player has finished" — drives the
                              //        decision (the silence boundary ENDS). Threshold
                              //        the model documents (its logits are P(complete)).
    audioKeepThreshold: 0.35, // [0..1] Smart Turn P(complete) < this ⇒ a CONFIDENT audio
                              //        "the player is mid-thought" — a KEEP-veto that
                              //        holds the boundary open even if silence/heuristic
                              //        would end (fixes "not sure if I'm finished"). The
                              //        band [audioKeepThreshold, audioCompleteThreshold)
                              //        is "unsure" — neither an end-vote nor a veto.
    audioEndThreshold: 0.5,   // [0..1] (legacy alias of audioCompleteThreshold for the
                              //        ensemble's end-vote; kept equal so both read the
                              //        same value) Smart Turn score ≥ this ⇒ votes "ended"
    textEndThreshold: 0.5,    // [0..1] TurnSense score ≥ this ⇒ text votes "ended"
    keepVetoThreshold: 0.3,   // [0..1] any present scorer scoring ≤ this is an active
                              //        KEEP-veto (it positively detects "NOT done" — a
                              //        continuation/pause), which holds the silence
                              //        boundary open even if other signals would end.
                              //        Scores between this and the end threshold are
                              //        "neutral" — neither a veto nor an end vote.
    requireBothAgree: true,   // true: end only when BOTH PRESENT model scorers vote
                              //       end (conservative — favours not cutting the
                              //       player off); false: either present scorer
                              //       ending is enough (snappier, more false ends)
    maxUtteranceMs: 12000,    // ms — hard cap: force-end a turn this long regardless
                              //      of scores, so a stuck/never-confident model
                              //      can't keep the mic open forever
    minUtteranceMs: 300,      // ms — floor: never end a turn shorter than this on
                              //      model/silence evidence, so a 1-frame blip /
                              //      lip-smack can't register as a whole turn
                              //      (gaze-leave bypasses this — see below)
    // ROBUST DEFAULT (no models): the VAD's own min-silence hangover already fired
    // before we're called, so once a turn is at least `minUtteranceMs` long with no
    // model voting otherwise, the trailing silence is treated as an endpoint after
    // this extra confirm window. Lets the detector work standalone.
    silenceConfirmMs: 0,      // ms — extra silence beyond the VAD hangover before the
                              //      no-model path confirms an end (0 = trust the VAD
                              //      hangover as-is; raise to be more patient)
    defaultConfidence: 0.55,  // [0..1] confidence reported when ONLY the silence
                              //        default ends the turn (no model, no gaze) —
                              //        a soft "probably done", below a model's say-so
    // Gaze-leave overrides the ensemble entirely: if the player's gaze is no longer
    // held on the addressed companion, that alone ends the turn (no audio/text
    // agreement needed). The caller derives `gazeHeld` from ctx.addressing (target
    // still locked / linger window); the linger window itself lives in addressing.js
    // so the two stay in lockstep — mirrored here for reference/tuning visibility.
    gazeLeaveEnds: true,      // gaze-leave alone ends the turn
    gazeLeaveConfidence: 0.95,// [0..1] confidence for a gaze-leave end (very high — an
                              //        explicit, deliberate "done" gesture)
    gazeLingerMs: ADDRESS_TUNING.lingerMs, // ms — mirrors addressing's release window
    maxlenConfidence: 1.0,    // [0..1] confidence for a hard max-length force-end
    // Models are OFF by default. Flip these (or pass opts) to opt a model in; the
    // first turn that requests it triggers the lazy CDN load and abstains meanwhile.
    useSmartTurn: false,      // load + use Smart Turn v3 (audio EoU) from CDN on demand
    useTurnSense: false,      // load + use TurnSense (text EoU) from CDN on demand
    useHeuristicText: true,   // use the built-in heuristic text EoU when TurnSense is
                              //   absent — a cheap, model-free "does this read finished"
};

// CDN sources for the on-demand model runtimes (NOT vendored — see header). Pinned
// so a CDN drift can't silently change behaviour; bump deliberately.
export const TURN_CDN = {
    // onnxruntime-web (for Smart Turn v3 ONNX). Reuse the vendored ORT if Phase 2b
    // already wired one in; this CDN URL is the fallback when none is injected.
    ort: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs",
    // Smart Turn v3 int8 ONNX (~8 MB) on the HF hub (or mirror behind the proxy).
    smartTurnModel: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.0.onnx",
    // transformers.js (for TurnSense — SmolLM2-135M ONNX text classifier).
    transformers: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3",
    turnSenseModel: "latishab/turnsense", // HF repo id resolved by transformers.js
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE — heuristicTextEou: a cheap, model-free stand-in for TurnSense. NOT a
// model — usable BEFORE (or instead of) loading TurnSense. Returns a score in
// [0..1] read as P(utterance complete). It is a KEEP-VETO detector, NOT a
// finished-detector: it casts a clearly-LOW score (a keep-veto, below
// textEndThreshold) ONLY when it spots a continuation cue — a trailing
// continuation/filler word ("let me", "so", "uh", "and"…), a comma/dash, or an
// ellipsis. For finished speech (sentence punctuation) OR punctuation-less,
// cue-free speech it returns a HIGH/neutral non-veto score, so the silence
// boundary is allowed to stand and the turn ends. Empty input ⇒ null (abstain).
// Deliberately conservative — clearly a fallback, not the model. node-testable.
// ─────────────────────────────────────────────────────────────────────────────
const CONTINUATION_WORDS = new Set([
    // filler / discourse openers that almost always have more coming after them
    "uh", "um", "er", "ah", "hmm", "like", "so", "and", "but", "or", "because",
    "well", "okay", "ok", "let", "lemme", "i", "we", "the", "a", "to", "that",
    "if", "when", "then", "now", "just", "maybe", "actually", "basically",
]);
// Multi-word lead-ins that signal "I'm about to continue" (checked on the tail).
const CONTINUATION_PHRASES = ["let me", "give me", "hold on", "one sec", "wait"];
// Mid-thought markers: an utterance that OPENS with one of these and carries no
// terminal punctuation reads as a thought still being formed ("let me see…",
// "I think we should…") → keep-veto. Checked as a prefix so the marker need not be
// the trailing words (the player keeps talking past it).
const MIDTHOUGHT_LEADINS = ["let me", "i think", "i guess", "i was", "give me", "hold on", "maybe we", "what if"];

export function heuristicTextEou(partialTranscript) {
    const t = (partialTranscript || "").trim().toLowerCase();
    if (!t) return null;                                    // nothing to judge → abstain
    if (/[.?!]["')\]]*$/.test(t)) return 0.9;               // sentence punctuation ⇒ done (no veto)
    if (/[,;:–—-]$/.test(t) || /\.\.\.$/.test(t) || /…$/.test(t)) return 0.15; // held breath ⇒ keep-veto
    for (const p of CONTINUATION_PHRASES) if (t.endsWith(p)) return 0.1; // trailing "let me" ⇒ keep-veto
    for (const p of MIDTHOUGHT_LEADINS) if (t === p || t.startsWith(p + " ")) return 0.1; // "let me see…" ⇒ keep-veto
    const last = t.replace(/[^a-z'\s]+$/g, "").split(/\s+/).pop() || "";
    if (CONTINUATION_WORDS.has(last)) return 0.15;          // trailing filler/continuation ⇒ keep-veto
    return 0.7;                                             // no continuation cue → non-veto (let it end)
}

// Default scorer: abstain. With no model loaded the scorer says "not there yet"
// and the ensemble degrades to the silence default + gaze-leave (+ heuristic text).
const abstain = async () => null;

// ─────────────────────────────────────────────────────────────────────────────
// ON-DEMAND CDN MODEL LOADERS (lazy; cached; abstain until warm).
//
// Each returns a SCORER: (input) => Promise<number 0..1 | null>. The heavy import
// happens INSIDE the loader (so this module parses under `node --check`), once,
// memoised. While a load is in flight the scorer returns null (abstain) so the
// turn still resolves on the default signals — no blocking the VAD loop on a cold
// model. // TODO(phase4): wire these into the real ORT/transformers.js runtime and
// verify on-device; until then they are SCAFFOLD call sites that resolve to abstain
// if the import fails or the runtime isn't present, so nothing crashes.
// ─────────────────────────────────────────────────────────────────────────────
let _smartTurn = { scorer: null, loading: null };
let _turnSense = { scorer: null, loading: null };

// Build (once) a Smart Turn v3 audio-EoU scorer. `opts.ort` lets the integration
// layer inject an already-loaded onnxruntime-web (e.g. the Phase 2b VAD's ORT) so
// we don't double-load it; otherwise it's CDN-imported from TURN_CDN.ort.
export function loadSmartTurn(opts = {}) {
    if (_smartTurn.scorer) return Promise.resolve(_smartTurn.scorer);
    if (_smartTurn.loading) return _smartTurn.loading;
    _smartTurn.loading = (async () => {
        try {
            // PORT: native Quest runs Smart Turn through ONNX Runtime Mobile.
            const ortSpec = opts.ortModule ?? TURN_CDN.ort;
            const ORT = opts.ort || await import(/* @vite-ignore */ ortSpec);
            const modelSrc = opts.modelUrl ?? TURN_CDN.smartTurnModel;
            const session = await ORT.InferenceSession.create(modelSrc);
            // TODO(phase4): confirm Smart Turn v3 ONNX I/O names + the mel/feature
            // front-end it expects (Whisper-Tiny encoder → EoU head). The contract
            // below is the documented shape; adjust once verified on the real model.
            const scorer = async (audio16k) => {
                if (!(audio16k && audio16k.length)) return null;     // nothing to score
                const inputT = new ORT.Tensor("float32", audio16k, [1, audio16k.length]);
                const out = await session.run({ input: inputT });
                // Output is P(turn complete) in [0..1]. Name TBD → take the first.
                const key = Object.keys(out)[0];
                const v = out[key]?.data?.[0];
                return typeof v === "number" ? v : null;
            };
            _smartTurn.scorer = scorer;
            return scorer;
        } catch (e) {
            // Cold load failed (offline / CDN blocked / contract mismatch): stay on
            // the default signals. Reset so a later turn can retry the load.
            _smartTurn.loading = null;
            if (typeof console !== "undefined") console.warn("[turn] Smart Turn load failed; abstaining:", e?.message || e);
            return abstain;
        }
    })();
    return _smartTurn.loading;
}

// Build (once) a TurnSense text-EoU scorer via transformers.js from CDN.
export function loadTurnSense(opts = {}) {
    if (_turnSense.scorer) return Promise.resolve(_turnSense.scorer);
    if (_turnSense.loading) return _turnSense.loading;
    _turnSense.loading = (async () => {
        try {
            // PORT: native Quest runs TurnSense as native ONNX or a server call.
            const tfSpec = opts.transformersModule ?? TURN_CDN.transformers;
            const tf = opts.transformers || await import(/* @vite-ignore */ tfSpec);
            const repo = opts.modelId ?? TURN_CDN.turnSenseModel;
            // TODO(phase4): confirm TurnSense's transformers.js task + label map.
            // It's a binary EoU classifier; "text-classification" with a COMPLETE/
            // INCOMPLETE label set is the expected pipeline. Verify the label that
            // means "utterance complete" and map its score to [0..1] below.
            const pipe = await tf.pipeline("text-classification", repo);
            const scorer = async (partialText) => {
                const t = (partialText || "").trim();
                if (!t) return null;                                 // nothing to judge → abstain
                const res = await pipe(t);
                const top = Array.isArray(res) ? res[0] : res;
                if (!top) return null;
                const complete = /complete|eou|end|finish/i.test(top.label || "");
                // Map to P(complete): the model gives P(top label); invert if the
                // top label is "incomplete".
                return complete ? top.score : 1 - top.score;
            };
            _turnSense.scorer = scorer;
            return scorer;
        } catch (e) {
            _turnSense.loading = null;
            if (typeof console !== "undefined") console.warn("[turn] TurnSense load failed; abstaining:", e?.message || e);
            return abstain;
        }
    })();
    return _turnSense.loading;
}

// Reset the memoised loaders (test/teardown only).
export function _resetModelCache() {
    _smartTurn = { scorer: null, loading: null };
    _turnSense = { scorer: null, loading: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// TurnDetector — the ensemble. The PUBLIC entry point is isTurnComplete(); the
// internal decide() does the deterministic fusion (kept separate so it's trivially
// unit-testable with fixed scorer outputs and no model/timer/Babylon in the way).
// ─────────────────────────────────────────────────────────────────────────────
export class TurnDetector {
    // opts:
    //   tuning           : overrides merged over TURN_TUNING (incl. use* flags).
    //   audioEouScore    : (audio16k:Float32Array) => Promise<number|null>
    //                      INJECT a Smart Turn scorer directly (bypasses the CDN
    //                      loader — used by tests + when the integration layer owns
    //                      the runtime). Takes precedence over useSmartTurn.
    //   textEouScore     : (partialText:string) => Promise<number|null>
    //                      INJECT a text EoU scorer directly (bypasses TurnSense +
    //                      the heuristic). Takes precedence over useTurnSense.
    //   smartTurnOpts /  : passed to loadSmartTurn() / loadTurnSense() when the
    //   turnSenseOpts      use* flags trigger an on-demand CDN load (e.g. to inject
    //                      an already-loaded ORT module).
    constructor(opts = {}) {
        this.T = { ...TURN_TUNING, ...(opts.tuning || {}) };
        this._injectedAudio = opts.audioEouScore || null;
        this._injectedText = opts.textEouScore || null;
        this._smartTurnOpts = opts.smartTurnOpts || {};
        this._turnSenseOpts = opts.turnSenseOpts || {};
    }

    // Inject (or clear) the audio EoU scorer AFTER construction. main.js builds the
    // Smart Turn scorer asynchronously (it loads wasm + the model + the mel matrix),
    // then calls this once it resolves — mirroring how createVad() is wired in after
    // the fact. An injected scorer takes precedence over the useSmartTurn CDN loader.
    // Pass null to revert to the on-demand / abstain path. PORT: the native scorer
    // loads async too (ONNX session init) and is injected through the same seam.
    setAudioScorer(fn) { this._injectedAudio = fn || null; }

    // ── PUBLIC API ──────────────────────────────────────────────────────────
    // Run at a VAD silence boundary. All fields optional; the detector always
    // returns a usable verdict from whatever signals it has.
    //   audio       : Float32Array — the buffered utterance, 16 kHz mono (for
    //                 Smart Turn). Omit to skip the audio scorer.
    //   partialText : string — the partial transcript so far (for TurnSense /
    //                 the heuristic text EoU). Omit to skip the text scorer.
    //   gazeHeld    : bool — is the player's gaze STILL held on the addressed
    //                 companion? false ⇒ gaze has left ⇒ a free turn-end signal.
    //                 Defaults to true (don't end on gaze if the caller doesn't
    //                 track it). Pass it from ctx.addressing.
    //   utteranceMs : number — measured length of this utterance in ms (drives the
    //                 min/max length guards). Defaults to 0.
    // Returns { complete: bool, confidence: number 0..1, reason, scores }.
    //   confidence is HOW SURE we are the turn ended (0..1); reason is one of
    //   "gaze" | "maxlen" | "audio+text" | "audio" | "text" | "heuristic" |
    //   "silence" | "keep"; scores are the raw model outputs (number|null) for
    //   logging / on-device threshold tuning. The reason for an end is HONEST about
    //   the deciding signal — a heuristic-driven end is "heuristic"/"text", never
    //   "model".
    async isTurnComplete({ audio, partialText, gazeHeld = true, utteranceMs = 0 } = {}) {
        const T = this.T;

        // 1. Gaze-leave — explicit "done", independent of length or model. Checked
        //    first and bypasses the min-length floor: looking away to end is a
        //    deliberate gesture even on a very short utterance.
        if (T.gazeLeaveEnds && gazeHeld === false) {
            return { complete: true, confidence: T.gazeLeaveConfidence, reason: "gaze",
                     scores: { audio: null, text: null } };
        }

        // 2. Hard length cap — force-end a runaway turn no matter what a stuck
        //    model says.
        if (utteranceMs >= T.maxUtteranceMs) {
            return { complete: true, confidence: T.maxlenConfidence, reason: "maxlen",
                     scores: { audio: null, text: null } };
        }

        // 3. Resolve the scorers (injected > on-demand model > heuristic/abstain),
        //    then run them concurrently. Each may abstain (null). The TEXT scorer
        //    reports its SOURCE ("model" for TurnSense/an injected scorer, or
        //    "heuristic" for the built-in EoU) so the ensemble can apply
        //    requireBothAgree among MODELS only and label an end honestly.
        const audioScorer = await this._resolveAudioScorer();
        const { scorer: textScorer, source: textSource } = await this._resolveTextScorer();
        const [aRaw, tRaw] = await Promise.all([
            audioScorer(audio),
            textScorer(partialText),
        ]);
        const scores = { audio: aRaw, text: tRaw };

        // 4. Below the min-length floor: refuse to end on model/silence evidence
        //    (gaze/maxlen above already handled their cases). A lip-smack isn't a
        //    whole turn.
        if (utteranceMs < T.minUtteranceMs) {
            return { complete: false, confidence: 0, reason: "keep", scores };
        }

        // 5. The VAD silence boundary is a TENTATIVE end: reaching here (past the
        //    min-length floor, with the VAD hangover already elapsed) IS an
        //    endpoint UNLESS a present scorer actively vetoes it. Gather votes from
        //    PRESENT scorers only (an abstaining/null scorer casts no vote).
        const audioPresent = aRaw != null;
        const textPresent = tRaw != null;
        const audioModel = audioPresent;                // audio is always a model signal
        const textModel = textPresent && textSource === "model";
        // Audio (Smart Turn) uses its OWN thresholds: a confident P(complete) ≥
        // audioCompleteThreshold drives an END vote; P < audioKeepThreshold is a
        // confident "mid-thought" KEEP-veto. The band between is "unsure" (no vote).
        const audioEnds = audioPresent && aRaw >= T.audioCompleteThreshold;
        const textEnds = textPresent && tRaw >= T.textEndThreshold;
        // A KEEP-VETO is a scorer POSITIVELY detecting "not done" — a continuation/
        // filled pause ("Let me see…"). This is what protects the pause; a merely-
        // unsure score (between the veto and end thresholds) does NOT veto. Audio uses
        // audioKeepThreshold (a separate low bound); the text/heuristic scorer uses
        // keepVetoThreshold (the word-heuristic is a SECONDARY keep-veto — a pause word
        // still holds the turn even if the prosody sounds done).
        const audioVeto = audioPresent && aRaw < T.audioKeepThreshold;
        const textVeto = textPresent && tRaw <= T.keepVetoThreshold;

        // 5a. KEEP-veto wins outright: if ANY present scorer says "not done", hold
        //     the silence boundary open and keep listening.
        if (audioVeto || textVeto) {
            return { complete: false, confidence: 0, reason: "keep", scores };
        }

        // 5b. ≥2 MODEL scorers present → apply requireBothAgree among the models to
        //     decide end-vs-keep (the conservative both-must-end gate). Only the
        //     models count here; the heuristic is a veto-only signal handled above.
        const modelCount = (audioModel ? 1 : 0) + (textModel ? 1 : 0);
        if (modelCount >= 2) {
            const end = T.requireBothAgree ? (audioEnds && textEnds) : (audioEnds || textEnds);
            if (!end) {
                return { complete: false, confidence: 0, reason: "keep", scores };
            }
            const conf = (aRaw + tRaw) / 2;
            return { complete: true, confidence: conf, reason: "audio+text", scores };
        }

        // 5c. No keep-veto and fewer than 2 models → the silence boundary STANDS.
        //     End on whatever signal carried it, labelled honestly. A lone present
        //     model that cleared its end threshold reports its own probability;
        //     otherwise it's the bare silence default (soft confidence).
        if (audioEnds && !textPresent) {
            return { complete: true, confidence: aRaw, reason: "audio", scores };
        }
        if (textEnds && textModel && !audioPresent) {
            return { complete: true, confidence: tRaw, reason: "text", scores };
        }
        if (textEnds && !textModel) {
            // Heuristic (non-veto, reads finished) carried the end.
            return { complete: true, confidence: T.defaultConfidence, reason: "heuristic", scores };
        }

        // 6. ROBUST DEFAULT — no veto, no end-vote that cleared threshold. The VAD
        //    already enforced its min-silence hangover, so past the min-length floor
        //    this trailing silence IS the endpoint. End on the silence default with
        //    a soft confidence.
        return { complete: true, confidence: T.defaultConfidence, reason: "silence", scores };
    }

    // Pick the audio scorer: injected → on-demand Smart Turn (if enabled, kicks the
    // lazy load and abstains until warm) → abstain.
    async _resolveAudioScorer() {
        if (this._injectedAudio) return this._injectedAudio;
        if (this.T.useSmartTurn) {
            if (_smartTurn.scorer) return _smartTurn.scorer;
            loadSmartTurn(this._smartTurnOpts);          // fire-and-forget; warms for next turn
            return abstain;                              // abstain THIS turn (cold)
        }
        return abstain;
    }

    // Pick the text scorer: injected → on-demand TurnSense (if enabled) → built-in
    // heuristic (if enabled) → abstain. Returns { scorer, source } where source is
    // "model" (injected scorer / TurnSense — counts toward requireBothAgree) or
    // "heuristic" (the built-in EoU — a veto-only signal, never an end-vote model).
    async _resolveTextScorer() {
        if (this._injectedText) return { scorer: this._injectedText, source: "model" };
        if (this.T.useTurnSense) {
            if (_turnSense.scorer) return { scorer: _turnSense.scorer, source: "model" };
            loadTurnSense(this._turnSenseOpts);          // fire-and-forget; warms for next turn
            // Fall through to the heuristic while the model is cold so text still votes.
        }
        if (this.T.useHeuristicText) return { scorer: async (t) => heuristicTextEou(t), source: "heuristic" };
        return { scorer: abstain, source: "heuristic" };
    }
}

// Module-level convenience: a shared detector for the simple case where the caller
// just wants `await isTurnComplete({...})` without managing an instance. Uses the
// default tuning + the built-in heuristic; opt models in via TURN_TUNING flags or
// use a `new TurnDetector(opts)` for per-call-site config.
const _shared = new TurnDetector();
export function isTurnComplete(args) { return _shared.isTurnComplete(args); }
