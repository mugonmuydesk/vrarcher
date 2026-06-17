// Voice inference worker — runs the Tier-1 on-device voice MODELS (TEN-VAD /
// Silero VAD + Smart Turn v3 + TurnSense) OFF the page's main thread, so neither
// the per-frame VAD nor the per-endpoint turn-detector inference ever stalls the
// XR render loop. The main-thread shim (voiceworker.js) talks to this worker by
// message; this worker only loads models + runs inference and posts results back.
// No Babylon, no AudioContext, no DOM here.
//
// WHY a worker we own (not ORT's wasm.proxy): ONNX-Runtime's built-in proxy worker
// fails to initialise with the vendored jsep build (the long-standing "wasm.proxy
// is broken" finding — see the Kokoro note + kokoro-worker.js). Kokoro already
// sidesteps it by hosting ORT in its OWN module worker; this file applies the
// IDENTICAL pattern to VAD + the turn detector. ORT then runs on THIS worker's
// thread (still proxy=false — we don't want a nested ORT proxy), so the inference
// is off the render thread while keeping the proven, working ORT init path.
//
// The heavy lifting is the EXISTING engine-clean factories, imported unchanged and
// just run here instead of on main — so node regression tests and the native port
// (which transcribes those same factories) are untouched. The factories resolve
// vendored asset paths via document.baseURI, which is ABSENT in a worker; we feed
// them ABSOLUTE URLs (built from the page base the shim sends) as opts, which the
// factories' abs() helpers pass through unchanged when document is missing.
//
// PORT: native Quest moves this inference to a background thread / ONNX Runtime
// Mobile; this worker is the web stand-in for that.

import { createVad } from "./vad.js";
import { createSmartTurnScorer } from "./smartturn.js";
import { createTurnSenseScorer } from "./turnsense.js";

let _base = "";              // absolute game-root URL (ends "/"), set by 'init'
let _vad = null;            // the worker-side VadService (createVad result)
let _audioScorer = null;    // Smart Turn scorer (audio16k) => Promise<number|null>
let _textScorer = null;     // TurnSense scorer (text) => Promise<number|null>

// Absolute-URL helper: vendored assets live under the page root, NOT under this
// worker's own URL, so resolve them against the base the shim handed us.
const A = (p) => _base + p;

self.onmessage = async (e) => {
    const m = e.data;
    try {
        switch (m.type) {
            // ── one-time: stash the page base the factories resolve assets against.
            case "init": {
                _base = m.base || "";
                break;
            }

            // ── build the VAD worker-side. Its gate's callbacks POST events back to
            //    main; the shim re-emits them to whatever voicechat wired on its proxy
            //    gate. createVad NEVER throws (it falls back to energy-RMS internally),
            //    so this resolves with whatever backend came up.
            case "vadCreate": {
                const opts = m.opts || {};
                _vad = await createVad({
                    ...opts,
                    // Absolute vendored paths (no document in a worker — see header).
                    base: A("vendor/vad/"),
                    ortModule: A("vendor/vad/ort.wasm.min.mjs"),
                    tenBase: A("vendor/ten-vad/"),
                    onSpeechStart: (ev) => self.postMessage({ type: "vadEvent", kind: "start", ev, prob: _vad?.prob ?? 0 }),
                    onSpeechEnd: (ev) => self.postMessage({ type: "vadEvent", kind: "end", ev, prob: _vad?.prob ?? 0 }),
                    onBargeIn: (ev) => self.postMessage({ type: "vadEvent", kind: "bargein", ev, prob: _vad?.prob ?? 0 }),
                    // Per-frame probability for the HUD meter (npchud reads vad.prob).
                    onProb: (prob) => self.postMessage({ type: "vadProb", prob }),
                });
                self.postMessage({ type: "reply", id: m.id, backend: _vad.backend });
                break;
            }

            // ── per mic frame: run the model + gate worker-side (fire-and-forget; the
            //    gate's events come back via vadEvent). Frame buffer is transferred in.
            case "vadFeed": {
                if (_vad && m.frame) _vad.feed(m.frame).catch(() => { /* model hiccup → next frame */ });
                break;
            }

            // ── mic sample-rate (keeps the resample/hangover math honest on 44.1 kHz).
            case "vadRate": {
                if (_vad) _vad.inputRate = m.rate;
                break;
            }

            // ── companion-speaking gate for barge-in (voicechat toggles it around TTS).
            case "vadCompanion": {
                if (_vad) _vad.setCompanionSpeaking(m.on);
                break;
            }

            // ── lazily build the Smart Turn (audio EoU) scorer. THROWS on load failure
            //    so the shim falls back to its main-thread path; mirrors main.js today.
            case "loadAudio": {
                if (!_audioScorer) {
                    _audioScorer = await createSmartTurnScorer({
                        ortModule: A("vendor/vad/ort.wasm.min.mjs"),
                        ortWasmDir: A("vendor/vad/"),
                        modelUrl: A("vendor/smart-turn/smart-turn-v3.2-cpu.onnx"),
                        melUrl: A("vendor/smart-turn/mel_80_201.json"),
                    });
                }
                self.postMessage({ type: "reply", id: m.id });
                break;
            }

            // ── lazily build the TurnSense (text EoU) scorer (opt-in, ~176 MB int8).
            case "loadText": {
                if (!_textScorer) {
                    _textScorer = await createTurnSenseScorer({
                        ortModule: A("vendor/vad/ort.wasm.min.mjs"),
                        ortWasmDir: A("vendor/vad/"),
                        modelUrl: A("vendor/turnsense/model_quantized.onnx"),
                        tokenizerUrl: A("vendor/turnsense/tokenizer.json"),
                    });
                }
                self.postMessage({ type: "reply", id: m.id });
                break;
            }

            // ── score one utterance (audio16k transferred in) → P(complete)|null.
            case "scoreAudio": {
                const score = _audioScorer ? await _audioScorer(m.audio) : null;
                self.postMessage({ type: "reply", id: m.id, score });
                break;
            }

            // ── score one partial transcript → P(complete)|null.
            case "scoreText": {
                const score = _textScorer ? await _textScorer(m.text) : null;
                self.postMessage({ type: "reply", id: m.id, score });
                break;
            }
        }
    } catch (err) {
        // Request/reply messages carry an id → reject the matching pending call so the
        // shim can fall back. Fire-and-forget messages (vadFeed/vadRate/vadCompanion)
        // have no id; swallow (a single dropped frame is harmless).
        if (m && m.id != null) self.postMessage({ type: "reply", id: m.id, error: String((err && err.message) || err) });
    }
};
