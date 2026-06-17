// Warm-mic capture processor — runs on the audio rendering thread (NOT the main
// thread), so always-on mic capture never adds main-thread jank and never glitches
// when the render loop is busy (the failure mode of the deprecated ScriptProcessor
// it replaces, whose onaudioprocess fires on main at audio priority). It just
// re-chunks the audio thread's 128-sample render quantums into blockSize-sample
// mono Float32 frames and posts each to the node's port (transferred, zero-copy).
// The main-thread shim (voicechat.js _startWarmMic) wires port.onmessage to
// _onMicFrame, which fans the frame out to the VAD worker + STT + pre-roll exactly
// as the ScriptProcessor path did — so nothing downstream changes.
//
// Self-contained: the AudioWorkletGlobalScope has no DOM and no module imports, so
// this is a plain classic script that registers one processor. blockSize comes in
// via processorOptions (defaults to 4096 to match VOICE_TUNING.micBlockSize, so the
// per-frame cadence downstream is unchanged from the ScriptProcessor era).
//
// PORT: native Quest uses the platform mic callback for the same per-block mono
// frames — this worklet is the web stand-in.

class MicCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this._blockSize = (o.blockSize > 0) ? (o.blockSize | 0) : 4096;
        this._buf = new Float32Array(this._blockSize);
        this._n = 0;
    }

    // Called per 128-sample render quantum. inputs[0][0] is the (mono-downmixed —
    // the node is configured channelCount:1) Float32 channel for this quantum, or
    // absent when nothing is connected yet. Accumulate into blockSize frames and
    // post each full one.
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length) {
            let i = 0;
            while (i < ch.length) {
                const take = Math.min(this._blockSize - this._n, ch.length - i);
                this._buf.set(ch.subarray(i, i + take), this._n);
                this._n += take;
                i += take;
                if (this._n >= this._blockSize) {
                    const frame = this._buf;                     // hand off the full block
                    this.port.postMessage(frame, [frame.buffer]); // transfer (zero-copy)
                    this._buf = new Float32Array(this._blockSize); // fresh (old one transferred away)
                    this._n = 0;
                }
            }
        }
        return true;   // keep the processor alive (capture is continuous)
    }
}

registerProcessor("mic-capture", MicCaptureProcessor);
