// Main-thread shim for the voice inference worker (voice-worker.js) — the thin
// proxy layer that lets the rest of the app drive on-device VAD + turn detection
// WITHOUT the model inference touching the render thread. Mirrors kokoro.js (the
// proven worker+proxy pattern): spawn one module worker, route replies by id, and
// expose drop-in replacements for the main-thread factories.
//
// Three exports, each a behavior-identical stand-in for an existing builder:
//   createVadProxy(opts)        ↔ createVad(opts)            (vad.js)
//   loadWorkerAudioScorer()     ↔ createSmartTurnScorer()    (smartturn.js)
//   loadWorkerTextScorer()      ↔ createTurnSenseScorer()    (turnsense.js)
//
// The VAD proxy mirrors only the CONSUMER surface voicechat.js / npchud.js use —
// feed(), a plain .gate with onSpeechStart/End/BargeIn slots, .prob, .backend,
// .inputRate, setCompanionSpeaking() — so those callers are untouched.
//
// STRICTLY BETTER-OR-EQUAL: if the worker can't spawn or a model fails to build in
// it, each builder FALLS BACK to the original main-thread factory (dynamic-imported
// on demand). Worst case is exactly today's behavior (inference on main); best case
// is off-main. No path is worse than before.
//
// PORT: native Quest replaces this whole shim with a direct call into a background
// inference thread; the proxied contracts (feed/score) match the native seams.

let _worker = null;            // the voice-worker.js instance
let _seq = 0;                  // request id counter
const _pending = new Map();    // id → { resolve, reject }
let _vadProxy = null;          // the single live VadProxy (target for vadEvent/vadProb)

// Spawn the worker once and route its messages. Replies (request/response) carry an
// id and resolve the matching pending call; vadEvent/vadProb are unsolicited and go
// to the live VAD proxy.
function _ensureWorker() {
    if (_worker) return _worker;
    _worker = new Worker(new URL("./voice-worker.js", import.meta.url), { type: "module" });
    _worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "reply") {
            const p = _pending.get(m.id);
            if (!p) return;
            _pending.delete(m.id);
            if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
            return;
        }
        if (m.type === "vadEvent") { _vadProxy && _vadProxy._onEvent(m.kind, m.ev, m.prob); return; }
        if (m.type === "vadProb") { if (_vadProxy) _vadProxy.prob = m.prob; return; }
    };
    // A worker-level failure (module/script error) fires with no id → reject ALL
    // in-flight calls (so their callers fall back) and tear the worker down. Live
    // fire-and-forget posts (feed/rate/companion) then no-op until a fresh spawn.
    _worker.onerror = (e) => {
        const err = new Error("voice worker error: " + (e.message || "unknown"));
        for (const [, p] of _pending) p.reject(err);
        _pending.clear();
        try { _worker.terminate(); } catch { /* ignore */ }
        _worker = null;
    };
    // Page base the worker resolves vendored asset paths against — page-relative so
    // it works on localhost AND inside the itch game iframe (same idiom as kokoro.js).
    const base = (typeof document !== "undefined" && document.baseURI)
        ? new URL("./", document.baseURI).href : "";
    _worker.postMessage({ type: "init", base });
    return _worker;
}

// Request/response: post with an id, resolve on the matching reply (reject on error).
function _call(msg, transfer) {
    const id = ++_seq;
    const w = _ensureWorker();
    return new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
        w.postMessage({ ...msg, id }, transfer || []);
    });
}

// Fire-and-forget post (no reply). No-op if the worker died (degrade, don't throw).
function _post(msg, transfer) {
    if (!_worker) return;
    _worker.postMessage(msg, transfer || []);
}

// ─────────────────────────────────────────────────────────────────────────────
// VadProxy — mirrors the VadService consumer surface (vad.js), backed by the worker.
// voicechat.js sets gate.onSpeechStart/End/BargeIn and calls feed/inputRate/
// setCompanionSpeaking; npchud.js reads backend/prob. All satisfied here.
// ─────────────────────────────────────────────────────────────────────────────
class VadProxy {
    constructor(backend) {
        this.backend = backend;          // "tenvad" | "silero" | "rms" (from the worker)
        this.prob = 0;                   // latest P(speech) (HUD meter) — from vadProb/vadEvent
        this.gate = { onSpeechStart: null, onSpeechEnd: null, onBargeIn: null };
        this._inputRate = 48000;
    }
    get inputRate() { return this._inputRate; }
    set inputRate(r) { this._inputRate = r; _post({ type: "vadRate", rate: r }); }

    // One raw mic frame → the worker's VadService. Transfers the buffer (zero-copy);
    // voicechat passes a fresh Float32Array per call so detaching it is safe. Returns
    // a resolved promise (events arrive async via vadEvent) so callers can .catch().
    feed(frame) {
        if (frame && frame.buffer) _post({ type: "vadFeed", frame }, [frame.buffer]);
        return Promise.resolve();
    }
    setCompanionSpeaking(on) { _post({ type: "vadCompanion", on: !!on }); }

    // Dispatch a worker gate event to whatever voicechat wired on this proxy's gate.
    _onEvent(kind, ev, prob) {
        if (typeof prob === "number") this.prob = prob;
        const cb = kind === "start" ? this.gate.onSpeechStart
            : kind === "end" ? this.gate.onSpeechEnd
            : kind === "bargein" ? this.gate.onBargeIn : null;
        cb && cb(ev);
    }
}

// createVad(opts) drop-in: build the VAD in the worker; on any worker failure fall
// back to the main-thread createVad (same object surface) so VAD always works.
export async function createVadProxy(opts = {}) {
    try {
        // Strip non-cloneable opts (callbacks like onFallback can't be postMessage'd;
        // the worker wires the gate callbacks itself and createVad handles fallback).
        const safeOpts = {};
        for (const k of Object.keys(opts)) if (typeof opts[k] !== "function") safeOpts[k] = opts[k];
        const reply = await _call({ type: "vadCreate", opts: safeOpts });
        _vadProxy = new VadProxy(reply.backend);
        return _vadProxy;
    } catch (e) {
        console.warn("[voiceworker] VAD worker unavailable; running VAD on the main thread:", e?.message || e);
        const { createVad } = await import("./vad.js");
        return createVad(opts);
    }
}

// createSmartTurnScorer() drop-in: load the audio EoU scorer in the worker and
// return a proxy scorer (audio16k)=>Promise<number|null>. On worker load failure
// fall back to the main-thread scorer (which itself throws if it can't load, so the
// caller's existing .catch still degrades the turn detector to abstain).
export async function loadWorkerAudioScorer() {
    try {
        await _call({ type: "loadAudio" });
        return (audio16k) => {
            if (!_worker) return Promise.resolve(null);
            const t = (audio16k && audio16k.buffer) ? [audio16k.buffer] : [];
            return _call({ type: "scoreAudio", audio: audio16k }, t).then((r) => r.score ?? null, () => null);
        };
    } catch (e) {
        console.warn("[voiceworker] Smart Turn worker load failed; using the main-thread scorer:", e?.message || e);
        const { createSmartTurnScorer } = await import("./smartturn.js");
        return createSmartTurnScorer();
    }
}

// createTurnSenseScorer() drop-in (opt-in, ~176 MB int8). Same fallback contract as
// the audio scorer above.
export async function loadWorkerTextScorer() {
    try {
        await _call({ type: "loadText" });
        return (text) => {
            if (!_worker) return Promise.resolve(null);
            return _call({ type: "scoreText", text }).then((r) => r.score ?? null, () => null);
        };
    } catch (e) {
        console.warn("[voiceworker] TurnSense worker load failed; using the main-thread scorer:", e?.message || e);
        const { createTurnSenseScorer } = await import("./turnsense.js");
        return createTurnSenseScorer();
    }
}
