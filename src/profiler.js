// Frame-hitch profiler — detects render frames slower than a target FPS and, for
// each hitch, reports WHICH instrumented voice operations ran that frame (and how
// much main-thread time each took), plus a snapshot of voice state and any browser
// `longtask` entries. The point is to find — empirically, on the headset — what is
// stalling the XR render loop during voice activity, and to EXONERATE voice when a
// hitch had little/no voice main-thread time (the `otherMs` bucket + longtasks).
//
// Reports are batched and POSTed to a `/hitch` endpoint (the Cloudflare Worker),
// where they're logged so a `wrangler tail` can watch hitches stream live while the
// player wears the headset. No transcript text is ever sent — only timings, counts,
// and coarse state enums.
//
// USAGE: one shared singleton `prof`. Instrumented modules call prof.add()/count()/
// timeSync() on hot paths; main.js calls prof.enable(ctx, {endpoint}) once and
// prof.frame() every render tick. Inert (near-zero cost) until enabled.
//
// ENGINE-CLEAN: no Babylon. PORT: profiling is web-specific (performance API +
// PerformanceObserver + fetch); a native build uses its own frame profiler — this
// module has no game behaviour, so the port simply omits it.

const round1 = (x) => Math.round(x * 10) / 10;

class Profiler {
    constructor() {
        this.enabled = false;
        this.ctx = null;
        this.endpoint = null;
        this.hitchMs = 50;          // 50 ms = 20 fps — a frame at/over this is a "hitch"
        this.maxBatch = 20;         // flush when this many reports queue
        this.flushMs = 2000;        // …or after this long with anything queued
        this._led = Object.create(null);   // name -> ms accumulated THIS frame
        this._cnt = Object.create(null);    // name -> event count THIS frame
        this._longtasks = [];               // longtask entries since the last frame
        this._buf = [];                      // pending hitch reports
        this._flushTimer = null;
        this._lastNow = 0;
        this._sid = "s" + Math.floor(Math.random() * 1e9).toString(36);
    }

    // Arm the profiler. endpoint is the absolute /hitch URL (main.js derives it from
    // the Gemini proxy base). Safe to call once; subsequent calls just update opts.
    enable(ctx, opts = {}) {
        this.ctx = ctx;
        this.endpoint = opts.endpoint ?? this.endpoint;
        this.hitchMs = opts.hitchMs ?? this.hitchMs;
        if (this.enabled) return;
        this.enabled = true;
        this._lastNow = (typeof performance !== "undefined" ? performance.now() : 0);
        this._initLongTasks();
    }

    // ── HOT-PATH HOOKS (cheap; no-op when disabled) ──────────────────────────
    add(name, ms) { if (this.enabled) this._led[name] = (this._led[name] || 0) + ms; }
    count(name, n = 1) { if (this.enabled) this._cnt[name] = (this._cnt[name] || 0) + n; }
    // Time a synchronous span. When disabled, just runs fn with no timing overhead.
    timeSync(name, fn) {
        if (!this.enabled) return fn();
        const t = performance.now();
        try { return fn(); } finally { this.add(name, performance.now() - t); }
    }

    // ── PER-RENDER-TICK ──────────────────────────────────────────────────────
    // Call once per render frame. Measures the wall-clock period since the last
    // tick (which balloons when a long main-thread task delays the next frame),
    // and if it crosses the hitch threshold records a report from the ledger of
    // work that ran during that period. Then resets the per-frame accumulators.
    frame() {
        if (!this.enabled) return;
        const now = performance.now();
        const period = now - this._lastNow;
        this._lastNow = now;
        if (period >= this.hitchMs) this._record(period);
        this._led = Object.create(null);
        this._cnt = Object.create(null);
        this._longtasks = [];
    }

    _record(period) {
        let voiceMs = 0;
        const spans = {};
        for (const k in this._led) { const v = this._led[k]; voiceMs += v; spans[k] = round1(v); }
        this._buf.push({
            sid: this._sid,
            t: Date.now(),
            frameMs: round1(period),
            fps: Math.round(1000 / period),
            voiceMs: round1(voiceMs),
            otherMs: round1(Math.max(0, period - voiceMs)),  // un-instrumented time (non-voice / GC / render)
            spans,
            counts: { ...this._cnt },
            longtasks: this._longtasks.slice(0, 5),
            state: this._snapshot(),
        });
        this._scheduleFlush();
    }

    // Coarse voice state — enums/flags only, NO transcript text (privacy).
    _snapshot() {
        const c = this.ctx || {};
        const vc = c.voicechat || {};
        return {
            vc: vc.state,                 // idle | listening | thinking | speaking | error
            capturing: !!vc._capturing,
            busy: !!vc.busy,
            endChecking: !!vc._endChecking,
            vad: c.vad?.backend,          // tenvad | silero | rms
            prob: typeof c.vad?.prob === "number" ? round1(c.vad.prob) : undefined,
            tier: c.voiceTier,
            stt: c.sttBackend,
            tts: c.voiceBackend,
            brain: c.brainBackend,
        };
    }

    _initLongTasks() {
        try {
            if (typeof PerformanceObserver === "undefined") return;
            const po = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    const attr = (e.attribution && e.attribution[0]) || null;
                    this._longtasks.push({ ms: Math.round(e.duration), n: attr?.name || e.name });
                }
            });
            po.observe({ entryTypes: ["longtask"] });
        } catch { /* longtask unsupported → otherMs still tells the story */ }
    }

    _scheduleFlush() {
        if (this._buf.length >= this.maxBatch) return this._flush();
        if (this._flushTimer || typeof setTimeout === "undefined") return;
        this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flush(); }, this.flushMs);
    }

    // POST queued reports to /hitch. Best-effort: telemetry must never break the
    // game, so all failures are swallowed.
    _flush() {
        if (!this.endpoint || !this._buf.length || typeof fetch === "undefined") return;
        const reports = this._buf.splice(0, this._buf.length);
        try {
            fetch(this.endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reports }),
                keepalive: true,
            }).catch(() => { /* swallow */ });
        } catch { /* swallow */ }
    }
}

// One shared instance imported across the voice modules + main.js.
export const prof = new Profiler();
