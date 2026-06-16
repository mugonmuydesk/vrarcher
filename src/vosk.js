// On-device, in-browser STT — Vosk (Kaldi compiled to WebAssembly, via
// ccoreilly/vosk-browser). This is the OFFLINE, no-cloud speech-to-text option
// for the "everything on-device" product tier. The DEFAULT STT path stays
// Gemini cloud (src/gemini.js geminiTranscribe + src/stt-stream.js); Vosk is
// lazy-loaded only when explicitly selected (main.js ctx.setSttBackend("vosk")),
// because the model is ~40 MB and must never load on the default path.
//
// WHY a separate adapter: the voice loop (src/voicechat.js) holds an injectable
// `this.transcribe`. Swapping `ctx.voicechat.transcribe` to the Vosk transcriber
// is all it takes to move STT on-device — same audio-in / text-out contract.
//
// ENGINE-CLEAN (load-bearing — see CLAUDE.md "Portability"): this file has NO
// Babylon and NO top-level vosk-browser import. The 5.8 MB vosk-browser bundle
// (worker + WASM, all inlined) is LAZY-imported inside createVoskTranscriber, so
// this module parses/imports cleanly in node (no Worker / document / WebAssembly
// at parse time). The whole file is node-importable; the browser-only bits are
// guarded behind that lazy load.
//
// PORT: the native Quest port uses Vosk's native library (libvosk) or the
// platform STT (Meta/Android on-device recogniser). Same contract — 16 kHz mono
// PCM in, recognised text out — so only this adapter is web-specific. The 16 kHz
// resample (resampleLinear) and the Float32→recogniser handoff transcribe
// directly; the AudioBuffer wrapper below is a Web-Audio quirk (see PORT note on
// _toAudioBuffer) with a trivial native equivalent (feed the raw PCM array).
//
// VENDORED (page-relative, fully offline — nothing fetched from a CDN at play
// time, so it works inside itch's game iframe):
//   vendor/vosk/vosk.js              vosk-browser 0.0.8 UMD bundle (~5.8 MB) —
//                                    worker + WASM are base64-inlined into this
//                                    one file (no separate .wasm/.worker.js to
//                                    vendor; the worker is built from a Blob via
//                                    URL.createObjectURL, the WASM is atob()'d).
//   vendor/vosk/model/model.tar.gz   vosk-model-small-en-us-0.15 (~40 MB) — the
//                                    official small US-English model, repackaged
//                                    as the .tar.gz that createModel() expects
//                                    (alphacephei ships it as a .zip; we re-tar'd
//                                    it, preserving the top-level model dir).
//
// vosk-browser API used (confirmed against ccoreilly/vosk-browser 0.0.8):
//   import * as Vosk from 'vendor/vosk/vosk.js'   (UMD → ESM namespace exposes
//                                                  createModel + Model)
//   const model = await Vosk.createModel(modelTarGzUrl)   // downloads + untars
//   const rec = new model.KaldiRecognizer(16000 [, grammarJSON])
//   rec.acceptWaveformFloat(float32, sampleRate)  // Float32 [-1,1] + its rate;
//       // scales to Kaldi's int16 range internally. (acceptWaveform(audioBuffer)
//       // wants a Web Audio AudioBuffer — we use the Float variant to avoid the
//       // OfflineAudioContext detour; see _feed() for the AudioBuffer fallback.)
//   rec.on('result',        m => m.result.text)     // final text for a segment
//   rec.on('partialresult', m => m.result.partial)  // in-progress text
//   rec.retrieveFinalResult() — flush the tail at end of utterance (some builds
//       // name it differently; we fall back to a trailing silence flush).

// ─────────────────────────────────────────────────────────────────────────────
// Tuning / config — native-port re-tuning checklist. Paths are page-relative and
// resolved to absolute URLs against document.baseURI at load (a bare "vendor/…"
// specifier can't be import()'d, and an absolute URL also keeps the bundle's
// worker/WASM load working inside itch's iframe — same idiom as vad.js/kokoro.js).
// ─────────────────────────────────────────────────────────────────────────────
export const VOSK_TUNING = {
    sampleRate: 16000,               // Hz — recogniser rate; utterance audio is resampled to this
    bundle: "vendor/vosk/vosk.js",   // vosk-browser 0.0.8 (worker+WASM inlined)
    model: "vendor/vosk/model/model.tar.gz", // vosk-model-small-en-us-0.15 (.tar.gz)
    logLevel: -1,                    // vosk-browser/Kaldi log verbosity (-1 = quiet; 0 = info)
    // Trailing silence appended after the utterance so Kaldi flushes the final
    // segment even if the audio ends mid-word (cheap, deterministic end-of-stream).
    flushSilenceMs: 300,
};

// Lazy import of the heavy vad.js resampler — vad.js itself is engine-clean and
// node-safe, but we still keep this module's TOP-LEVEL import list empty of
// anything browser-only. resampleLinear is pure, so importing it at top level is
// fine; do so for a simple synchronous call site.
import { resampleLinear } from "./vad.js";

// Module-level cache: the model + bundle load ONCE and are shared across every
// transcriber built in this page. createVoskTranscriber returns lightweight
// handles over this shared model; the 40 MB download/untar happens a single time.
let _voskModulePromise = null;   // Promise<VoskNamespace>
let _modelPromise = null;        // Promise<Model>

// Resolve a page-relative path to an absolute URL (guarded for node, where there
// is no document — the function still imports, it just can't load the bundle).
function _abs(p) {
    const base = (typeof document !== "undefined" && document.baseURI) ? document.baseURI : undefined;
    return base ? new URL(p, base).href : p;
}

// Lazy-load the vosk-browser bundle (UMD → ESM namespace). Cached.
async function _loadVoskModule(bundleUrl) {
    if (_voskModulePromise) return _voskModulePromise;
    if (typeof Worker === "undefined") {
        // No Worker (node, or a context with workers disabled) → Vosk can't run.
        throw new Error("vosk: Web Worker unavailable in this environment");
    }
    _voskModulePromise = (async () => {
        const mod = await import(/* @vite-ignore */ bundleUrl);
        // vosk-browser is a UMD bundle: imported as an ES module it has NO ESM
        // exports — it installs a GLOBAL `Vosk` ({ Model, createModel }) on
        // window/globalThis instead. Check the namespace/.default first (in case a
        // future build adds ESM exports), then fall back to the global.
        const g = (typeof globalThis !== "undefined" ? globalThis : self);
        const Vosk = (mod && typeof mod.createModel === "function") ? mod
            : (mod?.default && typeof mod.default.createModel === "function") ? mod.default
            : (g.Vosk && typeof g.Vosk.createModel === "function") ? g.Vosk
            : mod;
        if (typeof Vosk.createModel !== "function") {
            throw new Error("vosk: bundle did not export createModel (no ESM export and no global Vosk)");
        }
        return Vosk;
    })();
    return _voskModulePromise;
}

// Lazy-load (download + untar + init) the model. Cached — one load per page.
async function _loadModel({ bundleUrl, modelUrl, logLevel }) {
    if (_modelPromise) return _modelPromise;
    _modelPromise = (async () => {
        const Vosk = await _loadVoskModule(bundleUrl);
        // createModel(modelUrl, logLevel) fetches the .tar.gz, untars into the
        // worker's Emscripten FS and brings the recogniser up. ~40 MB + untar →
        // this is the slow step; it runs once and is shared.
        const model = await Vosk.createModel(modelUrl, logLevel);
        return model;
    })().catch((e) => {
        // Reset so a later attempt can retry (e.g. transient fetch failure) rather
        // than being stuck on a poisoned cached rejection.
        _modelPromise = null;
        throw e;
    });
    return _modelPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// createVoskTranscriber(opts) — async; lazily loads vosk-browser + the model and
// returns an on-device STT handle. THROWS on load failure so callers (main.js)
// can fall back to Gemini. Babylon/ORT are never imported.
//
// opts: { bundle, model, sampleRate, logLevel } — all default to VOSK_TUNING.
//
// Returns:
//   {
//     ready: true,
//     sampleRate,                       // recogniser rate (16000)
//     transcribe(audio, sampleRate?) => Promise<string>
//         // audio may be a Float32Array of mono PCM (sampleRate defaults to
//         // VOSK_TUNING.sampleRate=16000 — pass the ACTUAL rate if different and
//         // it's resampled), OR a WAV byte buffer (Uint8Array/ArrayBuffer), so it
//         // ALSO drops straight into voicechat's `this.transcribe(rec.wav)` call.
//     createStream({ onPartial, onFinal }) => { pushAudio(f32, rate?), stop() }
//         // optional streaming handle for live partials (same model, fresh recog).
//     dispose()                          // free the recogniser-pool / model refs.
//   }
// ─────────────────────────────────────────────────────────────────────────────
export async function createVoskTranscriber(opts = {}) {
    const sampleRate = opts.sampleRate ?? VOSK_TUNING.sampleRate;
    const bundleUrl = _abs(opts.bundle ?? VOSK_TUNING.bundle);
    const modelUrl = _abs(opts.model ?? VOSK_TUNING.model);
    const logLevel = opts.logLevel ?? VOSK_TUNING.logLevel;

    const model = await _loadModel({ bundleUrl, modelUrl, logLevel });

    // Run a whole utterance through a FRESH KaldiRecognizer and return the joined
    // final text. A fresh recogniser per utterance keeps state clean (no bleed
    // between turns); construction is cheap relative to the one-time model load.
    async function transcribe(audio, audioRate) {
        const { mono, rate } = _coerceMono(audio, audioRate ?? sampleRate);
        if (!mono || !mono.length) return "";
        // Resample to the recogniser rate if needed (resampleLinear no-ops on equal
        // rates). Vosk wants the recogniser's configured rate.
        const at = rate === sampleRate ? mono : resampleLinear(mono, rate, sampleRate);

        const rec = new model.KaldiRecognizer(sampleRate);
        const seg = _collect(rec);              // collects 'result' events; gives a flush()
        try {
            _feed(rec, at, sampleRate);
            // Append a short trailing silence so Kaldi closes the final segment even
            // when the utterance ends mid-word, then ask the worker to flush + wait
            // for the final 'result' to arrive (retrieveFinalResult returns void; the
            // text comes back as an async event — see _collect).
            const tail = Math.floor((VOSK_TUNING.flushSilenceMs / 1000) * sampleRate);
            if (tail > 0) _feed(rec, new Float32Array(tail), sampleRate);
            return await seg.flush();
        } finally {
            _remove(rec);
        }
    }

    // Optional streaming handle: feed frames live, get partials, then a final on
    // stop(). One recogniser for the whole stream. Cheap to add — same model.
    function createStream({ onPartial, onFinal } = {}) {
        // Delegate to the shared recogniser wiring (also used by VoskSttStream).
        return createStreamOnModel(model, sampleRate, { onPartial, onFinal });
    }

    return {
        ready: true,
        sampleRate,
        transcribe,
        createStream,
        // The shared model is intentionally NOT terminated here (other transcribers
        // may share it); call disposeVoskModel() to tear the worker down fully.
        dispose() { /* per-transcriber handles are stateless; nothing to free */ },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// VoskSttStream — an on-device, LIVE-PARTIALS streaming transcriber that matches
// the cloud SttStream (src/stt-stream.js) interface 1:1, so voicechat.js drives
// it UNCHANGED. Where SttStream re-transcribes a growing buffer over the cloud,
// this feeds a single Vosk KaldiRecognizer frame-by-frame and surfaces Kaldi's
// own 'partialresult' events as partials — true incremental on-device ASR, no
// network.
//
// Interface (identical to SttStream):
//   start({ sampleRate, onPartial, onFinal })  — begin an utterance. sampleRate is
//        the mic capture rate (e.g. 48 kHz); frames are resampled to 16 kHz before
//        feeding Kaldi. onPartial(text) fires as Kaldi revises the in-progress
//        transcript; onFinal(text) (optional) fires when stop() resolves.
//   pushAudio(float32MonoFrame)  — feed one mono Float32 frame at the start()
//        sampleRate. Resampled to 16 kHz and fed to the recogniser. No-op if not
//        running. (Note: no per-frame rate arg — matches SttStream; the rate is
//        fixed at start().)
//   async stop() => finalText  — flush the recogniser's tail, return Kaldi's final
//        transcript, fire onFinal. Safe when not running (resolves "").
//   cancel()  — barge-in: drop the recogniser, fire NO onFinal, idempotent, never
//        throws.
//
// FAILURE-DEGRADE: the Vosk model is lazy-loaded on the FIRST start() (shared with
// createVoskTranscriber via the module-level cache, so it's already warm when this
// is wired in by main.js after createVoskTranscriber resolved). If the load fails
// at start() time, this DEGRADES GRACEFULLY: it logs a warning and runs as a no-op
// stream (no partials, stop() returns ""). It does NOT throw out of start()/
// pushAudio()/stop(), so the hands-free loop never breaks — the turn simply yields
// no on-device transcript that round (main.js only swaps this in once the model is
// confirmed loaded, so this is the belt-and-braces path).
//
// ENGINE-CLEAN: no Babylon; the heavy vosk-browser worker/bundle stays lazy
// (createStream is built on demand inside start(), which awaits the cached model).
// PORT: maps onto a native streaming recogniser (libvosk partial results / the
// platform on-device recogniser) — same start/pushAudio/onPartial/stop contract.
export class VoskSttStream {
    constructor(opts = {}) {
        this._opts = opts;                  // { bundle, model, sampleRate, logLevel } overrides
        this._recRate = opts.sampleRate ?? VOSK_TUNING.sampleRate; // recogniser rate (16 kHz)
        this._stream = null;                // the createStream() handle for this utterance
        this._rate = this._recRate;         // mic capture rate (set in start())
        this._epoch = 0;                    // bumped on stop()/cancel() so stale starts no-op
        this._onPartial = null;
        this._onFinal = null;
        this.running = false;
    }

    onPartial(fn) { this._onPartial = fn; return this; }
    onFinal(fn) { this._onFinal = fn; return this; }

    // Begin an utterance. Sets running TRUE immediately so pushAudio() buffers from
    // the first frame; the recogniser is built asynchronously (the model is already
    // cached/warm in practice) and any frames pushed before it's ready are queued
    // and flushed in order once it resolves. On load failure → degrade to no-op.
    start({ sampleRate, onPartial, onFinal } = {}) {
        if (onPartial) this._onPartial = onPartial;
        if (onFinal) this._onFinal = onFinal;
        if (sampleRate) this._rate = sampleRate;
        this._epoch++;
        const epoch = this._epoch;
        this.running = true;
        this._stream = null;
        this._pending = [];                 // frames pushed before the recogniser is ready
        const bundleUrl = _abs(this._opts.bundle ?? VOSK_TUNING.bundle);
        const modelUrl = _abs(this._opts.model ?? VOSK_TUNING.model);
        const logLevel = this._opts.logLevel ?? VOSK_TUNING.logLevel;
        // Build the recogniser. The model load is cached (one per page); when main.js
        // wires this in after createVoskTranscriber() resolved, this resolves fast.
        this._ready = _loadModel({ bundleUrl, modelUrl, logLevel })
            .then((model) => {
                if (epoch !== this._epoch) return;   // stopped/cancelled before ready
                const stream = createStreamOnModel(model, this._recRate, {
                    onPartial: (t) => { if (epoch === this._epoch && this._onPartial) this._onPartial(t); },
                });
                this._stream = stream;
                // Flush any frames buffered while the recogniser was coming up.
                if (this._pending) { for (const f of this._pending) stream.pushAudio(f, this._recRate); }
                this._pending = null;
            })
            .catch((e) => {
                // Degrade: no recogniser → no partials, stop() returns "". Never throw.
                console.warn("[vosk] VoskSttStream load failed; degrading to no-op (no on-device partials):", e?.message || e);
                this._stream = null;
                this._pending = null;
            });
    }

    // Feed one mono Float32 frame at the start() sampleRate. Resampled to the
    // recogniser rate (16 kHz) and fed to Kaldi (or queued if not ready). No-op when
    // not running. Copies nothing extra — resampleLinear allocates the 16 kHz frame.
    pushAudio(pcm) {
        if (!this.running || !pcm || !pcm.length) return;
        const at = this._rate === this._recRate ? pcm : resampleLinear(pcm, this._rate, this._recRate);
        if (this._stream) this._stream.pushAudio(at, this._recRate);
        else if (this._pending) this._pending.push(at);   // queued until the recogniser is ready
    }

    // Stop capturing, flush the recogniser tail, return Kaldi's final transcript and
    // fire onFinal(text). Safe to call when not running (resolves ""). Awaits the
    // recogniser-ready promise first so a stop() issued while the model is still
    // loading still finalises (the build completes, then we flush it). Unlike
    // cancel(), stop() does NOT bump _epoch before the build, so an in-flight
    // start().then() still constructs the recogniser for this same utterance.
    async stop() {
        if (!this.running) return "";
        this.running = false;
        try { await this._ready; } catch { /* load already degraded */ }
        let text = "";
        if (this._stream) {
            try { text = await this._stream.stop(); } catch (e) { /* recogniser flush failed */ }
        }
        this._epoch++;                      // now silence any further partials/late starts
        this._stream = null;
        this._pending = null;
        this._onFinal?.(text);
        return text || "";
    }

    // Barge-in: drop the utterance, fire NO onFinal, idempotent, never throws.
    cancel() {
        this.running = false;
        this._epoch++;                      // stale partial/final results now ignored
        // Best-effort flush-and-discard the recogniser so its worker resources free;
        // we don't await it and we swallow everything (a cancelled turn yields no text).
        const s = this._stream;
        this._stream = null;
        this._pending = null;
        if (s) { try { Promise.resolve(s.stop()).catch(() => {}); } catch { /* ignore */ } }
    }
}

// Build a streaming handle directly on an already-loaded model (factored out of
// createVoskTranscriber.createStream so VoskSttStream can reuse the exact same
// recogniser wiring without going through the transcriber façade). Returns
// { pushAudio(f32, rate?), stop() => Promise<finalText> }.
function createStreamOnModel(model, sampleRate, { onPartial, onFinal } = {}) {
    const rec = new model.KaldiRecognizer(sampleRate);
    const seg = _collect(rec);
    if (onPartial) rec.on("partialresult", (m) => { const p = m?.result?.partial; if (p) onPartial(p); });
    let stopped = false;
    return {
        pushAudio(f32, rate) {
            if (stopped || !f32 || !f32.length) return;
            const r = rate ?? sampleRate;
            const at = r === sampleRate ? f32 : resampleLinear(f32, r, sampleRate);
            _feed(rec, at, sampleRate);
        },
        async stop() {
            if (stopped) return seg.text();
            stopped = true;
            const tail = Math.floor((VOSK_TUNING.flushSilenceMs / 1000) * sampleRate);
            if (tail > 0) _feed(rec, new Float32Array(tail), sampleRate);
            const text = await seg.flush();
            _remove(rec);
            onFinal && onFinal(text);
            return text;
        },
    };
}

// Tear down the shared Vosk worker + model and clear the caches, so a later
// createVoskTranscriber() reloads from scratch. Safe to call when nothing loaded.
export async function disposeVoskModel() {
    const p = _modelPromise;
    _modelPromise = null;
    _voskModulePromise = null;
    if (!p) return;
    try {
        const model = await p;
        if (model && typeof model.terminate === "function") model.terminate();
    } catch { /* never loaded / already gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals (pure-ish helpers; the only browser dependency is the recogniser API
// and OfflineAudioContext in the AudioBuffer fallback).
// ─────────────────────────────────────────────────────────────────────────────

// Feed a Float32 mono frame to the recogniser. Prefer acceptWaveformFloat(float32,
// rate) — it takes the raw Float32 directly (scaling to int16 internally). If a
// build only exposes acceptWaveform(AudioBuffer), wrap the PCM in a Web Audio
// AudioBuffer (PORT: native feeds the raw PCM array; the AudioBuffer is purely a
// browser-API shape).
function _feed(rec, f32, rate) {
    if (typeof rec.acceptWaveformFloat === "function") {
        rec.acceptWaveformFloat(f32, rate);
        return;
    }
    // Fallback: acceptWaveform wants a Web Audio AudioBuffer (mono, recog rate).
    const ab = _toAudioBuffer(f32, rate);
    rec.acceptWaveform(ab);
}

// Build a mono Web Audio AudioBuffer from a Float32Array at `rate`. Used only on
// the acceptWaveform(AudioBuffer) fallback path. PORT: no native equivalent
// needed — the native recogniser takes the raw PCM array directly.
function _toAudioBuffer(f32, rate) {
    const OAC = (typeof OfflineAudioContext !== "undefined") ? OfflineAudioContext
        : (typeof webkitOfflineAudioContext !== "undefined") ? webkitOfflineAudioContext : null;
    if (!OAC) throw new Error("vosk: no OfflineAudioContext for the AudioBuffer fallback");
    const ctx = new OAC(1, Math.max(1, f32.length), rate);
    const buf = ctx.createBuffer(1, f32.length, rate);
    buf.copyToChannel ? buf.copyToChannel(f32, 0) : buf.getChannelData(0).set(f32);
    return buf;
}

// Attach a 'result' collector to a recogniser and return { flush(), text() }.
//
// The worker emits 'result' events ASYNCHRONOUSLY as Kaldi closes each segment;
// retrieveFinalResult() is a fire-and-forget message (returns void) that makes
// the worker close + emit the LAST segment. So flush() posts retrieveFinalResult()
// and resolves when that final 'result' arrives — or after a safety timeout, in
// case the worker emitted everything already (silence-only utterance → no final
// event). text() joins whatever segments have been collected so far.
function _collect(rec) {
    const segs = [];
    let onResult = null;            // set while flush() is awaiting the final event
    rec.on("result", (m) => {
        const t = m?.result?.text;
        if (t) segs.push(t);
        if (onResult) onResult();   // a result after retrieveFinalResult() → done
    });
    const text = () => segs.join(" ").replace(/\s+/g, " ").trim();
    const flush = () => new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; onResult = null; clearTimeout(timer); resolve(text()); };
        onResult = finish;
        // Safety net: if no further 'result' arrives (e.g. the only audio was the
        // trailing silence), resolve on the timeout with what we have.
        const timer = setTimeout(finish, 1500);
        try {
            if (typeof rec.retrieveFinalResult === "function") rec.retrieveFinalResult();
            else finish();          // no flush method → trailing silence already closed it
        } catch { finish(); }
    });
    return { flush, text };
}

// Free a recogniser instance (build-dependent name; ignore if absent).
function _remove(rec) {
    try { if (typeof rec.remove === "function") rec.remove(); } catch { /* ignore */ }
}

// Coerce assorted audio inputs to { mono: Float32Array, rate } so transcribe()
// can accept BOTH the task's Float32-mono contract AND voicechat's WAV-bytes
// `this.transcribe(rec.wav)` call. Recognises:
//   • Float32Array            → used as-is at the given rate.
//   • Uint8Array / ArrayBuffer that is a RIFF/WAVE → decoded (16-bit PCM) to
//     Float32 mono at the WAV's own sample rate (overrides the passed rate).
//   • {samples, sampleRate}   → e.g. a decoded clip object.
function _coerceMono(audio, rate) {
    if (audio instanceof Float32Array) return { mono: audio, rate };
    if (audio && audio.samples instanceof Float32Array) {
        return { mono: audio.samples, rate: audio.sampleRate || rate };
    }
    const bytes = (audio instanceof Uint8Array) ? audio
        : (audio instanceof ArrayBuffer) ? new Uint8Array(audio)
        : (ArrayBuffer.isView(audio)) ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
        : null;
    if (bytes && _isWav(bytes)) return _decodeWav(bytes);
    if (bytes) {
        // Unknown byte buffer — best-effort treat as already-float? No: refuse so a
        // caller doesn't silently transcribe garbage.
        throw new Error("vosk.transcribe: byte buffer is not a recognised WAV");
    }
    throw new Error("vosk.transcribe: pass a Float32Array, a WAV buffer, or {samples,sampleRate}");
}

// RIFF/WAVE magic check ("RIFF"…"WAVE").
function _isWav(b) {
    return b.length > 44 &&
        b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
        b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;  // WAVE
}

// Minimal 16-bit PCM WAV decoder → { mono: Float32[-1,1], rate }. Mirrors the
// encoder in stt-stream.js/speech.js (PCM 16-bit, the format voicechat produces);
// downmixes to mono if the WAV is stereo. Pure + node-testable.
function _decodeWav(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Walk the chunks to find 'fmt ' and 'data' (don't assume a fixed 44-byte head).
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= dv.byteLength) {
        const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
        const size = dv.getUint32(off + 4, true);
        const body = off + 8;
        if (id === "fmt ") {
            fmt = {
                audioFormat: dv.getUint16(body, true),
                channels: dv.getUint16(body + 2, true),
                rate: dv.getUint32(body + 4, true),
                bits: dv.getUint16(body + 14, true),
            };
        } else if (id === "data") {
            dataOff = body; dataLen = size;
        }
        off = body + size + (size & 1); // chunks are word-aligned
    }
    if (!fmt || dataOff < 0) throw new Error("vosk: malformed WAV (no fmt/data chunk)");
    if (fmt.bits !== 16) throw new Error("vosk: only 16-bit PCM WAV supported (got " + fmt.bits + ")");
    const ch = Math.max(1, fmt.channels);
    const frames = Math.floor(dataLen / 2 / ch);
    const out = new Float32Array(frames);
    let p = dataOff;
    for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) { acc += dv.getInt16(p, true); p += 2; }
        const s = acc / ch / 0x8000;       // average channels → mono, scale to [-1,1)
        out[i] = s < -1 ? -1 : (s > 1 ? 1 : s);
    }
    return { mono: out, rate: fmt.rate };
}
