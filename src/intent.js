// On-device semantic intent classifier (Tier-1, no-LLM) for the VRarcher
// companion. This is the "RAG-without-generation" core: it maps a spoken command
// (a Vosk/Gemini transcript) to one of the companion STATES by embedding it with
// a STATIC embedding model (Model2Vec / potion-base-8M) and taking the cosine
// nearest per-state centroid, accepting only above a confidence threshold.
//
// A static embedding model is literally: tokenize -> gather one vector per token
// from a fixed matrix -> mean-pool -> L2-normalize. There is NO transformer
// forward pass, no ONNX, no WASM — just an array lookup and a sum. That makes it
// trivially compute-light (~0.004 ms/utterance) and pure-JS, so it ports as a
// direct transcription.
//
// Engine-clean: NO Babylon, NO network beyond fetching its own vendored data.
// Imports cleanly in node (used by the regression test) — it only loads the
// matrix/tokenizer lazily on first embed().
//
// Recipe provenance: validated in debug/intent-test/ (model2vec.mjs +
// command-bank.json). potion-base-8M + per-state centroid + threshold 0.325 ->
// 96% accuracy on the held-out set, 0% false-accept on chatter. The embed()
// here reproduces that recipe BIT-FOR-BIT (see the regression test).
//
// PORT: native uses the SAME finite-state machine and the SAME static-embedding
// lookup. The matrix (vendor/model2vec/embeddings.bin) and WordPiece tokenizer
// (vendor/model2vec/tokenizer.json) transcribe directly to a C#/Burst lookup;
// `embed()` is ~20 lines of arithmetic with native equivalents. A native
// embedder (or the same matrix) drops in behind the same classify() contract.

// --- Tuning (the port's re-tuning checklist) -------------------------------
export const INTENT_TUNING = {
    // Cosine acceptance threshold against the best per-state centroid. Below it,
    // the utterance is treated as chatter (not a command) — the FSM stays put.
    // Validated sweet spot: 0.325 (0% false-accept on chatter, 4% false-reject).
    threshold: 0.325,
    // Minimum top1-top2 cosine gap required to ACCEPT a SOCIAL match (not a
    // movement command or ask). The conversational centroids sit close together
    // (location vs whatnext, greet vs howareyou), so a confident-but-ambiguous
    // social win is downgraded to chatter ("say again") unless it clears the
    // best runner-up by this margin. Movement commands keep the plain threshold
    // (a wrong social line is cheap; a wrong move physically relocates Wren).
    // 0.06 sits under the observed held-out correct-social floor (~0.135) so it
    // costs no real recognition, while downgrading genuine coin-flips (e.g. terse
    // farewells brushing the location centroid) to in-character banter.
    socialMargin: 0.06,
    // Acceptance floor for SOCIAL matches — HIGHER than `threshold` (asymmetric
    // confidence). Social categories are broad and chatter-adjacent ("the weather
    // is lovely" brushes the greeting centroid ~0.39), so accepting them at the
    // command threshold (0.325) lets real chatter trigger small-talk. A wrong move
    // relocates Wren (costly) → commands keep 0.325; a missed greeting just falls
    // to in-character banter (cheap) → social can afford the stricter floor.
    // Tune in-headset alongside the other voice thresholds.
    socialThreshold: 0.40,
    dim: 256,                  // potion-base-8M embedding dimension
    // The validated recipe did NOT lowercase the input (its lowercase detector
    // looked for "Lowercase" but the tokenizer.json says "lowercase") — so the
    // vendored tokenizer.json carries lowercase:false to preserve that behaviour
    // exactly. Do not "fix" it without re-validating accuracy.
    baseURL: new URL("../vendor/model2vec/", import.meta.url),
};

// --- Lazy-loaded model data ------------------------------------------------
let _EMB = null;       // Float32Array(nTok * dim) — the embedding matrix
let _DIM = 0;
let _vocab = null;     // token string -> id
let _unkId = 0;
let _cont = "##";      // continuing-subword prefix
let _lower = false;    // whether to lowercase (validated: false)
let _loading = null;   // in-flight load promise (single-flight)

// Environment-agnostic byte/JSON fetch: browser uses fetch(); node uses fs.
async function _readBytes(url) {
    if (typeof fetch === "function" && typeof window !== "undefined") {
        const res = await fetch(url);
        if (!res.ok) throw new Error("intent: fetch " + url + " -> " + res.status);
        return new Uint8Array(await res.arrayBuffer());
    }
    // node fallback (regression test / engine-clean import check)
    const { readFile } = await import("node:fs/promises");
    const path = url instanceof URL ? url : new URL(url);
    return new Uint8Array(await readFile(path));
}
async function _readJSON(url) {
    const bytes = await _readBytes(url);
    return JSON.parse(new TextDecoder().decode(bytes));
}

export async function load() {
    if (_EMB) return;
    if (_loading) return _loading;
    _loading = (async () => {
        const base = INTENT_TUNING.baseURL;
        const [header, tok, matBytes] = await Promise.all([
            _readJSON(new URL("embeddings.json", base)),
            _readJSON(new URL("tokenizer.json", base)),
            _readBytes(new URL("embeddings.bin", base)),
        ]);
        const [nTok, dim] = header.shape;
        _DIM = dim;
        // Reinterpret the raw bytes as Float32 (little-endian, native order).
        // matBytes.buffer may carry a byteOffset; honour it.
        _EMB = new Float32Array(matBytes.buffer, matBytes.byteOffset, nTok * dim);
        _vocab = tok.vocab;
        _unkId = _vocab[tok.unk_token ?? "[UNK]"];
        _cont = tok.continuing_subword_prefix ?? "##";
        _lower = !!tok.lowercase;
    })();
    return _loading;
}

// --- Tokenizer (BERT basic + WordPiece), matching the validated recipe -----
function _basicTokens(text) {
    let t = text;
    if (_lower) t = t.toLowerCase();
    // split on whitespace + isolate punctuation (BERT basic-tokenizer approx)
    return t.replace(/([^\w\s]|_)/g, " $1 ").split(/\s+/).filter(Boolean);
}
function _wordpiece(word) {
    const out = [];
    let start = 0;
    const chars = [...word];
    while (start < chars.length) {
        let end = chars.length, cur = null;
        while (start < end) {
            let sub = chars.slice(start, end).join("");
            if (start > 0) sub = _cont + sub;
            if (_vocab[sub] !== undefined) { cur = _vocab[sub]; break; }
            end--;
        }
        if (cur === null) { out.push(_unkId); break; }
        out.push(cur);
        start = end;
    }
    return out;
}
function _tokenize(text) {
    const ids = [];
    for (const w of _basicTokens(text)) ids.push(..._wordpiece(w));
    return ids;
}

// --- embed(): tokenize -> mean-pool token vectors -> L2-normalize ----------
// Must be called after load(). Returns a Float32Array(dim). Reproduces the
// validated recipe exactly: UNK tokens are DROPPED from the mean (not summed).
export function embed(text) {
    if (!_EMB) throw new Error("intent.embed() called before load(); await load() first");
    const dim = _DIM;
    const v = new Float32Array(dim);
    const ids = _tokenize(text);
    let n = 0;
    for (const id of ids) {
        if (id === _unkId) continue;   // model2vec drops UNK from the mean
        const off = id * dim;
        for (let i = 0; i < dim; i++) v[i] += _EMB[off + i];
        n++;
    }
    if (n === 0) n = 1;
    for (let i = 0; i < dim; i++) v[i] /= n;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
}

export function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

// --- Per-state centroids (computed from the command bank) ------------------
// centroids: { state: Float32Array(dim) }, each a re-normalized mean of that
// state's example-utterance embeddings. STATES is the ordered state list.
let _centroids = null;
let _states = null;
// ASK centroids live in their OWN table so classify() can label a match's KIND
// ("state" vs "ask") — ask intents report from game state without an FSM move.
let _askCentroids = null;
let _askIntents = null;
// SOCIAL centroids — a THIRD table for conversational small-talk (greet, thanks,
// where-are-we, …) that, like asks, does NOT move the FSM; the brain answers
// with a rotating scripted line. classify() labels these kind:"social".
let _socialCentroids = null;
let _socialIntents = null;

// Build a { key: Float32Array(dim) } centroid table from a bank object
// { key: [exampleUtterance, ...] }. Call after load().
function _centroidsFor(bank) {
    const dim = _DIM;
    const out = {};
    for (const key of Object.keys(bank)) {
        const c = new Float32Array(dim);
        for (const phrase of bank[key]) {
            const e = embed(phrase);
            for (let i = 0; i < dim; i++) c[i] += e[i];
        }
        let nn = 0;
        for (let i = 0; i < dim; i++) nn += c[i] * c[i];
        nn = Math.sqrt(nn) || 1;
        for (let i = 0; i < dim; i++) c[i] /= nn;
        out[key] = c;
    }
    return out;
}

// Build the movement-state centroids from a bank object
// { state: [exampleUtterance, ...] }. Call after load(). Recomputes each call.
export function buildCentroids(bank) {
    if (!_EMB) throw new Error("intent.buildCentroids() called before load()");
    _states = Object.keys(bank);
    _centroids = _centroidsFor(bank);
    return _centroids;
}

// Build the ASK-intent centroids from an ask bank { intent: [phrase, ...] }.
// Optional — only needed if the caller wants ask classification. Call after
// load(). Recomputes each call.
export function buildAskCentroids(askBank) {
    if (!_EMB) throw new Error("intent.buildAskCentroids() called before load()");
    _askIntents = Object.keys(askBank);
    _askCentroids = _centroidsFor(askBank);
    return _askCentroids;
}

// Build the SOCIAL-intent centroids from a social bank { intent: [phrase, ...] }.
// Optional — only needed if the caller wants conversational classification. Call
// after load(). Recomputes each call.
export function buildSocialCentroids(socialBank) {
    if (!_EMB) throw new Error("intent.buildSocialCentroids() called before load()");
    _socialIntents = Object.keys(socialBank);
    _socialCentroids = _centroidsFor(socialBank);
    return _socialCentroids;
}

// classify(text) -> { state, score, confident, kind, intent, margin }
//   kind      : "ask" / "social" when the best centroid is an ask / social
//               intent, else "state"
//   intent    : the ask- OR social-intent key when kind!=="state", else null
//   state     : best-matching MOVEMENT state (always the best STATE centroid,
//               even when kind!=="state") — kept for back-compat callers
//   score     : cosine similarity to the OVERALL best centroid (any table)
//   confident : score >= threshold (treat as a real command/query, not chatter)
//   margin    : score minus the SECOND-best centroid across ALL tables — how
//               clearly the winner beat the runner-up. The brain uses this to
//               reject ambiguous SOCIAL near-ties (location vs whatnext, …).
// One combined nearest-centroid pass over movement states AND ask intents AND
// social intents (each only if its centroids are built). Ties break by table
// priority state > ask > social (a wrong move is costlier than a wrong line),
// matching the original strict-greater-than ask/state precedence. Requires
// load() + buildCentroids().
export function classify(text) {
    if (!_centroids) throw new Error("intent.classify() called before buildCentroids()");
    const v = embed(text);

    // Best movement state (always computed — back-compat .state).
    let bestState = null, stateScore = -2;
    for (const st of _states) {
        const s = cosine(v, _centroids[st]);
        if (s > stateScore) { stateScore = s; bestState = st; }
    }

    // Best ask intent (only if ask centroids are built).
    let bestAsk = null, askScore = -2;
    if (_askCentroids) {
        for (const k of _askIntents) {
            const s = cosine(v, _askCentroids[k]);
            if (s > askScore) { askScore = s; bestAsk = k; }
        }
    }

    // Best social intent (only if social centroids are built).
    let bestSocial = null, socialScore = -2;
    if (_socialCentroids) {
        for (const k of _socialIntents) {
            const s = cosine(v, _socialCentroids[k]);
            if (s > socialScore) { socialScore = s; bestSocial = k; }
        }
    }

    // Combined winner across all built tables. Strict > keeps the table priority
    // state > ask > social on a tie (preserving the original ask/state rule).
    let kind = "state", best = stateScore, intent = null;
    if (bestAsk !== null && askScore > best) { kind = "ask"; best = askScore; intent = bestAsk; }
    if (bestSocial !== null && socialScore > best) { kind = "social"; best = socialScore; intent = bestSocial; }

    // Runner-up across ALL tables (for the margin). Collect every table's best,
    // drop the winner, take the next highest — catches within-social near-ties.
    const tops = [stateScore];
    if (bestAsk !== null) tops.push(askScore);
    if (bestSocial !== null) tops.push(socialScore);
    tops.sort((a, b) => b - a);
    const runnerUp = tops.length > 1 ? tops[1] : -2;

    return {
        state: bestState,
        score: best,
        confident: best >= INTENT_TUNING.threshold,
        kind,
        intent,
        margin: best - runnerUp,
    };
}

// Convenience: ensure the model + centroids are ready in one call. Pass askBank
// / socialBank to also build those intent centroids (combined classification).
export async function init(bank, askBank = null, socialBank = null) {
    await load();
    buildCentroids(bank);
    if (askBank) buildAskCentroids(askBank);
    if (socialBank) buildSocialCentroids(socialBank);
}

export function isReady() { return !!_centroids; }
