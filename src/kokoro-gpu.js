// "q32" voice backend — Kokoro-82M at fp32 on the GPU via WebGPU. The ONLY
// configuration where Kokoro's WebGPU output is CORRECT is transformers.js v4's
// native WebGPU EP (v3 corrupts it — the "Chinese audio" bug), so this path runs
// the kokoro-js wrapper on transformers v4, loaded from CDN through index.html's
// import map. Same contract as kokoro.js (kokoroGpuSpeak / kokoroGpuSpeakStream).
//
// Trade-offs vs the WASM backend (kokoro.js): MUCH faster synth (~0.8 s desktop)
// BUT runs on the same GPU as the XR renderer, so a synth burst can cost frames
// during the turn — worth A/B-ing on the actual Quest. Also ONLINE: the v4
// runtime + the fp32 model (~310 MB) download from CDN/HF on first use (cached
// after); the WASM backend stays fully offline. This is the experimental "GPU"
// toggle, not the default. No Babylon import.
//
// PORT: native Quest would run fp32/fp16 through the platform GPU/NPU runtime;
// the text→{samples,rate} contract is identical to the WASM path.

export const KOKORO_GPU_TUNING = {
    wrapperUrl: "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.js",
    model: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "fp32",          // the only WebGPU-correct dtype here (no shader-f16 needed)
    device: "webgpu",
    voice: "bf_emma",       // same voice as the WASM bank, so fillers still seam
    speed: 1.0,
    sampleRate: 24000,
};

let _tts = null;
let _loadP = null;
let _ready = false;
let _device = null;

export function kokoroGpuReady() { return _ready; }
export function kokoroGpuDevice() { return _device; }

// True if this device exposes a usable WebGPU adapter (so q32 can run at all).
export async function webgpuAvailable() {
    try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); }
    catch { return false; }
}

// Load the v4 runtime + fp32 model (once). Throws if WebGPU is unavailable so
// the caller can fall back / show the backend as unusable.
export async function loadKokoroGpu(opts = {}) {
    if (_ready) return;
    if (_loadP) return _loadP;
    _loadP = (async () => {
        if (!(await webgpuAvailable())) throw new Error("WebGPU unavailable on this device");
        const { KokoroTTS } = await import(/* @vite-ignore */ KOKORO_GPU_TUNING.wrapperUrl);
        console.log("[kokoro-gpu] loading", KOKORO_GPU_TUNING.model, "fp32 on webgpu (transformers v4)");
        _tts = await KokoroTTS.from_pretrained(opts.model ?? KOKORO_GPU_TUNING.model, {
            dtype: opts.dtype ?? KOKORO_GPU_TUNING.dtype,
            device: opts.device ?? KOKORO_GPU_TUNING.device,
        });
        _ready = true; _device = "webgpu";
    })();
    try { await _loadP; }
    catch (e) { _loadP = null; throw e; }
}

export async function kokoroGpuSpeak(text, { voice = KOKORO_GPU_TUNING.voice, speed = KOKORO_GPU_TUNING.speed } = {}) {
    await loadKokoroGpu();
    const a = await _tts.generate(text, { voice, speed });
    return { samples: a.audio, sampleRate: a.sampling_rate || KOKORO_GPU_TUNING.sampleRate };
}

// Streamed synthesis: render clause-by-clause and fire onChunk as each finishes
// so playback can begin on the first chunk. Resolves { sampleRate, totalSamples }.
export async function kokoroGpuSpeakStream(text, { voice = KOKORO_GPU_TUNING.voice, speed = KOKORO_GPU_TUNING.speed, onChunk } = {}) {
    await loadKokoroGpu();
    let total = 0, rate = KOKORO_GPU_TUNING.sampleRate;
    for (const part of splitClauses(text)) {
        const a = await _tts.generate(part, { voice, speed });
        rate = a.sampling_rate || rate;
        if (a.audio?.length) { total += a.audio.length; onChunk?.(a.audio, rate); }
    }
    return { sampleRate: rate, totalSamples: total };
}

// Split into short clauses (sentence ends AND commas/semicolons/colons/dashes)
// so the first audio comes out sooner. Keeps each chunk a natural phrase.
function splitClauses(text) {
    const t = (text || "").trim();
    if (!t) return [];
    const parts = t.match(/[^.!?,;:—]+[.!?,;:—]+|\S[^.!?,;:—]*$/g);
    return (parts || [t]).map((s) => s.trim()).filter(Boolean);
}
