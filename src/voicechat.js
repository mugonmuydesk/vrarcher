// Voice conversation adapter: TAP A → mic records → TAP A again → speech becomes
// text (shown on a panel 1.5 m in front of the player) → text goes to Gemini →
// the reply is spoken back. This is the Babylon/WebXR touch around engine-clean
// pieces: the dialogue brain (gemini.js GeminiBrain), TTS (geminiSpeak), STT
// (speech.js MicRecorder + gemini.js geminiTranscribe). All game-facing
// behaviour lives in those; this file does input polling, the text plane and
// audio playback.
//
// Toggle to talk: tap A to start recording, tap again to send (no Web Speech
// API — absent on the Quest browser — so we record audio and transcribe it via
// Gemini). A safety cap auto-sends if recording runs too long.
//
// Hooks into the same `attend` seam NpcSystem exposes: when an NPC is attending
// the player, the spoken reply is panned toward it (npc.js notes attend is
// "where a dialogue turn would begin").

import { GeminiBrain, geminiSpeak, geminiSpeakStream, geminiTranscribe } from "./gemini.js";
import { MicRecorder } from "./speech.js";
import { FILLERS, splitFiller, fillerClip } from "./fillers.js";
import { resampleLinear } from "./vad.js";
import { prof } from "./profiler.js";
import { SpatialVoice } from "./voice-audio.js";

// Smart Turn v3 (turn.js audio EoU) is trained on 16 kHz mono — the warm mic runs
// at hardware rate (~48 kHz). Keep this in sync with the model's input rate.
const SMARTTURN_SR = 16000;

export const VOICE_TUNING = {
    hand: "right",          // controller whose button starts a listen
    buttonIndex: 4,         // xr-standard: 4 = A (right) / X (left); 5 = B/Y
    distance: 1.5,          // m — panel sits this far in front of the player
    drop: 0.25,             // m — below eye line so it doesn't block the view
    panelWidth: 0.70,       // m
    panelHeight: 0.42,      // m
    texW: 1024, texH: 614,  // panel texture (matches panel aspect)
    bodyChars: 26,          // wrap width for the spoken/reply lines
    fade: 0.18,             // s — panel fade in/out
    holdAfter: 5.0,         // s — keep the panel up this long after going idle
    maxRecordMs: 15000,     // safety auto-send if recording runs past this
    minPeak: 0.01,          // amplitude below this = the mic captured silence
    streamTTS: true,        // stream audio (play on 1st chunk ~1s) vs whole-clip (~5s)
    key: "KeyV",            // desktop toggle: tap V to start/stop (flat-mode testing)

    // ── Hands-free loop (Phase 2–4: always-on mic + VAD + turn detection) ──────
    // Default is HANDS-FREE: the warm mic listens continuously and the addressing
    // gaze target (ctx.addressing.target) gates WHEN we treat speech as intent.
    // Set pushToTalk:true to restore the legacy A-button / V-key tap-to-talk path
    // (the always-on mic stays off in that mode).
    pushToTalk: false,      // false = hands-free (VAD); true = legacy tap-to-talk button/key
    bargeFade: 0.06,        // s — fade-out applied to in-flight TTS when the player barges in
    handsFreeMaxMs: 15000,  // ms — safety cap on a single hands-free capture (mirrors maxRecordMs)
    preRollSec: 2.0,        // s — continuous look-back buffer prepended to a capture on speech
                            //     onset, so the utterance start isn't clipped by VAD detection lag
    micBlockSize: 4096,     // samples — warm-mic capture block (AudioWorklet, ScriptProcessor fallback)
    chunkLeadSec: 0.05,     // s — lead added to the first streamed TTS chunk's start time so the
                            //     AudioContext clock has a moment to schedule before playback
};

const STATUS = {
    idle: "",
    listening: "● recording — tap A again to send",
    thinking: "… transcribing",
    speaking: "♪ speaking",
    error: "! mic unavailable",
};

export class VoiceChat {
    // opts: { persona, brain, recorder, transcribe, speak, speakStream,
    //         vad, turn, stt } — all injectable so demos can run the pipeline
    //   without a mic or the network. vad/turn/stt are usually wired in by
    //   main.js after construction via attachHandsFree() (they load async), but
    //   may be injected here for tests.
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        // memoryKey makes the companion REMEMBER recent turns across reloads
        // (persisted to localStorage; see GeminiBrain). Wren is the player's
        // single companion, so one stable key.
        this.brain = opts.brain ?? new GeminiBrain({ persona: opts.persona, memoryKey: "companion" });
        this.recorder = opts.recorder ?? new MicRecorder();
        this.transcribe = opts.transcribe ?? geminiTranscribe;
        this.speak = opts.speak ?? geminiSpeak;             // whole-clip fallback
        this.speakStream = opts.speakStream ?? geminiSpeakStream;

        // Hands-free pieces (Phase 2–4). May be null until attachHandsFree() runs
        // (VAD loads its ONNX model asynchronously). When null the loop simply
        // never auto-starts — push-to-talk still works.
        this.vad = opts.vad ?? null;     // VadService (vad.js) — fires speech start/end/barge-in
        this.turn = opts.turn ?? null;   // TurnDetector (turn.js) — promotes a VAD endpoint to a real turn-end
        this.stt = opts.stt ?? null;     // SttStream (stt-stream.js) — streaming transcription

        this._warmMic = null;            // { ac, stream, src, proc, zero } — always-on mic tap
        this._capturing = false;         // a hands-free utterance is being captured (mic → STT)
        this._partialText = "";          // latest streaming partial transcript (turn-end text signal)
        this._captureMs = 0;             // ms of audio captured this hands-free utterance
        this._endChecking = false;       // a turn.isTurnComplete() call is in flight (don't overlap)
        // PORT: Smart-Turn input. Rolling mono utterance buffer (raw mic rate, from
        // speech onset) accumulated in the capture path and passed as `audio` to the
        // TurnDetector at the silence boundary so Smart Turn v3 can score it. Cleared
        // on turn-end and on interrupt/barge-in.
        this._uttBuf = [];               // Float32Array[] — captured mono frames this utterance
        this._uttLen = 0;                // total samples accumulated in _uttBuf
        this._preRoll = [];              // Float32Array[] — continuous look-back ring (pre-onset audio)
        this._preRollLen = 0;            // total samples currently held in the look-back ring
        this._forcePushToTalk = false;   // set if the warm-mic init fails → fall back to button/key

        this.busy = false;       // a turn (transcribe→chat→speak) is in flight
        this.recording = false;  // A is held and the mic is capturing
        this.state = "idle";     // idle | listening | thinking | speaking | error
        this.lastText = "";      // what the player said (the requested on-screen text)
        this.lastReply = "";     // what the NPC replied (also shown, dimmer)
        this.lastPlayedSec = 0;  // duration of the last spoken clip (demo assert)

        this._prevBtn = false;
        this._startP = null;     // pending recorder.start() (guards fast taps)
        this._recT = 0;          // record elapsed (for the safety auto-stop)
        this._turn = 0;          // turn counter — a tap during a turn invalidates it
        this._activeSrc = [];    // live TTS audio sources (stoppable on interrupt)
        this._voice = null;      // SpatialVoice adapter (3D NPC voice), lazy on first play
        this._alpha = 0;
        this._hold = 0;
        this._fillerBank = null;   // AudioBuffer[] (baked filled-pause clips), lazy
        this._fillerBankP = null;  // in-flight load
        this._buildPanel();
        ctx.updatables.push((dt) => this._tick(dt));
        // Warm the filler bank in the background so the first turn is snappy too.
        this._ensureFillerBank();

        // Desktop toggle (push-to-talk only): tap VOICE_TUNING.key to start
        // recording, tap again to send (mirrors the A button). Lets the legacy
        // loop be tested in flat Chrome without XR / the emulator. `e.repeat`
        // ignores X11 auto-repeat so holding the key doesn't toggle repeatedly.
        // In hands-free mode the key is inert (the mic + VAD drive the loop).
        window.addEventListener("keydown", (e) => {
            if (e.code !== VOICE_TUNING.key || e.repeat) return;
            if (this._pttActive) this._toggleRecord();
        });
    }

    // Push-to-talk is active when configured OR when the hands-free mic init failed
    // and we fell back at runtime — the A-button / V-key path honors this so a dead
    // mic still leaves a way to talk.
    get _pttActive() { return VOICE_TUNING.pushToTalk || this._forcePushToTalk; }

    // --- hands-free wiring (Phase 2–4) -----------------------------------
    // Wire in the always-on-mic loop once vad/turn/stt exist (main.js calls this
    // after createVad() resolves). Idempotent. In push-to-talk mode it's a no-op
    // (the warm mic + VAD aren't started, so the button/key path is untouched).
    attachHandsFree({ vad, turn, stt } = {}) {
        if (vad) this.vad = vad;
        if (turn) this.turn = turn;
        if (stt) this.stt = stt;
        if (VOICE_TUNING.pushToTalk) return;          // legacy mode: don't arm the mic
        if (!this.vad) return;                        // nothing to drive the loop yet
        // Route VAD events into the loop. setCompanionSpeaking() is toggled around
        // TTS playback so barge-in is only evaluated while the companion talks.
        this.vad.gate.onSpeechStart = () => this._onSpeechStart();
        this.vad.gate.onSpeechEnd = () => { this._onSpeechEnd(); };
        this.vad.gate.onBargeIn = () => this._onBargeIn();
        this._startWarmMic();
    }

    // Open a continuous warm mic that feeds VAD every frame (and, while a turn is
    // being captured, the streaming STT). Distinct from this.recorder (the
    // push-to-talk recorder): the hands-free mic must run ALL the time so the VAD
    // can hear the onset before any button. Mirrors speech.js's graph (warm mic →
    // ScriptProcessor → silent sink). Mic permission must already be granted on
    // the flat page (an immersive session can't prompt).
    async _startWarmMic() {
        if (this._warmMic || typeof navigator === "undefined") return;
        if (!(navigator.mediaDevices?.getUserMedia)) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const AC = window.AudioContext || window.webkitAudioContext;
            const ac = new AC();
            try { await ac.resume(); } catch { /* gesture pending */ }
            const src = ac.createMediaStreamSource(stream);
            const zero = ac.createGain(); zero.gain.value = 0; // silent sink (no echo)
            // Profiled: this is the per-block main-thread voice work (pre-roll + STT
            // pushAudio incl. any resample + posting to the VAD worker).
            const onFrame = (frame) => prof.timeSync("onMicFrame", () => this._onMicFrame(frame, ac.sampleRate));
            // PREFER an AudioWorklet: capture runs on the audio rendering thread, so it
            // adds no main-thread work and can't glitch when the render loop is busy
            // (the failure mode of the deprecated ScriptProcessor). Fall back to the
            // ScriptProcessor if the worklet can't load (older browser / addModule
            // failure) so capture always works.
            let node = null, proc = null;
            try {
                if (!ac.audioWorklet) throw new Error("AudioWorklet unsupported");
                await ac.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));
                node = new AudioWorkletNode(ac, "mic-capture", {
                    numberOfInputs: 1, numberOfOutputs: 1,
                    channelCount: 1, channelCountMode: "explicit", // force mono downmix (matches the old 1-ch ScriptProcessor)
                    processorOptions: { blockSize: VOICE_TUNING.micBlockSize },
                });
                node.port.onmessage = (e) => onFrame(e.data);
                src.connect(node); node.connect(zero); zero.connect(ac.destination);
            } catch (we) {
                // PORT: ScriptProcessor is deprecated; the native Quest capture path uses
                // an AudioWorklet / native mic callback for the same per-block mono frames.
                console.warn("[voicechat] AudioWorklet unavailable; using ScriptProcessor mic:", we?.message || we);
                node = null;
                proc = ac.createScriptProcessor(VOICE_TUNING.micBlockSize, 1, 1);
                proc.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0));
                src.connect(proc); proc.connect(zero); zero.connect(ac.destination);
            }
            this._warmMic = { ac, stream, src, node, proc, zero };
            this._micRate = ac.sampleRate;
            // Keep VAD's per-frame timing honest on 44.1 kHz hardware (vad.feed reads
            // inputRate every frame; default 48000 skews the hangover/onset math).
            if (this.vad) this.vad.inputRate = ac.sampleRate;
            console.log("[voicechat] hands-free mic armed (" + (node ? "AudioWorklet" : "ScriptProcessor") + "; VAD backend:", this.vad?.backend ?? "?", ")");
        } catch (e) {
            // Mic init failed: don't leave a dead "error" state with no way to talk —
            // fall back to push-to-talk so the A-button / V-key path goes live.
            this._forcePushToTalk = true;
            console.warn("[voicechat] hands-free mic init failed → push-to-talk:", e.message);
            this.state = "error"; this._hold = VOICE_TUNING.holdAfter; this._render();
        }
    }

    // One always-on mic block. Feed it to the VAD (drives onset/end/barge-in)
    // and, while capturing an utterance, to the streaming STT. The VAD callbacks
    // are async-fired off this; we don't await them here so the audio graph never
    // stalls.
    _onMicFrame(frame, rate) {
        if (!this.vad) return;
        // Continuous look-back ring: always keep the last VOICE_TUNING.preRollSec of
        // mic audio so the spoken START of an utterance (uttered BEFORE the VAD
        // confirms onset) can be prepended to the capture instead of being clipped.
        this._pushPreRoll(frame, rate);
        // STT capture: copy the frame in (Web Audio reuses the buffer).
        if (this._capturing) {
            // Smart-Turn input: accumulate the captured mono frames (raw mic rate,
            // from onset) so the TurnDetector can score the utterance audio at the
            // silence boundary. Copy — Web Audio reuses the underlying buffer.
            this._uttBuf.push(new Float32Array(frame));
            this._uttLen += frame.length;
            if (this.stt) this.stt.pushAudio(frame);
            this._captureMs += (frame.length / rate) * 1000;
            if (this._captureMs >= VOICE_TUNING.handsFreeMaxMs) this._finishHandsFree();
        }
        // VAD: resample + frame + model inference happen inside vad.feed().
        this.vad.feed(new Float32Array(frame)).catch(() => { /* model hiccup → next frame */ });
    }

    // Maintain the continuous look-back ring (last VOICE_TUNING.preRollSec of mic
    // audio). Frames are copied on entry (Web Audio reuses the buffer); the oldest
    // are dropped once the ring exceeds its sample cap. PORT: a fixed-size ring of
    // the native capture callback's mono frames; the same audio seeds the utterance.
    _pushPreRoll(frame, rate) {
        const cap = Math.floor((VOICE_TUNING.preRollSec || 0) * rate);
        if (cap <= 0) return;
        this._preRoll.push(new Float32Array(frame));
        this._preRollLen += frame.length;
        while (this._preRoll.length > 1 && this._preRollLen - this._preRoll[0].length >= cap) {
            this._preRollLen -= this._preRoll.shift().length;
        }
    }

    // VAD onset while a gaze target is held → start capturing this utterance.
    // Gated by ctx.addressing.target: speech with no addressee is ignored, so the
    // companion only listens when you're looking at it (replaces "who" from PTT).
    _onSpeechStart() {
        if (VOICE_TUNING.pushToTalk) return;
        if (this._capturing) return;
        // If the companion is mid-turn, barge-in (not a fresh listen) handles it.
        if (this.busy) return;
        if (!this.ctx.addressing?.target) return;     // not addressing anyone → ignore
        this._beginHandsFreeCapture();
    }

    // VAD candidate endpoint (mic went quiet past the hangover): ask the turn
    // detector whether this is a real end-of-turn or just a mid-thought pause. If
    // it's a real end → finalize + answer; if not → keep listening (the player is
    // mid-sentence; capture continues and the next silence re-checks).
    async _onSpeechEnd() {
        if (!this._capturing || this._endChecking) return;
        this._endChecking = true;
        try {
            const gazeHeld = !!this.ctx.addressing?.target;
            let verdict = { complete: true, reason: "no-turn-detector" };
            if (this.turn) {
                verdict = await this.turn.isTurnComplete({
                    // Profiled: flatten + 16 kHz resample of the whole utterance runs
                    // on main at end-of-turn (up to ~8 s of audio) — a hitch suspect.
                    audio: prof.timeSync("uttResample", () => this._utteranceAudio16k()), // Smart-Turn input, resampled to 16 kHz
                    partialText: this._partialText,
                    gazeHeld,
                    utteranceMs: this._captureMs,
                });
            }
            if (verdict.complete && this._capturing) {
                this._finishHandsFree();
            }
            // not complete → mid-thought pause: keep capturing, await next silence.
        } catch (e) {
            console.warn("[voicechat] turn check failed; ending turn:", e.message);
            if (this._capturing) this._finishHandsFree();
        } finally {
            this._endChecking = false;
        }
    }

    // VAD barge-in: the player started talking over the companion. Cut the
    // companion off (stop scheduled TTS chunks), splice the truncated assistant
    // turn + the player's new words into the brain history, and begin capturing
    // the interruption as a fresh utterance.
    _onBargeIn() {
        if (VOICE_TUNING.pushToTalk) return;
        if (!this.ctx.addressing?.target) return;     // not addressing anyone → ignore
        this._spliceTruncatedTurn();                  // record what Wren got to say
        this._interrupt();                            // bump turn-guard + silence audio
        if (!this._capturing) this._beginHandsFreeCapture();
    }

    // Begin (or restart) a hands-free utterance capture: clear partials, start the
    // streaming STT over the warm mic, flip UI to listening.
    _beginHandsFreeCapture() {
        this._capturing = true;
        // Seed the utterance with the pre-roll ring so the spoken start (uttered
        // before the VAD confirmed onset) isn't clipped. The ring frames were already
        // copied on entry, so snapshot the list and reuse the references.
        this._uttBuf = this._preRoll.slice();
        this._uttLen = this._preRollLen;
        this._captureMs = (this._uttLen / (this._micRate || 48000)) * 1000;
        this._partialText = "";
        this.lastText = ""; this.lastReply = ""; this._timingLine = "";
        this.state = "listening"; this._render();
        if (this.stt) {
            this.stt.start({
                sampleRate: this._micRate || this._warmMic?.ac?.sampleRate,
                onPartial: (t) => { this._partialText = t; this.lastText = t; this._render(); },
            });
            // Feed the look-back audio into the STT buffer too, so the transcript
            // includes the utterance's start, not just what arrived after onset.
            for (const f of this._uttBuf) this.stt.pushAudio(f);
        }
    }

    // Flatten the accumulated mono frames into one Float32Array (raw mic rate) for
    // the TurnDetector's Smart-Turn scorer. Returns undefined if nothing captured
    // (the scorer then abstains). PORT: native passes the same mono utterance buffer.
    _utteranceAudio() {
        if (!this._uttLen) return undefined;
        const out = new Float32Array(this._uttLen);
        let off = 0;
        for (const f of this._uttBuf) { out.set(f, off); off += f.length; }
        return out;
    }

    // Same utterance buffer, resampled from the raw mic rate to 16 kHz for the
    // TurnDetector's Smart Turn v3 audio scorer (it's trained on 16 kHz mono).
    // Returns undefined when nothing was captured (the scorer then abstains).
    // PORT: native passes the same mono utterance buffer at the model's input rate.
    _utteranceAudio16k() {
        const raw = this._utteranceAudio();
        if (!raw) return undefined;
        const rate = this._micRate || 48000;
        return rate === SMARTTURN_SR ? raw : resampleLinear(raw, rate, SMARTTURN_SR);
    }

    // End a hands-free utterance: stop the STT (final transcript), then run the
    // normal answer pipeline (brain → speak). Turn-guarded like _finishRecording.
    async _finishHandsFree() {
        if (!this._capturing) return;
        this._capturing = false;
        this._uttBuf = []; this._uttLen = 0;          // clear Smart-Turn buffer on turn-end
        const turn = ++this._turn;
        this.busy = true;
        this.state = "thinking"; this._render();
        let text = "";
        try {
            text = this.stt ? await this.stt.stop() : this._partialText;
        } catch (e) {
            console.warn("[voicechat] streaming STT stop failed:", e.message);
            text = this._partialText;
        }
        if (turn !== this._turn) return;              // interrupted while finalising
        if (!text) {
            this.lastText = "(didn't catch that)"; this._endTurn(turn); return;
        }
        this._timing = { stt: 0 };                    // streaming STT folds into capture; no batch wait
        this.lastText = text; this._render();
        await this._answer(text, turn);
        this._endTurn(turn);
    }

    // Barge-in bookkeeping: write the interrupted exchange into the brain's
    // history so the "…I think we should go to the castle" interleave is
    // preserved — the truncated assistant turn (what Wren actually voiced) plus
    // the player's interrupting words. Without this the model loses the thread of
    // what it was cut off mid-saying. The fresh user input is committed normally
    // by the next brain.respond().
    _spliceTruncatedTurn() {
        const brain = this.brain;
        if (!brain?.history) return;
        const reply = this.lastReply;
        if (!reply) return;
        const last = brain.history[brain.history.length - 1];
        if (!(last && last.role === "model" && last.parts?.[0]?.text === reply)) return;
        // Estimate how much of the reply was actually VOICED, from the audio clock at
        // interrupt time, so the model sees only what the player heard — not text it
        // never voiced. scheduledSec = how much TTS was scheduled; spokenSec = how
        // much had sounded by now. frac = clamp(spokenSec/scheduledSec, 0..1).
        const a = this.ctx.feedback?.audio;
        const t0 = this._playAudioT0, playhead = this._playPlayhead;
        if (a && t0 != null && playhead > t0) {
            const spokenSec = a.currentTime - t0;
            const scheduledSec = playhead - t0;
            const frac = Math.max(0, Math.min(1, spokenSec / scheduledSec));
            const words = reply.split(/\s+/).filter(Boolean);
            const n = Math.max(1, Math.round(frac * words.length));
            const spoken = words.slice(0, n).join(" ");
            // Store the truncated text as the model turn (preserving history order:
            // user, truncated-model, then the next user utterance committed by respond()).
            last.parts[0].text = (n < words.length) ? spoken + " —" : spoken;
            return;
        }
        // No usable timing → fall back to tagging the full reply as interrupted.
        last.parts[0].text = reply + " (interrupted)";
        // The player's interrupting utterance is added as a normal user turn by the
        // forthcoming brain.respond() once the barge-in capture completes.
    }

    // One tap, always responsive:
    //   recording        → stop + send
    //   transcribing/talking (busy) → interrupt (stop Wren) + start a fresh take
    //   idle             → start recording
    _toggleRecord() {
        if (this.recording) { this._finishRecording(); return; }
        if (this.busy) this._interrupt();
        this._startRecording();
    }

    // Cancel an in-flight turn (transcribe/chat/speak): bump the turn so its late
    // results are dropped, silence Wren, and clear busy so a new take can begin.
    _interrupt() {
        this._turn++;
        this._stopAudio();
        this.busy = false;
        this.stt?.cancel();              // abort any in-flight transcription for the abandoned turn
        this._uttBuf = []; this._uttLen = 0; // drop the Smart-Turn buffer for the abandoned utterance
        // The companion is no longer speaking after an interrupt; barge-in must
        // re-arm only on the next reply.
        this.vad?.setCompanionSpeaking(false);
    }

    // Stop any TTS audio currently playing/scheduled (immediate silence). New
    // chunks from a still-streaming interrupted turn are dropped by the turn
    // guard in _playStream, so they never re-start.
    _stopAudio() {
        // Short stop delay (bargeFade) lets the currently-sounding sample finish
        // instead of hard-clipping mid-waveform (the audible click on a hard cut).
        // The turn guard in _playStream already drops any not-yet-scheduled chunks,
        // so this only trims the tail of what's already playing. PORT: a true
        // gain-ramp fade wants a per-source gain node; the streaming graph connects
        // sources directly, so this delayed-stop is the cheap equivalent.
        const a = this.ctx.feedback?.audio;
        const when = a ? a.currentTime + (VOICE_TUNING.bargeFade || 0) : 0;
        for (const s of this._activeSrc) {
            try { when ? s.stop(when) : s.stop(); } catch { /* already stopped */ }
        }
        this._activeSrc = [];
    }

    // --- public pipeline entry points ------------------------------------

    // Tap to start recording. Mic permission must already be granted (an
    // immersive XR session can't show a prompt — grant it on the flat page).
    async _startRecording() {
        if (this.busy || this.recording) return;
        if (!this.recorder.supported) {
            this.state = "error"; this._hold = VOICE_TUNING.holdAfter; this._render();
            return;
        }
        this.recording = true; this._recT = 0;
        this.state = "listening"; this.lastText = ""; this.lastReply = ""; this._timingLine = ""; this._render();
        try {
            this._startP = this.recorder.start();
            await this._startP;
        } catch (e) {
            console.warn("[voicechat] mic start failed:", e.message);
            this.recording = false;
            this.state = "error"; this.lastText = "(mic blocked — grant mic access)";
            this._hold = VOICE_TUNING.holdAfter; this._render();
        }
    }

    // Tap again: stop recording, transcribe, then answer + speak. Turn-guarded so
    // an interrupt mid-flight abandons this take cleanly.
    async _finishRecording() {
        if (!this.recording) return;
        this.recording = false;
        const turn = ++this._turn;
        this.busy = true;
        this.state = "thinking"; this._render();
        let rec;
        try {
            await this._startP;             // ensure start() finished (fast taps)
            rec = await this.recorder.stop();
        } catch (e) {
            console.warn("[voicechat] recorder.stop failed:", e.message);
            this.lastText = "(recording error)"; this._endTurn(turn); return;
        }
        if (turn !== this._turn) return;    // interrupted
        if (!rec || rec.sampleCount === 0) {
            this.lastText = "(no audio captured)"; this._endTurn(turn); return;
        }
        const t0 = performance.now();
        let text = "";
        try {
            text = await this.transcribe(rec.wav);
        } catch (e) {
            console.warn("[voicechat] transcribe failed:", e.message);
            this.lastText = "(transcription failed)"; this._endTurn(turn); return;
        }
        if (turn !== this._turn) return;    // interrupted while transcribing
        this._timing = { stt: performance.now() - t0, peak: rec.peak, recSec: rec.durationSec };
        if (!text) {
            this.lastText = rec.peak < VOICE_TUNING.minPeak
                ? "(silence — mic heard nothing)" : "(didn't catch that)";
            this._endTurn(turn); return;
        }
        this.lastText = text; this._render();
        await this._answer(text, turn);
        this._endTurn(turn);
    }

    // Release busy + go idle, but only if this is still the current turn (an
    // interrupt that started a new take must not be clobbered).
    _endTurn(turn) {
        if (turn !== this._turn) return;
        this.busy = false;
        this._toIdle();
    }

    // Skip the mic: feed a transcript straight through (used by demos / a
    // keyboard fallback). Returns the reply string.
    async injectTranscript(text) {
        if (this.busy) return "";
        const turn = ++this._turn;
        this.busy = true;
        this.lastText = text; this.lastReply = ""; this._render();
        const reply = await this._answer(text, turn);
        this._endTurn(turn);
        return reply;
    }

    // --- internals -------------------------------------------------------

    async _answer(userText, turn) {
        const T = this._timing || (this._timing = {});
        this.state = "thinking"; this._render();
        let reply;
        const tA = performance.now();
        try {
            reply = await this.brain.respond(userText, this._gameState());
        } catch (e) {
            console.warn("[voicechat] brain failed:", e.message);
            reply = "Sorry — my mind wandered. Say again?";
        }
        if (turn !== this._turn) return reply;  // interrupted during chat
        const tB = performance.now();
        T.chat = tB - tA;                       // dialogue model round-trip
        this.lastReply = reply; this.state = "speaking"; this._render();
        this._playStartedAt = null;
        // Arm barge-in: tell the VAD the companion is now speaking so sustained
        // speech over it raises a barge-in (vad.js gate). Cleared in finally.
        this.vad?.setCompanionSpeaking(true);
        try {
            await this._speakAndPlay(reply, turn); // sets _playStartedAt at first sound
        } catch (e) {
            console.warn("[voicechat] speak failed:", e.message);
        } finally {
            this.vad?.setCompanionSpeaking(false);
        }
        if (turn !== this._turn) return reply;  // interrupted during speech
        // tts here means "reply ready → first sound out" (for streaming, ~1 s).
        T.tts = (this._playStartedAt || performance.now()) - tB;
        // What you feel: tap-to-send → first sound out of Wren.
        T.afterRelease = (T.stt || 0) + T.chat + T.tts;
        this._logTiming();
        return reply;
    }

    // Stream the reply to speech and play it gaplessly, starting on the first
    // chunk (~1 s). Falls back to whole-clip synth if streaming is off or fails.
    //
    // Filled-pause latency mask (Kokoro backend only): if the reply opens with a
    // banked filler (fillers.js), play that baked clip INSTANTLY as the first
    // sound and synthesise only the remainder — so the turn feels immediate. See
    // the snappy-conversation note in fillers.js.
    async _speakAndPlay(reply, turn) {
        this._activeSrc = [];
        let text = reply, prefix = null;
        // Filled-pause mask: the companion voice is Gemini and the baked bank is
        // in the Gemini voice, so it seams with live Gemini synthesis.
        if (this.ctx.voiceBackend === "gemini") {
            const split = splitFiller(reply);
            if (split) {
                const buf = await this._fillerBuffer(split.index);
                if (buf) { prefix = buf; text = split.remainder; }
            }
        }
        if (VOICE_TUNING.streamTTS) {
            try { await this._playStream(text, turn, prefix); return; }
            catch (e) { console.warn("[voicechat] stream TTS failed, falling back:", e.message); }
        }
        await this._play(await this.speak(text), turn);
    }

    // Schedule streamed PCM chunks back-to-back on the AudioContext clock so
    // they play as one continuous clip. `prefix` (an AudioBuffer, e.g. a baked
    // filler) is scheduled first and counts as the first sound, so the remainder
    // streams in gaplessly behind it.
    async _playStream(reply, turn, prefix = null) {
        const a = this.ctx.feedback?.audio;
        if (!a) { await this._play(await this.speak(reply), turn); return; }
        if (a.state === "suspended") { try { await a.resume(); } catch { /* gesture pending */ } }
        const t0 = a.currentTime;
        let playhead = 0, started = false;
        // Audio-clock timing for barge-in truncation: _playAudioT0 is when the first
        // sound was scheduled to begin, _playPlayhead is the audio-clock end of all
        // scheduled chunks. At interrupt, frac ≈ (a.currentTime - t0) / (playhead - t0)
        // is the fraction of the reply actually voiced (see _spliceTruncatedTurn).
        this._playAudioT0 = null;
        this._playPlayhead = 0;
        // Queue one mono buffer right after the previous one (+chunkLeadSec lead on
        // the first), advancing the playhead. Positioned at the attending NPC.
        const schedule = (buf) => {
            const src = a.createBufferSource();
            src.buffer = buf;
            // Route through the spatial-voice adapter (PannerNode at the NPC, listener
            // at the head) — positioned/updated per chunk so a moving NPC tracks. Falls
            // back to centred destination when no adapter/NPC. See voice-audio.js.
            this._routeVoice(src);
            const startAt = Math.max(a.currentTime + VOICE_TUNING.chunkLeadSec, playhead);
            if (!started) { started = true; this._playStartedAt = performance.now(); this._playAudioT0 = startAt; }
            src.start(startAt);
            this._activeSrc.push(src);     // stoppable on interrupt
            playhead = startAt + buf.duration;
            this._playPlayhead = playhead; // audio-clock end of what's scheduled so far
        };
        if (prefix) schedule(prefix);      // baked filler → near-zero time to first sound
        await this.speakStream(reply, {
            onChunk: (chunk, sampleRate) => {
                if (turn !== this._turn || !chunk.length) return; // interrupted → drop chunks
                const buf = a.createBuffer(1, chunk.length, sampleRate);
                buf.copyToChannel(chunk, 0);
                schedule(buf);
            },
        });
        this.lastPlayedSec = Math.max(0, playhead - t0);
        if (turn !== this._turn) return;
        const remainMs = Math.max(0, (playhead - a.currentTime) * 1000);
        if (remainMs > 0) await new Promise((r) => setTimeout(r, remainMs));
    }

    // Lazily fetch + decode the 32 baked filler clips into AudioBuffers, once.
    // Concurrent/repeat callers share one load; a missing clip stays null (that
    // filler just falls back to plain TTS).
    async _ensureFillerBank() {
        if (this._fillerBank) return this._fillerBank;
        if (this._fillerBankP) return this._fillerBankP;
        const a = this.ctx.feedback?.audio;
        if (!a) return null;               // no AudioContext yet — retry next call
        this._fillerBankP = (async () => {
            const bank = new Array(FILLERS.length).fill(null);
            await Promise.all(FILLERS.map(async (_, i) => {
                try {
                    const res = await fetch(`assets/fillers/${fillerClip(i)}.wav`);
                    if (!res.ok) return;
                    bank[i] = await a.decodeAudioData(await res.arrayBuffer());
                } catch { /* leave null → plain TTS for this filler */ }
            }));
            this._fillerBank = bank;
            return bank;
        })();
        return this._fillerBankP;
    }

    async _fillerBuffer(i) {
        const bank = await this._ensureFillerBank();
        return bank?.[i] || null;
    }

    _logTiming() {
        const T = this._timing; if (!T) return;
        const s = (x) => (x == null ? "?" : (x / 1000).toFixed(1) + "s");
        const full = `transcribe ${s(T.stt)} (peak ${T.peak?.toFixed(2) ?? "?"}, rec ${s(T.recSec ? T.recSec * 1000 : null)}) · ` +
            `brain ${s(T.chat)} · TTS ${s(T.tts)} → after-release ${s(T.afterRelease)}`;
        console.log("[voicechat] latency:", full);
        this.ctx.debug?.set?.("voice latency", full);
        // Compact line for the in-headset panel.
        this._timingLine = `xcribe ${s(T.stt)} · brain ${s(T.chat)} · voice ${s(T.tts)} → ${s(T.afterRelease)}`;
    }

    _toIdle() { this.state = "idle"; this._hold = VOICE_TUNING.holdAfter; this._render(); }

    // Clean teardown of the warm hands-free mic: disconnect the capture node
    // (AudioWorklet or ScriptProcessor), stop the MediaStream tracks, and close the
    // capture AudioContext (distinct from ctx.feedback.audio — that one is shared and
    // NOT closed here). Not called automatically, but exists so a host can tear the
    // loop down cleanly.
    dispose() {
        const m = this._warmMic;
        if (!m) return;
        try { if (m.node) { m.node.port.onmessage = null; m.node.disconnect(); } } catch { /* already gone */ }
        try { m.proc?.disconnect(); } catch { /* already gone */ }
        try { m.zero.disconnect(); } catch { /* already gone */ }
        try { m.src.disconnect(); } catch { /* already gone */ }
        try { for (const t of m.stream?.getTracks?.() || []) t.stop(); } catch { /* no tracks */ }
        try { m.ac?.close?.(); } catch { /* already closed */ }
        this._warmMic = null;
    }

    // Live game state injected into each dialogue turn so Wren can react to how
    // the player is shooting. Kept terse; the persona tells her to use it only
    // when it fits, so she doesn't recite the score every line.
    _gameState() {
        const t = this.ctx.target;
        if (!t) return "";
        const shots = `${t.hits} ${t.hits === 1 ? "arrow" : "arrows"}`;
        const last = t.lastHit ? ` Their last arrow scored ${t.lastHit.score}.` : "";
        return `Live game state — the player's score is ${t.score} from ${shots} shot at the target.${last}`;
    }

    // Play mono PCM through the shared (already-unlocked) AudioContext. Pans
    // toward the nearest attending NPC if there is one, else plays centred.
    async _play({ samples, sampleRate }, turn) {
        this.lastPlayedSec = samples.length / sampleRate;
        const a = this.ctx.feedback?.audio;
        if (!a) return;
        if (a.state === "suspended") { try { await a.resume(); } catch { /* gesture pending */ } }
        const buf = a.createBuffer(1, samples.length, sampleRate);
        buf.copyToChannel(samples, 0);
        const src = a.createBufferSource();
        src.buffer = buf;
        const gain = a.createGain();
        gain.gain.value = 1;
        if (turn !== this._turn) return;
        src.connect(gain);
        // Route the tail through the spatial-voice adapter (3D PannerNode at the NPC,
        // listener at the head), falling back to centred destination. See voice-audio.js.
        this._routeVoice(gain);
        this._playStartedAt = performance.now(); // the moment sound actually begins
        this._activeSrc.push(src);               // stoppable on interrupt
        src.start();
        await new Promise((res) => { src.onended = res; });
    }

    // --- spatial NPC voice (voice-audio.js adapter) ------------------------

    // Lazily build the SpatialVoice over the shared SpatialAudio engine once the
    // AudioContext exists (it unlocks on the XR-entry gesture). The listener is
    // written centrally (main.js) — the voice only supplies its emitter.
    _ensureVoice() {
        const fb = this.ctx.feedback;
        if (!fb?.hasAudio) return null;
        const sp = fb.spatial;
        if (!this._voice || this._voice._sp !== sp) this._voice = new SpatialVoice(sp);
        return this._voice;
    }

    // Connect a TTS source/tail node into the spatial-voice output (PannerNode at
    // the addressed NPC), repositioning the emitter first. Falls back to centred
    // destination when the engine or an NPC isn't available.
    _routeVoice(node) {
        const voice = this._ensureVoice();
        if (!voice) { try { node.connect(this.ctx.feedback.audio.destination); } catch { /* no ctx */ } return; }
        const npc = this._emitterNpc();
        voice.attachTo(npc ? { position: npc.mover.position } : null);
        voice.update();
        node.connect(voice.output);
    }

    // The NPC the voice emits from: the addressed (gaze+proximity) target, else the
    // nearest "attending" NPC, else null. (Lifted verbatim from the old _npcPan.)
    _emitterNpc() {
        const npcs = this.ctx.npcs?.npcs;
        if (!npcs?.length) return null;
        let best = this.ctx.addressing?.target ?? null;
        if (!best) {
            const cam = this.ctx.scene?.activeCamera;
            if (!cam) return null;
            let bestD = Infinity;
            for (const n of npcs) {
                if (n.brain?.state !== "attend") continue;
                const d = Math.hypot(n.mover.position.x - cam.globalPosition.x, n.mover.position.z - cam.globalPosition.z);
                if (d < bestD) { bestD = d; best = n; }
            }
        }
        return best;
    }

    // --- per-frame: poll the A button + keep the panel in front of the head -
    _tick(dt) {
        const xr = this.ctx.xr;
        // Push-to-talk button poll — only in legacy mode. Hands-free mode is
        // driven entirely by the warm mic + VAD, so the A button is left free.
        if (this._pttActive && xr?.baseExperience?.state === 2) {
            let pressed = false;
            for (const c of xr.input.controllers) {
                if (c.inputSource?.handedness !== VOICE_TUNING.hand) continue;
                if (c.inputSource?.gamepad?.buttons?.[VOICE_TUNING.buttonIndex]?.pressed) pressed = true;
            }
            // Toggle: a tap (down-edge) starts recording; the next tap sends.
            if (pressed && !this._prevBtn) this._toggleRecord();
            this._prevBtn = pressed;
            // Safety: auto-send if recording runs past the cap.
            if (this.recording) {
                this._recT += dt;
                if (this._recT * 1000 >= VOICE_TUNING.maxRecordMs) this._finishRecording();
            }
        }

        // Keep the spatial voice tracking the NPC while speech is audible — the
        // per-chunk update covers gaps between chunks, this covers a long single clip
        // and continuous NPC movement during a reply. (The listener tracks the head
        // via the central updater in main.js.)
        if (this._voice && this._activeSrc.length) {
            const npc = this._emitterNpc();
            this._voice.attachTo(npc ? { position: npc.mover.position } : null);
            this._voice.update();
        }

        // Visibility: shown while busy, plus a hold-then-fade after going idle.
        if (this.state === "idle" && this._hold > 0) this._hold = Math.max(0, this._hold - dt);
        const want = (this.state !== "idle" || this._hold > 0) ? 1 : 0;
        const step = dt / VOICE_TUNING.fade;
        this._alpha = want > this._alpha ? Math.min(want, this._alpha + step) : Math.max(want, this._alpha - step);
        const plane = this._plane;
        if (!plane) return;   // front-of-player panel removed (replies show on the NPC HUD)
        if (this._alpha <= 0.001) { if (plane.isEnabled()) plane.setEnabled(false); return; }
        if (!plane.isEnabled()) plane.setEnabled(true);
        plane.visibility = this._alpha;

        const cam = this.ctx.scene.activeCamera;
        if (cam) {
            const fwd = cam.getDirection(BABYLON.Axis.Z);
            const horiz = new BABYLON.Vector3(fwd.x, 0, fwd.z);
            if (horiz.lengthSquared() < 1e-4) horiz.set(0, 0, 1);
            horiz.normalize();
            const p = cam.globalPosition.add(horiz.scale(VOICE_TUNING.distance));
            p.y = cam.globalPosition.y - VOICE_TUNING.drop;
            plane.position.copyFrom(p);
        }
    }

    // Front-of-player transcript panel REMOVED. Companion replies are voiced in
    // Tiers 2/3 and shown on the NPC head HUD (npchud.js) in Tier-1 text-only
    // mode. The dialogue state machine still tracks lastText/lastReply (read by
    // the HUD); with _plane null, _render() and the panel-follow tick are no-ops.
    _buildPanel() {
        this._plane = null;
        this._tex = null;
    }

    _wrap(text, n) {
        const words = (text || "").split(/\s+/).filter(Boolean);
        const lines = [];
        let line = "";
        for (const w of words) {
            if ((line + " " + w).trim().length > n) { if (line) lines.push(line); line = w; }
            else line = (line + " " + w).trim();
        }
        if (line) lines.push(line);
        return lines;
    }

    _render() {
        if (!this._plane) return;   // panel removed — nothing to draw
        const T = VOICE_TUNING;
        const g = this._tex.getContext();
        g.clearRect(0, 0, T.texW, T.texH);
        // Rounded translucent backdrop.
        g.fillStyle = "rgba(8, 12, 16, 0.74)";
        roundRect(g, 8, 8, T.texW - 16, T.texH - 16, 28);
        g.fill();

        let y = 70;
        // In hands-free mode the "listening" hint shouldn't tell the player to tap
        // a button (there's none); show a mic-listening line instead.
        let status = STATUS[this.state] || "";
        if (this.state === "listening" && !VOICE_TUNING.pushToTalk) status = "● listening…";
        if (status) {
            g.fillStyle = this.state === "error" ? "#ff9a7a" : "#7fd0ff";
            g.font = "32px monospace";
            g.fillText(status, 44, y);
            y += 24;
        }
        y += 36;

        // Player's spoken text (the requested "smallish text" line), bright.
        g.font = "bold 46px sans-serif";
        g.fillStyle = "#f2f4e8";
        for (const ln of this._wrap(this.lastText || "…", T.bodyChars)) {
            g.fillText(ln, 44, y); y += 58;
        }

        // NPC reply, dimmer amber, below.
        if (this.lastReply) {
            y += 18;
            g.font = "40px sans-serif";
            g.fillStyle = "#d8b46a";
            for (const ln of this._wrap(this.lastReply, T.bodyChars)) {
                g.fillText(ln, 44, y); y += 52;
            }
        }

        // Latency breakdown, small + dim, pinned to the bottom of the panel.
        if (this._timingLine) {
            g.font = "24px monospace";
            g.fillStyle = "#6f8a99";
            g.fillText(this._timingLine, 44, T.texH - 30);
        }
        this._tex.update();
    }
}

function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
}
