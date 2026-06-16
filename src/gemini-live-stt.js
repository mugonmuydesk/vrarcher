// TRUE streaming speech-to-text over the Gemini Live (BidiGenerateContent)
// bidirectional WebSocket — the real low-latency replacement for the O(N²)
// re-transcription stand-in in stt-stream.js (SttStream).
//
// APPROACH — bidirectional streaming ASR (Gemini Live).
//   We open ONE WebSocket per utterance to the Cloudflare Worker's /live route
//   (proxy/gemini-proxy.worker.js), which relays frames to the Gemini Live
//   endpoint with the API key injected server-side (the key never reaches the
//   browser). The first frame is a `setup` selecting a Live model with
//   `inputAudioTranscription: {}` enabled. Then mic PCM is streamed as
//   `realtimeInput.audio` blobs (16 kHz, 16-bit PCM, base64). The server pushes
//   back `serverContent.inputTranscription.text` partials AS the user speaks —
//   no re-transcription, no growing buffer, cost ~linear in audio length. On
//   stop() we send `realtimeInput.audioStreamEnd:true`, wait for the trailing
//   transcription, and resolve the final transcript.
//
//   The transcript pieces arrive INCREMENTALLY (each inputTranscription.text is a
//   delta, not the cumulative string), so we accumulate them into a running
//   transcript and emit the concatenation on each partial. (Verified against the
//   Live API docs: inputTranscription streams deltas.)
//
// INTERFACE — identical to SttStream (stt-stream.js) so voicechat.js drives this
// UNCHANGED: start({sampleRate,onPartial,onFinal}) / onPartial(fn) / onFinal(fn)
// / pushAudio(float32Frame) / stop()→finalText / cancel() / .running.
//
// PORT: the open-socket → stream-PCM → receive-partials idiom maps 1:1 onto a
// native streaming-ASR socket (Meta/Android speech, or a server gRPC stream).
// No Babylon imports — a plain WebSocket/JSON client, importable in node.

import { resampleLinear } from "./vad.js";

// Tunables (the port's re-tuning checklist).
export const GEMINI_LIVE_STT_TUNING = {
    // The Worker /live route — browser connects with NO key; the Worker injects it
    // server-side and relays to the Gemini Live endpoint.
    liveUrl: "wss://vrarcher-gemini.windinthetrees.workers.dev/live",
    // Gemini Live model id for streaming input transcription. VERIFIED 2026-06-16
    // by node smoke test against the live endpoint: the half-cascade ids
    // (gemini-2.0-flash-live-001, gemini-3.1-flash-live-preview, *-flash-live-*)
    // either 404 on v1beta or REJECT responseModalities:["TEXT"]; only the
    // native-audio model accepts the connection AND streams inputTranscription.
    // It only supports responseModalities:["AUDIO"] (see setup below). The Live
    // model line shifts often — if transcription stops, re-confirm the current id
    // on ai.google.dev/gemini-api/docs/live-guide.
    model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
    encodeRate: 16000,          // Gemini Live wants raw 16 kHz 16-bit PCM (Hz).
    sampleRate: 16000,          // default capture rate (Hz) if start() omits it.
    setupTimeoutMs: 4000,       // wait this long for the server's setupComplete (ms)
                                // before giving up on the connection.
    finalTimeoutMs: 4000,       // after audioStreamEnd, wait UP TO this long for the
                                // trailing transcription before giving up (ms). The
                                // server's input-transcription deltas can lag the
                                // audio by ~1.5–2.5 s, so this must comfortably
                                // exceed that lag (measured ~1.9 s to first delta).
    finalQuietMs: 600,          // …but once a post-stop delta has landed, resolve
                                // this long after the LAST delta (ms): the transcript
                                // has settled, don't wait the full finalTimeoutMs.
};

// One streaming-STT session over the Gemini Live socket. Construct once and reuse
// across turns (start()/stop() per utterance); pushAudio() between them.
// Engine-clean.
export class GeminiLiveSttStream {
    constructor() {
        this._ws = null;            // the WebSocket to the Worker /live route
        this._rate = GEMINI_LIVE_STT_TUNING.sampleRate;
        this._ready = false;        // setupComplete received → audio may flow
        this._transcript = "";      // accumulated input transcription (running)
        this._pending = [];         // PCM frames buffered before setupComplete
        this._epoch = 0;            // bumped on stop()/cancel(); stale events dropped
        this._finalResolve = null;  // stop()'s resolver, called when final settles
        this._finalTimer = null;    // overall final timeout handle
        this._quietTimer = null;    // "no new delta" early-resolve handle
        this.running = false;
        this._onPartial = null;
        this._onFinal = null;
    }

    // Register/replace the partial-transcript callback. Returns this for chaining.
    onPartial(fn) { this._onPartial = fn; return this; }

    // Register/replace the final-transcript callback. Returns this for chaining.
    onFinal(fn) { this._onFinal = fn; return this; }

    // Begin a new utterance: open the WS, send `setup`, and start streaming. Audio
    // pushed before setupComplete is buffered and flushed once the server is ready.
    // Options mirror SttStream: sampleRate (capture Hz), onPartial / onFinal.
    start({ sampleRate, onPartial, onFinal } = {}) {
        if (onPartial) this._onPartial = onPartial;
        if (onFinal) this._onFinal = onFinal;
        if (sampleRate) this._rate = sampleRate;
        this._transcript = "";
        this._pending = [];
        this._ready = false;
        this._epoch++;
        this.running = true;

        let ws;
        try {
            ws = new WebSocket(GEMINI_LIVE_STT_TUNING.liveUrl);
        } catch (e) {
            // Couldn't even construct the socket — degrade to a no-op session so the
            // caller's stop() still resolves "" rather than throwing.
            console.warn("[gemini-live-stt] WebSocket construct failed:", e?.message || e);
            this.running = false;
            return;
        }
        this._ws = ws;
        ws.binaryType = "arraybuffer";
        const epoch = this._epoch;

        ws.addEventListener("open", () => {
            if (epoch !== this._epoch) return;       // stop()/cancel() raced the open
            this._send({
                setup: {
                    model: GEMINI_LIVE_STT_TUNING.model,
                    // The native-audio Live model ONLY supports AUDIO output (it
                    // rejects ["TEXT"]). We don't consume that audio reply at all —
                    // we only want serverContent.inputTranscription. stop() closes
                    // the socket as soon as the transcript settles (finalQuietMs),
                    // cutting off the model's spoken reply before much of it
                    // generates, so we're not billed for a long unused response.
                    generationConfig: { responseModalities: ["AUDIO"] },
                    inputAudioTranscription: {},     // enables serverContent.inputTranscription
                    // Belt-and-braces: ask the model to stay silent. (It still emits
                    // SOME audio; the early close is the real cost guard.)
                    systemInstruction: { parts: [{ text: "You are a silent transcriber. Do not reply. Output nothing." }] },
                },
            });
        });

        ws.addEventListener("message", (e) => this._onMessage(e, epoch));
        ws.addEventListener("error", (e) => {
            if (epoch !== this._epoch) return;
            console.warn("[gemini-live-stt] WS error:", e?.message || "socket error");
        });
        ws.addEventListener("close", () => {
            if (epoch !== this._epoch) return;
            // Socket closed (possibly server-side after audioStreamEnd). If a stop()
            // is awaiting the final result, settle it with whatever we have.
            this._settleFinal();
        });

        // Guard against a setup that never completes (bad model id, upstream refused
        // the upgrade): if no setupComplete arrives, surface it and free the socket.
        setTimeout(() => {
            if (epoch === this._epoch && this.running && !this._ready) {
                console.warn("[gemini-live-stt] no setupComplete within",
                    GEMINI_LIVE_STT_TUNING.setupTimeoutMs, "ms — Live STT may be misconfigured");
            }
        }, GEMINI_LIVE_STT_TUNING.setupTimeoutMs);
    }

    // Feed a frame of mono Float32 PCM (one mic block). Resamples to 16 kHz,
    // converts to 16-bit PCM, base64-encodes and sends as a realtimeInput audio
    // blob. Buffers frames until setupComplete. No-op if not running.
    pushAudio(pcm) {
        if (!this.running || !pcm || !pcm.length) return;
        if (!this._ready) {
            // Copy (Web Audio reuses the buffer) and hold until the server is ready.
            this._pending.push(pcm.slice ? pcm.slice(0) : new Float32Array(pcm));
            return;
        }
        this._sendAudioFrame(pcm);
    }

    // Stop capturing: signal end-of-audio, await the trailing transcription, fire
    // onFinal(text) and resolve to that text (""=no speech). Safe when not running.
    async stop() {
        if (!this.running) return "";
        this.running = false;
        const epoch = this._epoch;          // capture: _settleFinal checks running, not epoch
        // Tell the server no more audio is coming so it flushes the last transcript.
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._send({ realtimeInput: { audioStreamEnd: true } });
        }
        return new Promise((resolve) => {
            this._finalResolve = resolve;
            // Overall cap: wait up to finalTimeoutMs for trailing transcription. The
            // server's transcription deltas can lag the audio by ~1–2 s, so we must
            // NOT arm the short quiet timer yet (that would resolve empty before the
            // first delta arrives) — the quiet timer is armed ONLY when a post-stop
            // delta lands (in _onMessage), so it just decides when a settled
            // transcript stops waiting for more. This cap covers "no delta ever".
            this._finalTimer = setTimeout(() => this._settleFinal(), GEMINI_LIVE_STT_TUNING.finalTimeoutMs);
            // If the socket is already gone, there's nothing to wait for — settle now.
            if (!this._ws || this._ws.readyState === WebSocket.CLOSED) this._settleFinal();
            // If a transcript already exists at stop() (the deltas kept pace with the
            // audio), it's likely complete — wait only finalQuietMs for a trailing
            // delta rather than the full finalTimeoutMs. A post-stop delta re-arms
            // this timer (in _onMessage), extending the wait if more is still coming.
            else if (this._transcript) this._armQuietTimer();
            void epoch;
        });
    }

    // Barge-in / interrupt: abort immediately, close the WS, fire NO onFinal.
    // Idempotent, never throws.
    cancel() {
        this.running = false;
        this._epoch++;                      // stale message/close events now dropped
        this._finalResolve = null;          // a cancelled turn produces no final
        this._clearTimers();
        this._pending = [];
        this._transcript = "";
        this._ready = false;
        const ws = this._ws;
        this._ws = null;
        if (ws) { try { ws.close(); } catch { /* already closing */ } }
    }

    // --- internals ---------------------------------------------------------

    _send(obj) {
        try { this._ws?.send(JSON.stringify(obj)); } catch { /* socket gone */ }
    }

    // One audio frame → realtimeInput.audio blob (16 kHz, 16-bit PCM, base64).
    _sendAudioFrame(pcm) {
        const down = resampleLinear(pcm, this._rate, GEMINI_LIVE_STT_TUNING.encodeRate);
        const b64 = pcm16Base64(down);
        this._send({ realtimeInput: { audio: { data: b64, mimeType: "audio/pcm;rate=16000" } } });
    }

    async _onMessage(e, epoch) {
        if (epoch !== this._epoch) return;       // stale (post stop/cancel) — drop
        let msg;
        try {
            // Worker may relay frames as text or as a Blob/ArrayBuffer; normalise.
            const raw = typeof e.data === "string"
                ? e.data
                : (e.data instanceof ArrayBuffer ? new TextDecoder().decode(e.data) : await e.data.text());
            msg = JSON.parse(raw);
        } catch { return; }

        if (msg.setupComplete) {
            this._ready = true;
            // Flush any audio buffered before the server was ready.
            const pend = this._pending; this._pending = [];
            if (this.running) for (const f of pend) this._sendAudioFrame(f);
            return;
        }

        const sc = msg.serverContent;
        if (sc && sc.inputTranscription && typeof sc.inputTranscription.text === "string") {
            const piece = sc.inputTranscription.text;
            if (piece) {
                // Incremental deltas — accumulate into the running transcript.
                this._transcript += piece;
                const text = this._transcript.trim();
                if (this.running) this._onPartial?.(text);
                // After audioStreamEnd a new delta means the tail is still arriving;
                // re-arm the quiet timer so we wait for it to settle.
                if (!this.running && this._finalResolve) this._armQuietTimer();
            }
        }
    }

    // Resolve stop()'s promise: fire onFinal with the accumulated transcript, close
    // the socket. Idempotent (no-op if already settled / never awaited).
    _settleFinal() {
        if (!this._finalResolve) { this._clearTimers(); return; }
        const resolve = this._finalResolve;
        this._finalResolve = null;
        this._clearTimers();
        const text = this._transcript.trim();
        this._epoch++;                          // ignore any further socket events
        const ws = this._ws;
        this._ws = null;
        if (ws) { try { ws.close(); } catch { /* */ } }
        this._onFinal?.(text);
        resolve(text);
    }

    // After audioStreamEnd, resolve early once finalQuietMs passes with no new delta.
    _armQuietTimer() {
        if (this._quietTimer) clearTimeout(this._quietTimer);
        this._quietTimer = setTimeout(() => this._settleFinal(), GEMINI_LIVE_STT_TUNING.finalQuietMs);
    }

    _clearTimers() {
        if (this._finalTimer) { clearTimeout(this._finalTimer); this._finalTimer = null; }
        if (this._quietTimer) { clearTimeout(this._quietTimer); this._quietTimer = null; }
    }
}

// Float32 mono PCM → little-endian 16-bit PCM → base64 string (browser & node).
function pcm16Base64(f32) {
    const n = f32.length;
    const buf = new ArrayBuffer(n * 2);
    const view = new DataView(buf);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    const bytes = new Uint8Array(buf);
    // btoa exists in browsers + CF Workers; Buffer is the node fallback (smoke test).
    if (typeof btoa === "function") {
        let bin = "";
        const CHUNK = 0x8000;       // avoid String.fromCharCode arg-count blowups
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }
    return Buffer.from(bytes).toString("base64");
}
