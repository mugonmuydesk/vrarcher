// Kokoro synthesis worker — runs the vendored Kokoro bundle (and thus all ONNX
// inference) OFF the page's main thread, so synthesising a reply never stalls
// the XR render loop. The main-thread shim (kokoro.js) talks to this worker by
// message; this worker only does model load + synthesis and posts back raw
// Float32 PCM (transferred, zero-copy). No Babylon, no AudioContext here.
//
// Why a worker we own (not ORT's wasm.proxy): ORT's built-in proxy worker fails
// to initialise with kokoro-js's bundled JSEP build (verified). Hosting the
// whole bundle in our own module worker sidesteps that — ORT then runs on this
// worker's thread, and (when the page is cross-origin isolated) its WASM threads
// give parallel speed too.
//
// PORT: native Quest moves inference to a background thread / ONNX Runtime
// Mobile; this worker is the web stand-in for that.

let tts = null;

// Clause split for streamed synthesis: Kokoro renders a chunk in one shot, so to
// get the FIRST audio out sooner we break not just on sentence ends but also on
// commas/semicolons/colons/dashes. The opening clause (a few words) renders fast
// and starts playing while the rest synthesises — shrinks the gap after the
// filler on the slow WASM path.
function splitSentences(text) {
    const t = (text || "").trim();
    if (!t) return [];
    const parts = t.match(/[^.!?,;:—]+[.!?,;:—]+|\S[^.!?,;:—]*$/g);
    return (parts || [t]).map((s) => s.trim()).filter(Boolean);
}

self.onmessage = async (e) => {
    const m = e.data;
    try {
        if (m.type === "load") {
            // Absolute base (ends "/") the patched bundle resolves model/voice/
            // wasm paths against — must be set BEFORE importing the bundle.
            self.__KOKORO_BASE = m.base;
            const mod = await import(m.base + "vendor/kokoro/lib/kokoro.web.js");
            tts = await mod.KokoroTTS.from_pretrained(m.model, { dtype: m.dtype, device: "wasm" });
            self.postMessage({ type: "loaded", id: m.id, device: "wasm" });
        } else if (m.type === "speak") {
            const a = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
            const samples = a.audio, rate = a.sampling_rate || 24000;
            self.postMessage({ type: "speak", id: m.id, samples, rate }, [samples.buffer]);
        } else if (m.type === "stream") {
            let total = 0, rate = 24000;
            for (const part of splitSentences(m.text)) {
                const a = await tts.generate(part, { voice: m.voice, speed: m.speed });
                rate = a.sampling_rate || rate;
                const samples = a.audio;
                if (samples?.length) {
                    total += samples.length;
                    self.postMessage({ type: "chunk", id: m.id, samples, rate }, [samples.buffer]);
                }
            }
            self.postMessage({ type: "streamDone", id: m.id, totalSamples: total, rate });
        }
    } catch (err) {
        self.postMessage({ type: "error", id: m.id, err: String((err && err.message) || err) });
    }
};
