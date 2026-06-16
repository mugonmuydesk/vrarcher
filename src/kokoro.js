// On-device TTS backend (Kokoro-82M) — an OFFLINE, no-proxy alternative to the
// Gemini cloud voice in gemini.js. Drop-in for VoiceChat: exposes the SAME two
// functions the adapter consumes —
//   kokoroSpeak(text)            -> { samples: Float32Array(-1..1), sampleRate }
//   kokoroSpeakStream(text,{onChunk}) -> fires onChunk(samples, sampleRate) per
//                                        sentence, resolves with { sampleRate,
//                                        totalSamples }.
// so main.js can swap Gemini ⇄ Kokoro without touching voicechat.js.
//
// Scope: this replaces ONLY the text-to-speech step. Speech-to-text and the
// dialogue brain still run through Gemini (gemini.js). Kokoro is TTS-only.
//
// How it runs: Kokoro-82M (82M-param ONNX) runs via transformers.js (ONNX
// Runtime Web, WASM) inside a dedicated Web Worker (kokoro-worker.js), so all
// inference is OFF the page's main thread and never stalls the XR render loop.
// This module is the thin main-thread shim: it spawns the worker and proxies
// load/speak/stream over postMessage, handing voicechat the same
// {samples,sampleRate} / onChunk contract as before. No Babylon: a platform
// service, like gemini.js. (WASM threads kick in for extra speed when the page
// is cross-origin isolated — itch's "SharedArrayBuffer support" toggle / local
// COOP+COEP headers; otherwise it's a single-threaded worker, still off-main.)
//
// FULLY OFFLINE / self-contained: the kokoro-js web bundle, the ONNX-Runtime
// wasm, the 88 MB model and the voice packs are all VENDORED under
// vendor/kokoro/ and ship in the build — nothing is fetched from HuggingFace or
// jsDelivr at play time. The vendored bundle (vendor/kokoro/lib/kokoro.web.js)
// is patched so its model / voice / wasm fetches resolve to those local paths
// (see vendor/kokoro/README.md for the exact patches). Paths are page-relative
// so they work both on localhost and inside itch.io's game iframe.
//
// PORT NOTES (native Quest): kokoro-js/transformers.js are web-only. On native
// the equivalent is the same ONNX model run through ONNX Runtime Mobile or the
// QNN/NNAPI execution provider on the Hexagon NPU — which, unlike WebGPU here,
// does NOT contend with the renderer for the GPU. The text→{samples,rate}
// contract stays identical, so voicechat's port is unaffected by the swap.

export const KOKORO_TUNING = {
    // Model id the bundle resolves against its vendored local model dir. Only
    // the q8 weights (model_quantized.onnx) are vendored, so keep dtype "q8".
    model: "onnx-community/Kokoro-82M-v1.0-ONNX",
    // Weight precision ↔ download size / quality (Kokoro-82M-v1.0-ONNX, exact
    // file sizes from the hub):
    //   "fp32" 310 MB (best)  "fp16" 156 MB  "q8" 88 MB (good default)
    //   "q4f16" 147 MB        "q4" 291 MB (NOT smaller — unpacked int4, avoid)
    // q8 is the sweet spot; only go smaller via a q8f16 export (~82 MB).
    // Downloaded once and cached by the browser; +~a few hundred KB per voice.
    dtype: "q8",
    // Forced to "wasm" (in the worker): ONNX-Runtime's WebGPU backend miscomputes
    // Kokoro on the small/quantized models (q8 → corrupted "foreign-sounding"
    // audio; verified on hardware) and q8's integer ops aren't GPU-accelerated
    // anyway. WASM q8 is the proven-correct path and is what the filler bank is
    // baked against, so the baked pauses seam seamlessly with live synthesis. A
    // working GPU path would need transformers.js v4 + an fp32 model (≈310 MB);
    // a future option, not wired here. PORT: native Quest runs this on a
    // background thread / ONNX Runtime Mobile.
    device: "wasm",
    // Preset voice closest to Wren (youthful British female). Alternatives:
    // bf_isabella (B), bf_alice / bf_lily (C). No custom-voice cloning in Kokoro.
    voice: "bf_emma",
    speed: 1.0,             // 1.0 = natural pace; >1 faster, <1 slower
    sampleRate: 24000,      // Kokoro always outputs 24 kHz mono
};

let _worker = null;     // the synthesis worker (kokoro-worker.js)
let _loadP = null;      // in-flight model-load promise (shared)
let _ready = false;     // model loaded in the worker
let _device = null;     // "wasm" (informational; the worker forces WASM)
let _seq = 0;           // message id counter
const _pending = new Map();  // id → { resolve, reject, onChunk? }

// True once the model is loaded in the worker and ready to synthesise.
export function kokoroReady() { return _ready; }
// The execution device in use ("wasm" | null before load).
export function kokoroDevice() { return _device; }

// Spawn the worker (once) and route its replies to the matching pending call.
function _ensureWorker() {
    if (_worker) return _worker;
    _worker = new Worker(new URL("./kokoro-worker.js", import.meta.url), { type: "module" });
    _worker.onmessage = (e) => {
        const m = e.data, p = _pending.get(m.id);
        if (!p) return;
        switch (m.type) {
            case "loaded": _ready = true; _device = m.device; _pending.delete(m.id); p.resolve(); break;
            case "speak": _pending.delete(m.id); p.resolve({ samples: m.samples, sampleRate: m.rate }); break;
            case "chunk": p.onChunk?.(m.samples, m.rate); break;  // mid-stream; keep pending
            case "streamDone": _pending.delete(m.id); p.resolve({ sampleRate: m.rate, totalSamples: m.totalSamples }); break;
            case "error": _pending.delete(m.id); p.reject(new Error(m.err)); break;
        }
    };
    // A worker-level failure (script/module error) fires here with no message id,
    // so reject ALL in-flight calls and tear the worker down — otherwise
    // loadKokoro/speak would hang forever. Next call respawns a fresh worker.
    _worker.onerror = (e) => {
        const err = new Error("kokoro worker error: " + (e.message || "unknown"));
        for (const [, p] of _pending) p.reject(err);
        _pending.clear();
        _ready = false; _loadP = null;
        try { _worker.terminate(); } catch { /* ignore */ }
        _worker = null;
    };
    return _worker;
}

// Post a message and get a promise for its reply. `onChunk` (stream only) fires
// per chunk before the promise resolves on streamDone.
function _call(msg, onChunk) {
    const id = ++_seq;
    const w = _ensureWorker();
    return new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject, onChunk });
        w.postMessage({ ...msg, id });
    });
}

// Load the model in the worker (once). Call early to warm before the first turn.
// `base` is the absolute game-root URL the (worker-side) bundle resolves its
// vendored model/voice/wasm paths against — page-relative so it works on
// localhost and inside itch's iframe alike.
export async function loadKokoro(opts = {}) {
    if (_ready) return;
    if (_loadP) return _loadP;
    const base = new URL("./", document.baseURI).href;
    _loadP = _call({
        type: "load", base,
        model: opts.model ?? KOKORO_TUNING.model,
        dtype: opts.dtype ?? KOKORO_TUNING.dtype,
    });
    try { await _loadP; }
    catch (e) { _loadP = null; throw e; }   // allow a retry on failure
}

// Whole-clip synthesis (the VoiceChat fallback path). { samples, sampleRate }.
export async function kokoroSpeak(text, { voice = KOKORO_TUNING.voice, speed = KOKORO_TUNING.speed } = {}) {
    await loadKokoro();
    return _call({ type: "speak", text, voice, speed });
}

// Streaming synthesis: fires onChunk(samples, sampleRate) per sentence as the
// worker renders it, so playback can begin on the first sentence. Resolves with
// { sampleRate, totalSamples }. Throws on load/synth error so VoiceChat can fall
// back to kokoroSpeak. (Kokoro renders a whole utterance at once, so a sentence
// is the natural streaming chunk.)
export async function kokoroSpeakStream(text, { voice = KOKORO_TUNING.voice, speed = KOKORO_TUNING.speed, onChunk } = {}) {
    await loadKokoro();
    return _call({ type: "stream", text, voice, speed }, onChunk);
}
