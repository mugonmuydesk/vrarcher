// Smart Turn v3 — acoustic end-of-turn (EOU) scorer for the TurnDetector (turn.js).
//
// At a VAD silence boundary the TurnDetector asks "has the player FINISHED or just
// PAUSED?". This adapter answers from the ACOUSTICS of the buffered utterance:
// pipecat-ai's Smart Turn v3 (BSD-2), a Whisper-Tiny-based EOU classifier, returns
// P(turn-complete) ∈ [0,1] from the prosody/log-mel of the last ~8 s of audio. A
// prior eval validated the contract — a real complete utterance scored 0.93, a
// mid-word cutoff 0.02, a user-mic sample 0.95 full / 0.22 chopped.
//
// VENDORED (not CDN — it's tiny): vendor/smart-turn/smart-turn-v3.2-cpu.onnx
// (~8.68 MB int8) + vendor/smart-turn/mel_80_201.json (the EXACT 80×201 Whisper
// "slaney" mel filterbank, dumped from transformers' WhisperFeatureExtractor so the
// log-mel front-end matches the training extractor bit-for-bit — DO NOT hand-derive
// the mel filters in JS). The onnxruntime-web runtime is the SAME vendored ORT the
// Silero VAD uses (vendor/vad/ort.wasm.min.mjs + ort-wasm-simd-threaded.wasm) — so
// a dist build that ships Smart Turn must KEEP vendor/vad/ort* even if it drops
// silero_vad.onnx.
//
// ONNX I/O (verified against the eval):
//   input  "input_features" float32 [1, 80, 800]  (log-mel, 80 mels × 800 frames)
//   output "logits"         float32 [1, 1]         — ALREADY P(complete) ∈ [0,1]
//                                                     (sigmoid is INSIDE the graph;
//                                                      DO NOT apply sigmoid again).
//   Threshold 0.5. Inference ~13 ms, run ONCE per turn (not per frame).
//
// PREPROCESSING — standard Whisper-tiny log-mel on 16 kHz mono float32:
//   • keep the LAST 8 s (128000 samples = 800 frames); if shorter, pad zeros at the
//     START (pad = 128000 − len, prepended).
//   • Whisper do_normalize=True: zero-mean unit-variance the (cropped/padded) wave
//     over the FULL 128000-sample buffer: x=(x−mean)/sqrt(var+1e-7). THIS STEP WAS
//     MISSING from the original brief — without it every log-mel value is shifted
//     by a near-constant ≈0.35 (a unit-variance rescale = a constant power factor),
//     which the model was NOT trained for. Verified bit-for-bit against the Python
//     WhisperFeatureExtractor (do_normalize=True) the eval used — diff ≤ 2e-6.
//   • STFT: n_fft=400 (25 ms), hop=160 (10 ms), Hann window, center=True with
//     reflect padding, power=2.0 → 201 positive freq bins × 800 frames.
//   • mel: 80×201 slaney-normalized matrix (vendored) → 80×800.
//   • log + Whisper normalize: m=log10(max(m,1e-10)); m=max(m,m.max()-8); m=(m+4)/4.
//
// ENGINE-CLEAN: the DSP is pure standalone functions (node-testable, no ORT, no
// Babylon at parse time); the ORT import is LAZY (inside createSmartTurnScorer) so
// this file parses under `node --check`. On any load/init failure the factory
// THROWS so the caller (TurnDetector) treats a missing scorer as abstain and falls
// back to the silence+heuristic+gaze path unchanged.
//
// PORT: the native Quest port runs the IDENTICAL model and front-end — Smart Turn
// becomes native ONNX (ONNX Runtime Mobile / NNAPI) behind the same audioEouScore
// seam; the log-mel here transcribes one-to-one to a native Whisper feature
// extractor. // PORT: the FFT below is a plain radix-2 Cooley–Tukey on a 512-point
// (next pow2 ≥ 400) buffer — any platform FFT (Accelerate / KissFFT) substitutes.

// ─────────────────────────────────────────────────────────────────────────────
// Tuning / spec constants — native-port re-tuning + front-end checklist. These are
// the Whisper-tiny feature-extractor parameters; they MUST match the matrix dumped
// into mel_80_201.json and the model's training front-end. Do not change in
// isolation.
// ─────────────────────────────────────────────────────────────────────────────
export const SMARTTURN_TUNING = {
    sampleRate: 16000,        // Hz — model input rate (resample the mic to this)
    windowSec: 8,             // s — keep the last 8 s of audio
    nSamples: 128000,         // = sampleRate * windowSec — fixed input length
    nFft: 400,                // STFT window (25 ms @ 16 kHz)
    hop: 160,                 // STFT hop (10 ms @ 16 kHz)
    nFreq: 201,               // 1 + nFft/2 positive frequency bins
    nMels: 80,                // mel bands (model expects 80)
    nFrames: 800,             // = nSamples / hop — fixed frame count
    normEps: 1e-7,            // epsilon in the waveform zero-mean unit-var normalize
                              //   (Whisper do_normalize=True: sqrt(var + eps))
    logFloor: 1e-10,          // clamp before log10 (Whisper)
    dynRange: 8.0,            // Whisper dynamic-range clamp: m = max(m, m.max()-8)
    normAdd: 4.0,             // Whisper normalize: (m + 4) / 4
    normDiv: 4.0,
    // Vendored asset paths (resolved to ABSOLUTE URLs against document.baseURI).
    modelPath: "vendor/smart-turn/smart-turn-v3.2-cpu.onnx",
    melPath: "vendor/smart-turn/mel_80_201.json",
    // Reuse the Silero VAD's vendored ORT (same wasm) — see header dist note.
    ortModule: "vendor/vad/ort.wasm.min.mjs",
    ortWasmDir: "vendor/vad/",
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE DSP — all node-testable, no ORT/Babylon. The TurnDetector's audioEouScore
// builds the [1,80,800] log-mel from these and feeds it to the session.
// ─────────────────────────────────────────────────────────────────────────────

// Zero-mean unit-variance normalize a waveform IN PLACE (matches Whisper's
// do_normalize=True → WhisperFeatureExtractor.zero_mean_unit_var_norm): x = (x −
// mean) / sqrt(var + eps). The eval's inference path prepads the audio to the full
// 8 s BEFORE the extractor, so the attention mask is all-ones and the stats are
// taken over the WHOLE nSamples buffer (the prepended zeros included) — replicated
// here exactly. CRITICAL: the model was trained with this normalization; OMITTING
// it shifts every log-mel value by a near-constant (a unit-variance rescale is a
// constant power factor → constant log offset ≈ 0.35), which silently degrades the
// score. (This step is NOT in the original integration brief — added after the JS
// front-end was validated bit-for-bit against the Python WhisperFeatureExtractor.)
export function zeroMeanUnitVar(x, eps = 1e-7) {
    const n = x.length;
    if (!n) return x;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) { const d = x[i] - mean; varSum += d * d; }
    const std = Math.sqrt(varSum / n + eps);
    for (let i = 0; i < n; i++) x[i] = (x[i] - mean) / std;
    return x;
}

// Crop/pad a 16 kHz mono Float32 to exactly nSamples: keep the LAST `nSamples`
// (the most recent audio is the most informative for EOU); if shorter, pad zeros
// at the START (Whisper left-pads). Returns a fresh Float32Array of length nSamples.
export function cropPadStart(audio, nSamples = SMARTTURN_TUNING.nSamples) {
    const out = new Float32Array(nSamples);     // zero-filled
    if (!(audio && audio.length)) return out;   // all-zero (silence) on empty input
    if (audio.length >= nSamples) {
        out.set(audio.subarray(audio.length - nSamples)); // keep the last nSamples
    } else {
        out.set(audio, nSamples - audio.length);           // pad zeros at the START
    }
    return out;
}

// Hann window of length n (symmetric, matching librosa/torch default: sym=False
// "periodic" — divisor n, not n-1 — which is what the Whisper STFT uses).
export function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
}

// In-place iterative radix-2 Cooley–Tukey FFT on length-N (power of two) real/imag
// arrays. PORT: any platform FFT substitutes; this is here so node can run the DSP.
export function fftRadix2(re, im) {
    const n = re.length;
    // bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;       // forward transform
        const wpr = Math.cos(ang), wpi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let wr = 1, wi = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = i + k + len / 2;
                const xr = re[b] * wr - im[b] * wi;
                const xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr; im[a] += xi;
                const nwr = wr * wpr - wi * wpi;
                wi = wr * wpi + wi * wpr; wr = nwr;
            }
        }
    }
}

// STFT power spectrogram of a length-nSamples signal: Hann window (nFft), hop,
// center=True with REFLECT padding, power=2.0 (magnitude squared). Returns a
// Float32Array of nFrames*nFreq, ROW-MAJOR per frame: [frame0(201) | frame1(201) | …].
// center=True ⇒ frame t is centred at sample t*hop, so the signal is reflect-padded
// by nFft/2 on each side and exactly nFrames = nSamples/hop frames result.
export function stftPower(audio, T = SMARTTURN_TUNING) {
    const { nFft, hop, nFreq, nFrames } = T;
    const pad = nFft >> 1;                       // reflect pad (center=True)
    const n = audio.length;
    // Reflect-padded view accessor in ORIGINAL-signal coordinates: `idx` may run
    // negative or past n (center=True reflect-pads by `pad` on each side); map it
    // back into [0,n) with numpy-style 'reflect' (edge sample NOT repeated). The
    // caller passes idx in original coords directly — no extra offset here.
    const at = (idx) => {
        if (n === 1) return audio[0];
        const period = 2 * (n - 1);
        let m = ((idx % period) + period) % period;
        if (m >= n) m = period - m;
        return audio[m];
    };
    const win = hannWindow(nFft);
    // FFT working buffers sized to next pow2 ≥ nFft (400 → 512); the tail past nFft
    // stays zero each frame (zero-padding the FFT, which interpolates bins — but we
    // only read the first nFreq=201 bins, which for nFft=400 come from the 400-point
    // DFT exactly because we place the windowed samples in [0,nFft) and the bins we
    // need are the genuine 0..200 of a 400-point transform... so use a true 400 via
    // a 512 FFT only if 400 isn't pow2). 400 is NOT a power of two, so to keep the
    // bin centres correct we DFT at exactly nFft using a Bluestein-free path: pad to
    // 512 changes bin spacing, so instead compute the 201 bins by direct evaluation
    // is O(nFft*nFreq*nFrames) = heavy. Cheaper + correct: use the 512 FFT and
    // RESAMPLE? No — bin centres must be k/nFft. We therefore do a direct real DFT of
    // the 400-sample windowed frame for the 201 bins. nFft=400, nFreq=201, 800 frames
    // ⇒ 400*201*800 ≈ 64 M MACs ≈ a few ms in JS, run ONCE per turn. Acceptable.
    const out = new Float32Array(nFrames * nFreq);
    const frame = new Float32Array(nFft);
    // Precompute cos/sin tables for the direct DFT: cosT[k*nFft + j], k<nFreq, j<nFft.
    // 201*400 = 80400 entries each — built once per call (cheap vs the DFT itself).
    const cosT = new Float32Array(nFreq * nFft);
    const sinT = new Float32Array(nFreq * nFft);
    for (let k = 0; k < nFreq; k++) {
        const w0 = (-2 * Math.PI * k) / nFft;
        for (let j = 0; j < nFft; j++) {
            cosT[k * nFft + j] = Math.cos(w0 * j);
            sinT[k * nFft + j] = Math.sin(w0 * j);
        }
    }
    for (let t = 0; t < nFrames; t++) {
        const c = t * hop;                       // frame centre sample (center=True)
        for (let j = 0; j < nFft; j++) frame[j] = at(c - pad + j) * win[j];
        const base = t * nFreq;
        for (let k = 0; k < nFreq; k++) {
            let re = 0, im = 0;
            const kb = k * nFft;
            for (let j = 0; j < nFft; j++) {
                const s = frame[j];
                re += s * cosT[kb + j];
                im += s * sinT[kb + j];
            }
            out[base + k] = re * re + im * im;    // power (magnitude squared)
        }
    }
    return out;
}

// Apply the vendored 80×201 mel matrix (row-major: mel[r*nFreq + c]) to the STFT
// power (nFrames×nFreq, row-major per frame) → mel energies, returned as a
// Float32Array of nMels*nFrames in [mel, frame] ROW-MAJOR order (mel-major), which
// is the model's [80, 800] layout flattened. mel[m][t] = Σ_c melMat[m][c]·pow[t][c].
export function melMatmul(power, melMat, T = SMARTTURN_TUNING) {
    const { nFreq, nFrames, nMels } = T;
    const out = new Float32Array(nMels * nFrames);
    for (let m = 0; m < nMels; m++) {
        const mb = m * nFreq;
        const ob = m * nFrames;
        for (let t = 0; t < nFrames; t++) {
            const pb = t * nFreq;
            let acc = 0;
            for (let c = 0; c < nFreq; c++) acc += melMat[mb + c] * power[pb + c];
            out[ob + t] = acc;
        }
    }
    return out;
}

// Whisper log + normalize, IN PLACE on a mel-energy array:
//   m = log10(max(m, logFloor));  m = max(m, globalMax - dynRange);  m = (m+normAdd)/normDiv
// Returns the same array (now the model-ready features), still mel-major [80,800].
export function whisperLogNormalize(mel, T = SMARTTURN_TUNING) {
    const { logFloor, dynRange, normAdd, normDiv } = T;
    let max = -Infinity;
    for (let i = 0; i < mel.length; i++) {
        const v = Math.log10(Math.max(mel[i], logFloor));
        mel[i] = v;
        if (v > max) max = v;
    }
    const floor = max - dynRange;
    for (let i = 0; i < mel.length; i++) {
        let v = mel[i];
        if (v < floor) v = floor;
        mel[i] = (v + normAdd) / normDiv;
    }
    return mel;
}

// Full front-end: 16 kHz mono Float32 → model-ready Float32 of length nMels*nFrames
// (= 80*800), mel-major, ready to wrap as a [1,80,800] tensor. Pure (no ORT).
export function buildLogMel(audio16k, melMat, T = SMARTTURN_TUNING) {
    const padded = cropPadStart(audio16k, T.nSamples);
    zeroMeanUnitVar(padded, T.normEps);   // Whisper do_normalize=True (over full buffer)
    const power = stftPower(padded, T);
    const mel = melMatmul(power, melMat, T);
    return whisperLogNormalize(mel, T);
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY — lazily loads ORT + the model + the mel matrix (all absolute URLs via
// document.baseURI) and returns an async audioEouScore. THROWS on any load/init
// failure so the caller can fall back (TurnDetector treats a thrown/absent scorer
// as abstain). ORT import is lazy so `node --check` of this file needs no wasm.
// ─────────────────────────────────────────────────────────────────────────────
export async function createSmartTurnScorer(opts = {}) {
    const T = { ...SMARTTURN_TUNING, ...(opts.tuning || {}) };
    // Resolve vendored assets to absolute URLs against the page base (dynamic
    // import() rejects bare "vendor/…" specifiers, and an absolute URL keeps the
    // wasm/model load working inside the itch game iframe too — same idiom as vad.js).
    const baseRef = (typeof document !== "undefined" && document.baseURI) ? document.baseURI : undefined;
    const abs = (p) => (baseRef ? new URL(p, baseRef).href : p);
    const ortModuleUrl = abs(opts.ortModule ?? T.ortModule);
    const ortWasmDir = abs(opts.ortWasmDir ?? T.ortWasmDir);
    const modelUrl = abs(opts.modelUrl ?? T.modelPath);
    const melUrl = abs(opts.melUrl ?? T.melPath);

    // ORT — reuse the Silero VAD's vendored runtime. Point it at the vendored wasm
    // (no CDN at play time). proxy stays FALSE because (a) the lean non-jsep build's
    // wasm.proxy is broken (Kokoro memory note) and (b) we don't NEED ORT's proxy:
    // in production this factory runs inside the voice worker (voice-worker.js), so
    // "the calling thread" is already that worker, OFF the render thread — same
    // our-own-worker pattern Kokoro uses. (Node tests + the native port call it
    // directly, where the calling thread is whatever invoked it.)
    const ORT = opts.ort || await import(/* @vite-ignore */ ortModuleUrl);
    if (ORT.env?.wasm) {
        ORT.env.wasm.wasmPaths = ortWasmDir;     // absolute dir w/ ort-wasm-simd-threaded.wasm
        ORT.env.wasm.proxy = false;              // no nested ORT proxy; we run in our own worker
    }
    const session = await ORT.InferenceSession.create(modelUrl);

    // Mel filterbank: { shape:[80,201], data:[...16080] } — vendored slaney matrix.
    let melMat;
    if (opts.melMatrix) {
        melMat = opts.melMatrix;
    } else {
        const res = await fetch(melUrl);
        if (!res.ok) throw new Error(`smartturn: mel matrix fetch failed ${res.status}`);
        const json = await res.json();
        const expect = T.nMels * T.nFreq;
        if (!json?.data || json.data.length !== expect) {
            throw new Error(`smartturn: mel matrix bad length ${json?.data?.length} (want ${expect})`);
        }
        melMat = Float32Array.from(json.data);
    }

    // The scorer: 16 kHz mono Float32 → P(complete) ∈ [0,1]. Returns null on empty
    // input (abstain); otherwise runs the session ONCE and returns logits.data[0]
    // DIRECTLY (sigmoid is inside the graph — NO extra sigmoid).
    const audioEouScore = async (audio16k) => {
        if (!(audio16k && audio16k.length)) return null;       // nothing to score → abstain
        const feats = buildLogMel(audio16k, melMat, T);        // Float32 [80*800], mel-major
        const inputT = new ORT.Tensor("float32", feats, [1, T.nMels, T.nFrames]);
        const out = await session.run({ input_features: inputT });
        const logits = out.logits ?? out[Object.keys(out)[0]];
        const v = logits?.data?.[0];
        return typeof v === "number" ? v : null;               // already P(complete)
    };

    return audioEouScore;
}
