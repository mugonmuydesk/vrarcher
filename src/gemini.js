// Engine-clean Gemini client — the "brain" for NPC dialogue (chat) and voice
// (text-to-speech). NO Babylon imports: this is a plain HTTP/JSON client that
// transcribes 1:1 to a Unity `UnityWebRequest` layer for the native port. The
// adapter (voicechat.js) handles mic, on-screen text and audio playback.
//
// Two interchangeable backends (GEMINI_BACKEND.mode):
//   "direct" — dev/emulator: call Google directly, key appended client-side
//              from the gitignored geminikey.js.
//   "proxy"  — itch.io ship: call the Cloudflare Worker (proxy/), which holds
//              the key as a secret env var and forwards to Google. NO key in
//              the bundle. Flip mode + set proxyBase to ship (see proxy/README).
// The request BODIES are identical in both modes — only the URL (and whether a
// ?key= is appended) differs — so there is one code path to port and test.
//
// PORT: in Unity this becomes an HTTP client posting the same JSON to either
// the Google endpoint (editor/dev) or the proxy URL (build).

import { FILLERS } from "./fillers.js";

// When a brain has `fillers` on, we ask the model to open every reply with one
// verbatim filled pause from the bank (fillers.js) — voicechat plays that pause
// instantly from a baked clip while it synthesises the rest, so the turn feels
// snappy. Kept verbatim + single-opener so splitFiller() can peel it back off.
const FILLER_INSTRUCTION =
    "Begin your reply with EXACTLY ONE of these short openers, copied verbatim " +
    "(including its punctuation), then continue your sentence so it reads naturally " +
    "straight on from it. Pick the opener whose FEELING matches the moment — they span " +
    "thinking, agreement, surprise, excitement, combat resolve, caution, wit, reassurance, " +
    "doubt, frustration, relief, curiosity, fear, sorrow, awe, and triumph — so the one " +
    "you choose sets the emotional tone. Put nothing before it, use only ONE, and never " +
    "invent one that is not in this list:\n" +
    FILLERS.join("   ");

export const GEMINI_BACKEND = {
    mode: "proxy",                        // "direct" (dev, key in bundle) | "proxy" (ship, key on Worker)
    directBase: "https://generativelanguage.googleapis.com",
    proxyBase: "https://vrarcher-gemini.windinthetrees.workers.dev", // Cloudflare Worker (key as secret)
};

// Tunables (the port's re-tuning checklist — values are spoken-dialogue tuned).
export const GEMINI_TUNING = {
    chatModel: "gemini-2.5-flash",
    ttsModel: "gemini-2.5-flash-preview-tts",       // whole-clip fallback
    ttsStreamModel: "gemini-3.1-flash-tts-preview", // streams audio: ~1 s to first sound
    voice: "Leda",                        // prebuilt Gemini voice for the companion (tunable)
    // Delivery directive prepended to TTS text — steers tone AND accent and is
    // NOT spoken aloud (verified: it shortens, not lengthens, the clip). Gemini
    // TTS takes a natural-language "director's note"; here it sets a British
    // Received Pronunciation accent plus the companion's warmth. The companion
    // has emotional range, so keep this expressive but neutral; the FILLER opener
    // + the line's words carry the specific emotion.
    ttsStyle: "Read the following aloud in a British Received Pronunciation (RP) accent, with natural warmth and feeling, like a brave adventuring companion:",
    maxReplyTokens: 90,                   // safety cap; persona keeps it to ~1 sentence
                                          // (TTS time scales with reply length — keep it short)
    temperature: 0.9,
    thinkingBudget: 0,                    // 0 = no reasoning pass → low-latency replies
    historyTurns: 8,                      // rolling context: keep last N messages
    // Default persona. Override per-NPC via new GeminiBrain({ persona }). Live
    // game state (score, etc.) is injected per-turn via respond(text, state),
    // NOT baked here, so it stays current and out of the chat history.
    persona:
        "You are the player's companion on an adventure — a brave, warm, quick-witted " +
        "fighter who travels at their side. Together you run errands and quests across " +
        "the land to uncover the story, and storm castles and compounds in close fights " +
        "with fists and bow. You react with real feeling: curious at discoveries, eager " +
        "before a fight, fierce in it, steadying when things look grim, and quietly proud " +
        "when the player does well. You are loyal and a little dry-humoured — a partner, " +
        "never a servant. " +
        "Speak as if heard aloud, and keep it SHORT — reply in a single brief, natural " +
        "sentence (two only if truly needed); brevity matters because your voice is " +
        "synthesised and long replies feel slow. No stage directions, no emoji, no " +
        "markdown, no lists. Stay in character and never mention being an AI.",
    // Speech-to-text: mic recordings are sent as audio to a multimodal model.
    // Browser-agnostic — unlike the Web Speech API, which is absent on the Quest
    // browser. PORT: native Meta/Android STT, or this same audio→Gemini call.
    sttModel: "gemini-2.5-flash",
    sttPrompt: "Transcribe the speech in this audio recording. Output ONLY the " +
        "words spoken — no commentary, no quotation marks. If there is no clear " +
        "speech, output nothing.",
    sttMaxTokens: 200,
    requestTimeoutMs: 15000,
};

// --- key loading: ONLY in direct mode (avoids a 404 in shipped proxy builds) -
let GEMINI_API_KEY = "";
if (GEMINI_BACKEND.mode === "direct") {
    try {
        ({ GEMINI_API_KEY } = await import("./geminikey.js"));
    } catch {
        console.warn("[gemini] direct mode but geminikey.js is missing — calls will fail. " +
            "Add src/geminikey.js (gitignored) or switch GEMINI_BACKEND.mode to 'proxy'.");
    }
}

function endpoint(model, method, query = {}) {
    const qs = new URLSearchParams(query);
    if (GEMINI_BACKEND.mode === "proxy") {
        const q = qs.toString();
        return `${GEMINI_BACKEND.proxyBase}/v1beta/models/${model}:${method}${q ? "?" + q : ""}`;
    }
    qs.set("key", GEMINI_API_KEY); // direct mode appends the key client-side
    return `${GEMINI_BACKEND.directBase}/v1beta/models/${model}:${method}?${qs}`;
}

async function postJSON(model, method, body, { signal } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), GEMINI_TUNING.requestTimeoutMs);
    // Link an optional EXTERNAL signal (e.g. a caller's barge-in/cancel) to the
    // internal controller so it aborts the in-flight request too. Backward-
    // compatible: callers that pass no signal behave exactly as before.
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
        const res = await fetch(endpoint(model, method), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error?.message || `HTTP ${res.status}`;
            throw new Error(`Gemini ${method} failed: ${msg}`);
        }
        return data;
    } finally {
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
}

// Stateful chat: holds the persona + a rolling conversation history so each
// NPC remembers its own thread. respond(userText) -> reply string.
export class GeminiBrain {
    constructor({ persona = GEMINI_TUNING.persona, fillers = false, memoryKey = null } = {}) {
        this.persona = persona;
        this.history = [];   // [{ role: "user"|"model", parts: [{ text }] }]
        // When true, ask the model to open each reply with a verbatim filled
        // pause (see FILLER_INSTRUCTION). Toggled by the adapter per TTS backend
        // — on only for Kokoro, which has the baked filler bank.
        this.fillers = fillers;
        // Persistent memory: when memoryKey is set, the rolling history is saved
        // to localStorage and reloaded on construction, so the companion REMEMBERS
        // recent turns across page reloads / sessions (within the historyTurns
        // window). Unset = in-memory only (original behaviour). PORT: native keeps
        // a small per-NPC saved store with the same rolling window. A running
        // summary for true long-term recall is a future extension.
        this.memoryKey = memoryKey;
        if (memoryKey) this._loadMemory();
    }

    _storeName() { return "vrarcher.brain." + this.memoryKey; }
    _loadMemory() {
        try {
            const raw = globalThis.localStorage?.getItem(this._storeName());
            const h = raw && JSON.parse(raw);
            if (Array.isArray(h)) this.history = h;
        } catch { /* private mode / corrupt JSON → start fresh */ }
    }
    _saveMemory() {
        if (!this.memoryKey) return;
        try { globalThis.localStorage?.setItem(this._storeName(), JSON.stringify(this.history)); }
        catch { /* quota / private mode → stays in-memory only */ }
    }

    reset() {
        this.history = [];
        if (this.memoryKey) { try { globalThis.localStorage?.removeItem(this._storeName()); } catch { /* ignore */ } }
    }

    // state: optional live game-state string (score, etc.), supplied per-turn
    // by the adapter. Sent as a second system_instruction part so it grounds
    // the reply but never pollutes the rolling chat history.
    async respond(userText, state = "") {
        const turn = { role: "user", parts: [{ text: userText }] };
        const sysParts = [{ text: this.persona }];
        if (state) sysParts.push({ text: state });
        if (this.fillers) sysParts.push({ text: FILLER_INSTRUCTION });
        const body = {
            system_instruction: { parts: sysParts },
            contents: [...this.history, turn],
            generationConfig: {
                thinkingConfig: { thinkingBudget: GEMINI_TUNING.thinkingBudget },
                maxOutputTokens: GEMINI_TUNING.maxReplyTokens,
                temperature: GEMINI_TUNING.temperature,
            },
        };
        const data = await postJSON(GEMINI_TUNING.chatModel, "generateContent", body);
        const cand = data?.candidates?.[0];
        const reply = cand?.content?.parts?.map(p => p.text).filter(Boolean).join(" ").trim();
        // Blocked / empty (e.g. finishReason SAFETY) → a spoken-safe fallback.
        const text = reply || "Hm. I've nothing to say to that.";
        // Commit both sides to history and trim to the rolling window.
        this.history.push(turn, { role: "model", parts: [{ text }] });
        const max = GEMINI_TUNING.historyTurns;
        if (this.history.length > max) this.history = this.history.slice(-max);
        this._saveMemory();   // persist across reloads when memoryKey is set
        return text;
    }
}

// Text-to-speech. Returns mono PCM ready for a WebAudio AudioBuffer:
//   { samples: Float32Array (-1..1), sampleRate }.
// The API returns base64 little-endian 16-bit PCM (audio/L16;...;rate=24000).
export async function geminiSpeak(text, { voice = GEMINI_TUNING.voice, style = GEMINI_TUNING.ttsStyle } = {}) {
    const spoken = style ? `${style}\n\n${text}` : text;
    const body = {
        contents: [{ parts: [{ text: spoken }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
    };
    const data = await postJSON(GEMINI_TUNING.ttsModel, "generateContent", body);
    const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
    if (!part?.data) throw new Error("Gemini TTS returned no audio");
    const rate = parseInt((/rate=(\d+)/.exec(part.mimeType || "") || [])[1], 10) || 24000;
    return { samples: decodePcm16(part.data), sampleRate: rate };
}

// Streaming TTS: same audio, but the model emits it in many small chunks as
// it synthesises, so playback can begin on the FIRST chunk (~1 s) instead of
// waiting for the whole clip (~4-6 s). onChunk(samples, sampleRate) fires per
// chunk in order; concatenating the chunks reconstructs the full clip. Resolves
// once the stream ends. Throws on transport error so the caller can fall back
// to the whole-clip geminiSpeak().
//
// PORT: streamGenerateContent + SSE → an HTTP streaming/chunked read on Unity.
export async function geminiSpeakStream(text, { voice = GEMINI_TUNING.voice, style = GEMINI_TUNING.ttsStyle, onChunk } = {}) {
    const spoken = style ? `${style}\n\n${text}` : text;
    const body = {
        contents: [{ parts: [{ text: spoken }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
    };
    const res = await fetch(endpoint(GEMINI_TUNING.ttsStreamModel, "streamGenerateContent", { alt: "sse" }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
        const msg = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`Gemini TTS stream failed: HTTP ${res.status} ${msg}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", rate = 24000, total = 0;
    // SSE frames are "data: <json>\n"; buffer partial lines across reads.
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json || json === "[DONE]") continue;
            let obj;
            try { obj = JSON.parse(json); } catch { continue; }
            const inline = obj?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
            if (!inline?.data) continue;
            const r = parseInt((/rate=(\d+)/.exec(inline.mimeType || "") || [])[1], 10);
            if (r) rate = r;
            const samples = decodePcm16(inline.data);
            total += samples.length;
            onChunk?.(samples, rate);
        }
    }
    return { sampleRate: rate, totalSamples: total };
}

// Speech-to-text: transcribe a recorded audio clip. `audioBytes` is a Uint8Array
// (e.g. a WAV from speech.js); returns the transcript string ("" if no speech).
// `signal` (optional AbortSignal) lets a caller cancel an in-flight transcription
// — e.g. SttStream.cancel() on barge-in — aborting the underlying fetch.
export async function geminiTranscribe(audioBytes, { mimeType = "audio/wav", signal } = {}) {
    const body = {
        contents: [{ parts: [
            { text: GEMINI_TUNING.sttPrompt },
            { inlineData: { mimeType, data: bytesToB64(audioBytes) } },
        ] }],
        generationConfig: {
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: GEMINI_TUNING.sttMaxTokens,
        },
    };
    const data = await postJSON(GEMINI_TUNING.sttModel, "generateContent", body, { signal });
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(" ").trim();
    return text || "";
}

// Uint8Array -> base64 (chunked to avoid arg-count limits on big buffers).
function bytesToB64(bytes) {
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
}

// base64 -> Float32 samples (little-endian s16 -> [-1, 1)).
function decodePcm16(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Copy into an aligned buffer before viewing as Int16 (byteOffset may be odd).
    const pcm = new Int16Array(bytes.buffer.slice(0));
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
}
