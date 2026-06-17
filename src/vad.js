// Voice-activity detection (VAD) — the companion's "is the player talking, and
// have they finished?" sense. Phase 2a of the companion-voice roadmap: this is
// the engine-clean DECISION half. It turns a stream of per-frame speech
// probabilities (from the Silero VAD ONNX model) into three high-level events
// the dialogue loop cares about: speech ONSET, speech END (a *candidate*
// endpoint after a silence hangover), and BARGE-IN (the player starting to talk
// while the companion is still speaking, so we can cut the companion off).
//
// Why Silero, why here: the warm mic (src/speech.js) taps raw Float32 mono at
// the AudioContext rate (~48 kHz). Silero v5 wants fixed 512-sample frames at
// 16 kHz, so the pipeline is: mic frames -> resample 48k->16k -> accumulate into
// 512-sample frames -> run the model per frame -> feed the prob into a hysteresis
// state machine. Everything except the model call is pure and node-testable.
//
// ENGINE-CLEAN (load-bearing — see CLAUDE.md "Portability"): this file has NO
// Babylon and NO top-level onnxruntime/onnx import, so it imports cleanly in
// node and the framing math is unit-testable without a browser. The ONLY
// browser-touching parts are VadService + the loaders below, and even there the
// model inference is INJECTED (`runModel`) rather than statically imported —
// onnxruntime-web is LAZY-imported inside the loader so this module never pulls
// it in at parse time (the Kokoro memory note warns ORT's jsep wasm.proxy is
// broken, so we vendor the lean NON-jsep wasm backend instead).
//
// BACKENDS: the DEFAULT is now TEN-VAD (gain-robust; recognizes the real quiet
// browser mic where Silero v5 scored near-silence — eval on the same audio: TEN-VAD
// max 0.98 / mean 0.60 vs Silero max ~0.12). Silero ('silero') is kept for
// clean-audio / native use; energy-RMS ('rms') is the never-fail fallback.
//
// GRACEFUL FALLBACK (CRITICAL — vad must ALWAYS work): createVad() loads the chosen
// model backend (TEN-VAD or Silero) via its vendored wasm. If anything goes wrong
// (import fails, files 404, wasm can't init, WASM blocked in the iframe…), it falls
// back to a pure energy-RMS speech detector (rmsRunModel) instead of throwing. The
// same VadService / gate / events run on top of any backend, so the dialogue loop
// never cares which one it got — only `service.backend` ("tenvad" | "silero" |
// "rms") reports which is live. RMS is lower quality (no model, fooled by loud
// non-speech) but means the companion can always hear you.
//
// VENDORED (page-relative, ship in the build — nothing fetched at play time):
//   vendor/ten-vad/ten_vad.js               TEN-VAD Emscripten glue (~5.6 KB)
//   vendor/ten-vad/ten_vad.wasm             TEN-VAD model + STFT/mel + VAD (~283 KB)
//   vendor/vad/silero_vad.onnx              Silero VAD v5 (~2.3 MB, see contract)
//   vendor/vad/ort.wasm.min.mjs             onnxruntime-web 1.22.0 ESM (wasm-only)
//   vendor/vad/ort-wasm-simd-threaded.mjs   wasm backend loader
//   vendor/vad/ort-wasm-simd-threaded.wasm  wasm backend (~11 MB)
// Documented factories build `runModel`: buildTenVadRunModel (TEN-VAD) and
// buildOrtRunModel (Silero/onnxruntime-web). Both are lazy-imported.
//
// MODEL CONTRACT — vendor/vad/silero_vad.onnx (Silero VAD v5):
//   size 2,327,524 bytes
//   sha256 1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
//   opset 16 (ai.onnx)
//   INPUTS:
//     input  float32 [1, 512]    one 512-sample frame of 16 kHz mono PCM
//     state  float32 [2, 1, 128] recurrent LSTM state, carried call-to-call
//     sr     int64   scalar      sample rate (16000 — also accepts 8000 @ 256)
//   OUTPUTS:
//     output float32 [1, 1]      P(speech) for this frame, 0..1
//     stateN float32 [2, 1, 128] updated state to pass into the next call
//   The state must be reset (zeros) at the start of each new utterance/session;
//   VadService.reset() does this.
//
// PORT: the native Quest port uses an equivalent VAD (Silero again, or the
// platform/Meta voice-focus VAD). The probability source changes; the gate
// state machine + VAD_TUNING thresholds below transcribe directly, and the
// resampler/accumulator map to whatever the native mic frame size is.

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — native-port re-tuning checklist. Spec values are starting points;
// expect to re-tune against a real mic in-headset (the threshold/timing gate is
// an explicit human VERIFY step, not an autonomous one).
// ─────────────────────────────────────────────────────────────────────────────
export const VAD_TUNING = {
    sampleRate: 16000,        // Hz — model's required input rate (mic ~48k is downsampled to this)
    frameSamples: 512,        // samples per model frame @ 16 kHz (fixed by Silero v5 → 32 ms/frame)
    onsetThreshold: 0.5,      // prob ≥ this declares the START of speech (hysteresis high water mark)
    offsetThreshold: 0.35,    // prob < this counts as silence (hysteresis low water mark; < onset so a steady-state voice near threshold doesn't chatter)
    minSpeechMs: 120,         // ms — speech shorter than this is a blip (cough/click), never fires an onset
    minSilenceMs: 800,        // ms — trailing silence (hangover) required before we declare a candidate endpoint; gives the player room to pause mid-sentence (raised from 500 in-headset: 500 chopped sentences on natural pauses)
    preRollMs: 200,           // ms — audio kept BEFORE the onset so the utterance start isn't clipped when handed to STT (consumed by the integration layer; informs the ring buffer it must keep). NOTE: the live look-back is VOICE_TUNING.preRollSec (voicechat) = 2 s, larger than this
    bargeInMinSpeechMs: 150,  // ms — sustained speech while the companion is talking before we flag a barge-in (interrupt). Slightly above minSpeechMs: an interrupt should be a touch more deliberate than a fresh onset to avoid the companion's own audio bleed tripping it

    // ── Energy-RMS gate (the DEFAULT backend for the web build — see createVad) ──
    // A loudness-based P(speech): map frame RMS through a floor/ceil ramp. Chosen
    // over Silero on real browser mics (Silero scored live mic speech ~0.07 vs ~0.65
    // on clean TTS, so it never crossed onset). Any loud sound reads as "speech", so
    // gaze-gating (only listen while addressing an NPC) carries the "is this for me".
    rmsFloor: 0.008,          // RMS at/below this → prob 0 (room tone / quiet mic noise); 0.008 picks up quieter speech tails than the old 0.012
    rmsCeil: 0.12,            // RMS at/above this → prob 1 (clearly someone talking)
};

// Convenience: ms-per-frame at the configured frame size + rate (32 ms for 512@16k).
export const FRAME_MS = (VAD_TUNING.frameSamples / VAD_TUNING.sampleRate) * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// PURE CORE 1 — VadGate: the hysteresis + min-speech + min-silence state machine.
//
// Fed ONE model probability per frame via push(prob[, frameMs]). Tracks:
//   • speaking      — bool, true between a confirmed onset and its candidate end
//   • onset/end events — emitted via the callbacks passed to the constructor, or
//     readable from the {events} return of push()/the .lastEvents accessor.
//   • barge-in      — when companion-speaking is signalled (setCompanionSpeaking
//     true), sustained speech for ≥ bargeInMinSpeechMs raises a one-shot bargeIn
//     event so the caller can cut the companion off.
//
// Deterministic, no audio, no ORT, no timers — time advances only by the frame
// durations you feed it, so tests can drive it frame-by-frame.
// ─────────────────────────────────────────────────────────────────────────────
export class VadGate {
    // opts: { onsetThreshold, offsetThreshold, minSpeechMs, minSilenceMs,
    //         bargeInMinSpeechMs, onSpeechStart, onSpeechEnd, onBargeIn }
    // Any threshold/timing omitted falls back to VAD_TUNING.
    constructor(opts = {}) {
        const t = VAD_TUNING;
        this.onsetThreshold = opts.onsetThreshold ?? t.onsetThreshold;
        this.offsetThreshold = opts.offsetThreshold ?? t.offsetThreshold;
        this.minSpeechMs = opts.minSpeechMs ?? t.minSpeechMs;
        this.minSilenceMs = opts.minSilenceMs ?? t.minSilenceMs;
        this.bargeInMinSpeechMs = opts.bargeInMinSpeechMs ?? t.bargeInMinSpeechMs;
        this.onSpeechStart = opts.onSpeechStart || null;
        this.onSpeechEnd = opts.onSpeechEnd || null;
        this.onBargeIn = opts.onBargeIn || null;
        this.reset();
    }

    reset() {
        this.speaking = false;          // confirmed (post-onset) speech in progress
        this._companionSpeaking = false;
        this._bargeInFired = false;     // one-shot per companion-speaking span
        this._candidateMs = 0;          // ms of provisional speech accumulated before onset is confirmed
        this._speechMs = 0;             // ms of speech accumulated since companion-speaking began (barge-in counter)
        this._silenceMs = 0;            // ms of trailing silence accumulated while speaking (hangover counter)
        this._elapsedMs = 0;            // total ms fed (timestamps on events)
        this.lastEvents = [];
    }

    // Tell the gate whether the companion is currently speaking. Barge-in is only
    // evaluated while this is true; toggling it resets the one-shot latch.
    setCompanionSpeaking(on) {
        on = !!on;
        if (on !== this._companionSpeaking) {
            this._companionSpeaking = on;
            this._bargeInFired = false;
            this._speechMs = 0;
        }
    }

    // Advance one frame. `prob` is P(speech) for this frame; `frameMs` defaults to
    // FRAME_MS. Returns the array of events emitted this frame (may be empty);
    // event shapes: { type:'onset'|'end'|'bargein', atMs }.
    push(prob, frameMs = FRAME_MS) {
        this._elapsedMs += frameMs;
        const events = [];
        const high = prob >= this.onsetThreshold;
        const low = prob < this.offsetThreshold;
        // Between the two thresholds (offset ≤ prob < onset) is the hysteresis
        // band: treated as "continue current state" — neither starts nor ends.

        // ── Barge-in: independent of the main onset gate so an interrupt is caught
        //    even before a full onset would be confirmed. Only while companion talks.
        if (this._companionSpeaking && !this._bargeInFired) {
            if (high) {
                this._speechMs += frameMs;
                if (this._speechMs >= this.bargeInMinSpeechMs) {
                    this._bargeInFired = true;
                    const ev = { type: 'bargein', atMs: this._elapsedMs };
                    events.push(ev);
                    this.onBargeIn && this.onBargeIn(ev);
                }
            } else if (low) {
                this._speechMs = 0; // interrupt must be sustained, not flickery
            }
        }

        // ── Main onset/endpoint gate.
        if (!this.speaking) {
            // Accumulating toward a confirmed onset.
            if (high) {
                this._candidateMs += frameMs;
                if (this._candidateMs >= this.minSpeechMs) {
                    this.speaking = true;
                    this._silenceMs = 0;
                    const ev = { type: 'onset', atMs: this._elapsedMs };
                    events.push(ev);
                    this.onSpeechStart && this.onSpeechStart(ev);
                }
            } else if (low) {
                this._candidateMs = 0; // the blip didn't reach minSpeech → forget it
            }
            // hysteresis band while not speaking: hold the candidate counter as-is.
        } else {
            // Speaking: watch for a sustained silence (the hangover) → candidate end.
            if (low) {
                this._silenceMs += frameMs;
                if (this._silenceMs >= this.minSilenceMs) {
                    this.speaking = false;
                    this._candidateMs = 0;
                    this._silenceMs = 0; // clear hangover too → fully clean post-endpoint state
                    const ev = { type: 'end', atMs: this._elapsedMs };
                    events.push(ev);
                    this.onSpeechEnd && this.onSpeechEnd(ev);
                }
            } else if (high) {
                this._silenceMs = 0; // speech resumed → reset hangover
            }
            // hysteresis band while speaking: hold the silence counter as-is.
        }

        this.lastEvents = events;
        return events;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE CORE 2 — resample48kTo16k / resampleLinear: mono Float32 downsample.
//
// BUG HISTORY (the "Silero scores all speech as ~0" bug): the original version of
// this function decimated by plain LINEAR interpolation with NO anti-alias
// low-pass. For a downsample (e.g. 48 kHz mic → 16 kHz, or a 24 kHz TTS clip →
// 16 kHz) that folds every spectral component above the 8 kHz output Nyquist back
// DOWN into the voice band. The resampled audio stays LOUD (high RMS) but is
// spectrally garbled — and Silero, which keys on the spectral shape of speech,
// then scores even clear loud speech at ~0.0005. A deterministic node ONNX
// harness over the baked Gemini speech WAVs confirmed it: naive-linear capped a
// voiced clip's peak P(speech) at ~0.05, while low-passing first lifted the same
// clip to ~0.47–0.65 (a 6–13× jump across voiced clips). The model invocation
// (buildOrtRunModel: sr/input/state dtypes + shapes + state threading) was never
// at fault — verified identical output across sr-scalar/sr-1D and onnxruntime-node
// vs the vendored onnxruntime-web.
//
// FIX: when DOWNSAMPLING, low-pass at the output Nyquist with a windowed-sinc
// kernel (the resample and the anti-alias filter in one pass). Upsampling can't
// alias, so that path stays plain linear interpolation. Pure, allocation only of
// the output; node-testable.
//
// PORT: a native port should resample with the platform's own resampler (which is
// anti-aliased) — the point is just "low-pass before you decimate, never raw
// linear". Voice energy sits below 8 kHz, but the energy ABOVE it is exactly what
// aliases into the band and breaks the VAD, so it must be removed first.
// ─────────────────────────────────────────────────────────────────────────────

// Resample a mono Float32Array from inRate to outRate.
//   • outRate ≥ inRate (upsample / no change): plain linear interpolation — no
//     aliasing is possible, so a low-pass would only blur.
//   • outRate < inRate (downsample): a windowed-sinc low-pass at the output
//     Nyquist, evaluated at each fractional source position, doing the decimation
//     and the anti-alias filtering together. WITHOUT this, high-frequency content
//     aliases into the voice band and Silero scores even loud speech as silence.
export function resampleLinear(input, inRate, outRate) {
    if (!(input && input.length)) return new Float32Array(0);
    if (inRate === outRate) return input.slice();
    const ratio = inRate / outRate;       // input samples advanced per output sample
    const outLen = Math.round(input.length / ratio);
    const out = new Float32Array(outLen);
    const last = input.length - 1;

    if (ratio <= 1) {
        // Upsampling (or equal rate): no aliasing risk → plain linear interpolation.
        for (let i = 0; i < outLen; i++) {
            const pos = i * ratio;
            const i0 = Math.floor(pos);
            const frac = pos - i0;
            const a = input[i0];
            const b = i0 < last ? input[i0 + 1] : a;
            out[i] = a + (b - a) * frac;
        }
        return out;
    }

    // Downsampling: low-pass at the OUTPUT Nyquist while resampling. The kernel is
    // a Hann-windowed sinc whose cutoff (in cycles per INPUT sample) is 0.5/ratio =
    // (outRate/2)/inRate. `taps` lobes either side widen as we decimate harder so
    // the transition band stays sharp (e.g. 8 taps at 1.5×, 24 at 3×). The window
    // and the sinc gain (2·fc) together keep DC unity for an unclipped signal.
    const fc = 0.5 / ratio;                // cutoff, cycles per input sample
    const taps = Math.max(8, Math.ceil(ratio * 8)); // half-width of the kernel
    for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;             // fractional source position
        const start = Math.ceil(pos - taps);
        const end = Math.floor(pos + taps);
        let acc = 0;
        for (let idx = start; idx <= end; idx++) {
            if (idx < 0 || idx > last) continue;
            const t = pos - idx;           // distance to source sample, in input samples
            const x = 2 * fc * t;
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            const win = 0.5 + 0.5 * Math.cos(Math.PI * t / taps); // Hann over [-taps, taps]
            acc += input[idx] * (2 * fc * sinc * win);
        }
        out[i] = acc;
    }
    return out;
}

// Common case: 48 kHz mic → 16 kHz model input.
export function resample48kTo16k(input) {
    return resampleLinear(input, 48000, VAD_TUNING.sampleRate);
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE CORE 3 — FrameAccumulator: re-chunk a stream of variable-size frames into
// fixed-size frames (default 512). The mic delivers ~4096-sample blocks that,
// after resampling to 16 kHz, are an arbitrary length; the model needs exactly
// 512. push() returns however many complete 512-frames are now available
// (possibly zero, possibly several), buffering the remainder for next time.
// Pure, node-testable.
// ─────────────────────────────────────────────────────────────────────────────
export class FrameAccumulator {
    constructor(frameSamples = VAD_TUNING.frameSamples) {
        this.frameSamples = frameSamples;
        this._buf = new Float32Array(0);
    }

    reset() { this._buf = new Float32Array(0); }

    // Append `samples` (Float32Array) and return an array of complete
    // frameSamples-length Float32Arrays now ready (each a fresh copy).
    push(samples) {
        const merged = new Float32Array(this._buf.length + samples.length);
        merged.set(this._buf, 0);
        merged.set(samples, this._buf.length);
        const frames = [];
        let off = 0;
        while (merged.length - off >= this.frameSamples) {
            frames.push(merged.slice(off, off + this.frameSamples));
            off += this.frameSamples;
        }
        this._buf = merged.slice(off); // keep the tail
        return frames;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER — VadService (the ONLY browser-touching part).
//
// Glues resampler → accumulator → injected runModel → VadGate. Feed it raw mic
// frames (Float32 mono at `inputRate`, default 48000) via feed(); it resamples,
// re-chunks to 512, runs the model (managing the Silero recurrent state), and
// drives the gate, firing onSpeechStart/onSpeechEnd/onBargeIn.
//
// `runModel` is INJECTED so engine-clean code and node tests never import ORT:
//   runModel(frame512: Float32Array, state: Float32Array[2*1*128])
//     => Promise<{ prob: number, state: Float32Array }>
// Build one from onnxruntime-web with buildOrtRunModel() below, or supply a Web
// Worker-backed equivalent in Phase 2b.
// ─────────────────────────────────────────────────────────────────────────────
export class VadService {
    // opts: { runModel (required), inputRate=48000, frameSamples (default 512;
    //         TEN-VAD passes 256), onSpeechStart, onSpeechEnd, onBargeIn,
    //         gate (optional VadGate opts) }
    constructor(opts = {}) {
        if (typeof opts.runModel !== 'function') {
            throw new Error('VadService: runModel(frame, state) callback is required');
        }
        this._runModel = opts.runModel;
        this.inputRate = opts.inputRate ?? 48000;
        // Frame size is per-backend: Silero/RMS use 512 (32 ms @ 16 kHz), TEN-VAD
        // uses 256 (16 ms). The gate is ms-based so it works at either size — we
        // just feed it the matching frameMs. Default keeps the Silero/RMS contract.
        this._frameSamples = opts.frameSamples ?? VAD_TUNING.frameSamples;
        this._frameMs = (this._frameSamples / VAD_TUNING.sampleRate) * 1000;
        this._acc = new FrameAccumulator(this._frameSamples);
        this._gate = new VadGate({
            ...(opts.gate || {}),
            onSpeechStart: opts.onSpeechStart,
            onSpeechEnd: opts.onSpeechEnd,
            onBargeIn: opts.onBargeIn,
        });
        this._state = newSileroState();
        this._busy = false; // serialise model calls (recurrent state must stay ordered)
        this.backend = opts.backend || 'silero'; // "silero" | "rms" — which runModel is live (informational)
        this.lastProb = 0;    // P(speech) of the most recent frame (0..1) — for HUD/meters
        this._onProb = opts.onProb || null; // optional per-frame probability callback (prob, atMs)
    }

    get gate() { return this._gate; }
    get speaking() { return this._gate.speaking; }
    // Most recent per-frame speech probability (0..1). Same name whichever backend
    // is live, so a level meter / HUD reads it without caring about Silero vs RMS.
    get prob() { return this.lastProb; }
    setCompanionSpeaking(on) { this._gate.setCompanionSpeaking(on); }

    // Reset the recurrent state + gate for a fresh utterance/session.
    reset() {
        this._acc.reset();
        this._gate.reset();
        this._state = newSileroState();
        this.lastProb = 0;
    }

    // Feed one raw mic frame (Float32 mono at inputRate). Resamples, accumulates,
    // and runs every complete 512-frame through the model + gate IN ORDER.
    // Returns a Promise resolving to the flat list of gate events fired.
    async feed(micFrame) {
        const at16k = resampleLinear(micFrame, this.inputRate, VAD_TUNING.sampleRate);
        const frames = this._acc.push(at16k);
        const allEvents = [];
        // Recurrent state must thread through frames sequentially — await each.
        for (const frame of frames) {
            const { prob, state } = await this._runModel(frame, this._state);
            if (state) this._state = state;
            this.lastProb = prob;
            const events = this._gate.push(prob, this._frameMs);
            this._onProb && this._onProb(prob, this._gate._elapsedMs);
            for (const e of events) allEvents.push(e);
        }
        return allEvents;
    }
}

// Fresh zeroed Silero recurrent state: [2,1,128] flattened to 256 floats.
export function newSileroState() {
    return new Float32Array(2 * 1 * 128);
}

// ─────────────────────────────────────────────────────────────────────────────
// runModel factory (DOCUMENTED, lazy-imported — NOT used by node tests).
//
// Builds a `runModel` for VadService from onnxruntime-web. ORT is imported
// lazily INSIDE the function so this module still parses/imports in node. The
// Phase 2b integration agent supplies the actual ORT module + the model URL/bytes
// (it owns the decision of fresh-ORT vs the existing Kokoro worker — see the
// memory note about ORT's broken wasm.proxy with the vendored jsep build).
//
// Usage (browser, integration layer):
//   import * as ort from '.../onnxruntime-web...';     // however 2b wires it
//   const runModel = await buildOrtRunModel({ ort, modelUrl: 'vendor/vad/silero_vad.onnx' });
//   const svc = new VadService({ runModel, onSpeechEnd, onSpeechStart, onBargeIn });
//
// `ort` may be passed in, or omitted to be dynamically imported from `ortModule`
// (a module specifier). The returned runModel matches VadService's contract.
// ─────────────────────────────────────────────────────────────────────────────
export async function buildOrtRunModel({ ort, ortModule, modelUrl, modelBytes } = {}) {
    // PORT: onnxruntime-web specifics. Native uses Silero's own runtime or the
    // platform VAD; only this factory changes.
    const ORT = ort || (ortModule ? await import(/* @vite-ignore */ ortModule) : null);
    if (!ORT) throw new Error('buildOrtRunModel: pass `ort` (module) or `ortModule` (specifier)');
    const src = modelBytes || modelUrl;
    if (!src) throw new Error('buildOrtRunModel: pass `modelUrl` or `modelBytes`');
    const session = await ORT.InferenceSession.create(src);
    const sr = new ORT.Tensor('int64', BigInt64Array.from([BigInt(VAD_TUNING.sampleRate)]), []);

    return async function runModel(frame512, state) {
        const inputT = new ORT.Tensor('float32', frame512, [1, frame512.length]);
        const stateT = new ORT.Tensor('float32', state, [2, 1, 128]);
        const out = await session.run({ input: inputT, state: stateT, sr });
        // PORT/ORT: copy the state out — onnxruntime-web may reuse/alias an output
        // tensor's backing buffer across session.run() calls, and this same array is
        // fed straight back in as the `state` INPUT next frame, so without the copy
        // the recurrent state silently corrupts. 256 floats; negligible cost.
        return { prob: out.output.data[0], state: out.stateN.data.slice() };
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEN-VAD runModel factory (DOCUMENTED, lazy-imported — NOT used by node tests).
//
// Builds a `runModel` for VadService from the vendored TEN-VAD WebAssembly bundle
// (TEN-framework/ten-vad, Apache-2.0). The Emscripten glue + model + STFT/mel
// front-end are all compiled INTO the wasm, so there's no external feature
// extraction and — unlike Silero — NO external recurrent state tensor: a single
// wasm VAD instance holds its state internally across process() calls. Frames must
// therefore be fed strictly in order through ONE instance (VadService.feed already
// awaits each frame sequentially).
//
// Input: 16 kHz mono Int16 PCM, 256-sample hops (16 ms/frame). We get Float32
// [-1,1] frames from VadService, so we convert to Int16 per call.
//
// The exact load + call sequence transcribes the repo's examples/test_browser.html:
//   const m = await import('.../ten_vad.js'); const mod = await m.default();
//   const hp = mod._malloc(4); mod._ten_vad_create(hp, 256, 0.5);
//   const h = HEAP32[hp>>2];                       // instance handle
//   // per frame: copy Int16 into wasm heap, then
//   mod._ten_vad_process(h, audioPtr, 256, probPtr, flagPtr);
//   const prob = HEAPF32[probPtr>>2];              // P(speech) 0..1
// (the upstream example reads prob/flag with vadModule.getValue, but getValue is
// NOT exported on this build — we read HEAPF32/HEAP32 directly, equivalent.)
//
// PORT: this whole factory is web-specific (Emscripten wasm). The native Quest
// port uses TEN-VAD's native library (or the platform VAD) directly; only this
// factory changes — the probability semantics (0..1, 0.5 onset) and the gate are
// identical.
// ─────────────────────────────────────────────────────────────────────────────
export async function buildTenVadRunModel({ jsUrl, wasmUrl, hopSize = 256, threshold = 0.5 } = {}) {
    if (!jsUrl) throw new Error('buildTenVadRunModel: pass `jsUrl` (vendored ten_vad.js URL)');
    const mod = await import(/* @vite-ignore */ jsUrl);
    // PORT: Emscripten module init. createVADModule()/default() returns the ready
    // module; locateFile makes the glue fetch the wasm next to the .js (absolute
    // URL) rather than from the page root — same idiom as the ORT wasmPaths above.
    const factory = mod.default || mod;
    const vad = await factory({
        locateFile: (path /*, prefix */) => (path.endsWith('.wasm') && wasmUrl) ? wasmUrl : path,
    });

    // Create one stateful VAD instance. _ten_vad_create(handlePtrOut, hop, thr)
    // returns 0 on success and writes the instance handle to *handlePtrOut.
    const handlePtr = vad._malloc(4);
    const rc = vad._ten_vad_create(handlePtr, hopSize, threshold);
    if (rc !== 0) { vad._free(handlePtr); throw new Error('ten-vad: _ten_vad_create failed rc=' + rc); }
    const handle = vad.HEAP32[handlePtr >> 2];

    // Scratch buffers reused every frame (one instance ⇒ no concurrency): the Int16
    // audio frame, and the float prob / int flag the wasm writes back.
    const audioPtr = vad._malloc(hopSize * 2); // Int16 = 2 bytes
    const probPtr = vad._malloc(4);            // float32 out
    const flagPtr = vad._malloc(4);            // int32 out

    // runModel(frame256Float32, _state) → { prob, state:_state }. State is internal
    // to the wasm instance; we just pass the caller's `_state` straight back so the
    // VadService threading contract is satisfied without a real external tensor.
    return async function runModel(frame, _state) {
        const n = frame.length; // expected hopSize (256)
        // Float32 [-1,1] → Int16 PCM, written straight into the wasm heap view.
        const base = audioPtr >> 1; // HEAP16 index (Int16 stride)
        for (let i = 0; i < n; i++) out_i16(vad.HEAP16, base + i, frame[i]);
        vad._ten_vad_process(handle, audioPtr, hopSize, probPtr, flagPtr);
        const prob = vad.HEAPF32[probPtr >> 2];
        return { prob, state: _state };
    };
}

// Float32 [-1,1] sample → Int16 [-32768,32767], clamped, written to a HEAP16 view.
// Pure helper, node-testable: ±1.0 → ±32767, 0 → 0. Exported for the smoke test.
export function out_i16(heap16, idx, f) {
    let s = f < -1 ? -1 : (f > 1 ? 1 : f);
    heap16[idx] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
}

// Convert a Float32 [-1,1] frame to a fresh Int16Array (same mapping as out_i16).
// Pure + node-testable — used by the smoke test and as a standalone converter.
export function floatFrameToInt16(frame) {
    const out = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
        let s = frame[i];
        s = s < -1 ? -1 : (s > 1 ? 1 : s);
        out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENERGY-RMS FALLBACK — rmsRunModel.
//
// A runModel (same contract as the Silero one) that derives a crude P(speech)
// from frame loudness alone: RMS mapped through the rmsFloor→rmsCeil ramp in
// VAD_TUNING. No model, no ORT, no recurrent state (the `state` arg is ignored
// and echoed back). PURE + node-testable. Used by createVad() ONLY when Silero
// fails to load, so the companion can still hear you. Quality caveat: any loud
// sound (claps, footsteps, the companion's own audio) reads as speech, so the
// gate's min-speech/min-silence timings carry more of the weight here.
//
// PORT: a native fallback would use the platform's energy-VAD or just drop the
// fallback entirely (the bundled Silero model is reliable off-web). This exists
// because a web build can have its WASM blocked (cross-origin iframe, policy).
// ─────────────────────────────────────────────────────────────────────────────
export function rmsRunModel(frame512, state) {
    let sum = 0;
    for (let i = 0; i < frame512.length; i++) sum += frame512[i] * frame512[i];
    const rms = Math.sqrt(sum / (frame512.length || 1));
    const { rmsFloor, rmsCeil } = VAD_TUNING;
    let prob = (rms - rmsFloor) / (rmsCeil - rmsFloor);
    if (prob < 0) prob = 0; else if (prob > 1) prob = 1;
    return { prob, state }; // no recurrent state — echo it back unchanged
}

// ─────────────────────────────────────────────────────────────────────────────
// createVad — the ONE-CALL browser entry point with GRACEFUL FALLBACK.
//
// Tries to load Silero via the vendored onnxruntime-web; if ANYTHING fails it
// silently falls back to the energy-RMS detector so VAD always works. Returns a
// ready VadService whose `.backend` is "silero" or "rms". Feed it warm-mic
// frames (src/speech.js) via service.feed(float32Frame).
//
//   const vad = await createVad({ onSpeechStart, onSpeechEnd, onBargeIn });
//   // ... per mic frame:
//   await vad.feed(micFloat32Frame);   // fires the callbacks; vad.prob is live
//
// opts: { backend='tenvad'|'silero'|'rms', base='vendor/vad/', modelFile,
//         ortModule, tenBase='vendor/ten-vad/', tenJs, tenWasm, inputRate,
//         onSpeechStart, onSpeechEnd, onBargeIn, onProb, gate, onFallback }
// Paths are resolved to ABSOLUTE URLs against document.baseURI before use:
// dynamic import() rejects a bare "vendor/…" specifier ("Failed to resolve
// module specifier"), and an absolute URL also keeps the ORT wasm load working
// on localhost AND inside itch's game iframe (same idiom as the Kokoro ORT
// vendoring). `onFallback(err)` (optional) is called if Silero failed.
// ─────────────────────────────────────────────────────────────────────────────
export async function createVad(opts = {}) {
    // Resolve against the page base so import()/wasmPaths get a valid absolute
    // URL. Guarded so the module still imports under node (document undefined).
    const baseRef = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : undefined;
    const abs = (p) => (baseRef ? new URL(p, baseRef).href : p);
    const base = opts.base ?? 'vendor/vad/';
    const ortModule = abs(opts.ortModule ?? (base + 'ort.wasm.min.mjs'));
    const modelUrl = abs(opts.modelFile ?? (base + 'silero_vad.onnx'));
    const svcOpts = {
        inputRate: opts.inputRate,
        onSpeechStart: opts.onSpeechStart,
        onSpeechEnd: opts.onSpeechEnd,
        onBargeIn: opts.onBargeIn,
        onProb: opts.onProb,
        gate: opts.gate,
    };

    // Backend selection.
    //   'rms'    — energy gate, no model; never fails (the ultimate fallback).
    //   'silero' — Silero v5 ONNX. Scores real BROWSER-mic speech poorly (~0.07
    //              P(speech) live vs ~0.65 on clean TTS) because Chrome's
    //              getUserMedia processing reshapes the spectrum it keys on — so it
    //              rarely crosses onset live. Kept for clean-audio / native use.
    //   'tenvad' — TEN-VAD (vendor/ten-vad). DEFAULT: gain-robust, recognizes the
    //              real quiet mic where Silero scored near-silence (eval: max 0.98 /
    //              mean 0.60 on the same audio). 256-sample / 16 ms frames.
    // Any backend that fails to load falls back to energy-RMS so VAD always works.
    const backend = opts.backend ?? 'tenvad';

    if (backend === 'rms') {
        return new VadService({ ...svcOpts, runModel: rmsRunModel, backend: 'rms' });
    }

    if (backend === 'tenvad') {
        try {
            const tBase = opts.tenBase ?? 'vendor/ten-vad/';
            const jsUrl = abs(opts.tenJs ?? (tBase + 'ten_vad.js'));
            const wasmUrl = abs(opts.tenWasm ?? (tBase + 'ten_vad.wasm'));
            const runModel = await buildTenVadRunModel({ jsUrl, wasmUrl });
            // Smoke a single 256-sample silent frame — a broken wasm/init fails HERE
            // (→ RMS fallback), not mid-conversation. Must return a finite prob.
            const probe = await runModel(new Float32Array(256), null);
            if (!Number.isFinite(probe.prob)) throw new Error('ten-vad probe returned non-finite prob');
            try { console.info('[vad] TEN-VAD backend live (256/16 ms frames)'); } catch { /* no console */ }
            return new VadService({ ...svcOpts, runModel, backend: 'tenvad', frameSamples: 256 });
        } catch (err) {
            try { console.warn('[vad] TEN-VAD load failed, falling back to energy-RMS VAD:', err?.message || err); } catch { /* no console */ }
            opts.onFallback && opts.onFallback(err);
            return new VadService({ ...svcOpts, runModel: rmsRunModel, backend: 'rms' });
        }
    }

    // backend === 'silero'
    try {
        const ort = await import(/* @vite-ignore */ ortModule);
        // Point ORT at the vendored, page-relative wasm so nothing is fetched
        // from a CDN at play time (works in the itch iframe). The lean non-jsep
        // wasm-only build avoids the broken jsep wasm.proxy (Kokoro memory note).
        // proxy stays false: in production createVad runs inside the voice worker
        // (voice-worker.js), so the calling thread is already off the render thread —
        // we don't want a nested ORT proxy on top of our own worker.
        if (ort.env?.wasm) {
            ort.env.wasm.wasmPaths = abs(base); // absolute dir holding ort-wasm-simd-threaded.wasm
            ort.env.wasm.proxy = false;      // no nested ORT proxy; we run in our own worker
        }
        const runModel = await buildOrtRunModel({ ort, modelUrl });
        // Smoke a single frame so a broken model/wasm fails HERE (→ fallback),
        // not mid-conversation. A zero frame must return a finite prob.
        const probe = await runModel(new Float32Array(VAD_TUNING.frameSamples), newSileroState());
        if (!Number.isFinite(probe.prob)) throw new Error('silero probe returned non-finite prob');
        return new VadService({ ...svcOpts, runModel, backend: 'silero' });
    } catch (err) {
        // GRACEFUL FALLBACK: never throw — degrade to energy-RMS so VAD works.
        try { console.warn('[vad] Silero load failed, falling back to energy-RMS VAD:', err?.message || err); } catch { /* no console */ }
        opts.onFallback && opts.onFallback(err);
        return new VadService({ ...svcOpts, runModel: rmsRunModel, backend: 'rms' });
    }
}
