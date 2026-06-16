// TurnSense — TEXT end-of-utterance (EOU) scorer for the TurnDetector (turn.js).
//
// At a VAD silence boundary the TurnDetector asks "has the player FINISHED or just
// PAUSED?". This adapter answers from the WORDS of the partial transcript:
// latishab/turnsense (Apache-2.0), a SmolLM2-135M LoRA-finetuned EOU classifier,
// returns P(utterance complete) ∈ [0,1] from the text. It is the text complement to
// Smart Turn's acoustic scorer (smartturn.js) — fused in turn.js via requireBothAgree.
//
// DE-RISK (validated 2026-06-16 against the official Python reference, int8 ONNX):
//   COMPLETE   → "I'm ready." 0.94 · "let's go to the castle." 0.85 · "that's all." 0.56
//   INCOMPLETE → "can you tell me how to" 0.005 · "I think we should" 0.007 ·
//                "let me" 0.09 · "the reason is" 0.19
//   Clean separation WHEN the text is punctuated. CAVEAT: the model leans hard on
//   terminal punctuation — an unpunctuated complete question ("how far is the
//   target") scores LOW (0.10). Upstream STT punctuation quality drives accuracy;
//   the ensemble's silence/maxlen/gaze defaults cover the model's misses.
//
// VENDORED (int8 — see turn.js ship-weight note): vendor/turnsense/
//   model_quantized.onnx  (~176 MB int8 — 20× heavier than Smart Turn's 8.7 MB; this
//                          is the SHIP-WEIGHT cost of the text complement. OFF by
//                          default — opt in via TURN_TUNING.useTurnSense / injection.)
//   tokenizer.json        (SmolLM2 byte-level BPE — 49152 vocab, 48900 merges)
// The onnxruntime-web runtime is the SAME vendored ORT the Silero VAD + Smart Turn
// use (vendor/vad/ort.wasm.min.mjs + ort-wasm-simd-threaded.wasm).
//
// ONNX I/O (verified against the int8 model + Python reference):
//   input  "input_ids"       int64 [1, 256]  (right-padded to max_length=256, pad=2)
//   input  "attention_mask"  int64 [1, 256]  (1 for real tokens, 0 for padding)
//   output "probabilities"   float32 [1, 2]  — SOFTMAX IS INSIDE THE GRAPH.
//                                              [0]=P(incomplete), [1]=P(complete).
//                                              DO NOT softmax again; return data[1].
//   Inference run ONCE per turn (not per frame).
//
// PREPROCESSING — the OFFICIAL recipe, replicated bit-for-bit in JS:
//   • prefix the partial transcript: `<|user|> {text}`  (NOTE: <|user|> is NOT a
//     special token in this vocab — it tokenizes as the literal chars < | user | >;
//     no special-token handling is needed, and <|im_end|> is deliberately NOT added).
//   • tokenize with SmolLM2 byte-level BPE (GPT2-style: byte→unicode map, digits
//     split individually, greedy merge by rank). See tokenizeBPE() below.
//   • RIGHT-pad to exactly max_length=256 with pad id 2 (<|im_end|>); attention_mask
//     is 1 for the real tokens and 0 for the padding. The model attends through the
//     mask, so padded-to-256 scores differ slightly from unpadded — we pad to match
//     the training/reference recipe exactly (verified vs Python: identical ids).
//
// ENGINE-CLEAN: the tokenizer is pure standalone functions (node-testable, no ORT,
// no Babylon at parse time); the ORT import is LAZY (inside createTurnSenseScorer)
// so this file parses under `node --check`. On any load/init failure the factory
// THROWS so the caller (TurnDetector) treats a missing scorer as abstain and falls
// back to the silence+heuristic+gaze path unchanged — mirrors smartturn.js exactly.
//
// PORT: the native Quest port runs the IDENTICAL model + front-end — TurnSense becomes
// native ONNX (ONNX Runtime Mobile / NNAPI) behind the same textEouScore seam; the
// byte-level BPE here transcribes one-to-one to a native GPT2 BPE tokenizer (the
// vendored tokenizer.json is the spec). No behaviour lives only in JS.

// ─────────────────────────────────────────────────────────────────────────────
// Tuning / spec constants — native-port re-tuning + front-end checklist. These MUST
// match the vendored tokenizer.json and the model's training front-end. Do not
// change in isolation.
// ─────────────────────────────────────────────────────────────────────────────
export const TURNSENSE_TUNING = {
    maxLength: 256,           // pad/truncate to this token length (training max_length)
    padId: 2,                 // <|im_end|> — the pad token id (right-padded)
    prefix: "<|user|> ",      // official input prefix (NOT a special token; literal chars)
    // Vendored asset paths (resolved to ABSOLUTE URLs against document.baseURI).
    modelPath: "vendor/turnsense/model_quantized.onnx",
    tokenizerPath: "vendor/turnsense/tokenizer.json",
    // Reuse the Silero VAD's vendored ORT (same wasm) — see header dist note.
    ortModule: "vendor/vad/ort.wasm.min.mjs",
    ortWasmDir: "vendor/vad/",
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE TOKENIZER — SmolLM2 / GPT2 byte-level BPE. All node-testable, no ORT/Babylon.
// Regression-tested against the Python AutoTokenizer in debug/turnsense-test/.
// ─────────────────────────────────────────────────────────────────────────────

// GPT2 "byte→unicode" map: the reversible mapping that lets byte-level BPE operate on
// printable unicode codepoints (so merges in tokenizer.json — which are unicode
// strings like "Ġt" — apply to raw UTF-8 bytes). Identical to HF's
// bytes_to_unicode(): printable ASCII/Latin ranges map to themselves; every other
// byte maps to U+0100+n. Built once, memoised.
let _byteToUni = null;
export function byteToUnicode() {
    if (_byteToUni) return _byteToUni;
    const bs = [];
    for (let i = 0x21; i <= 0x7e; i++) bs.push(i);      // '!'..'~'
    for (let i = 0xa1; i <= 0xac; i++) bs.push(i);      // '¡'..'¬'
    for (let i = 0xae; i <= 0xff; i++) bs.push(i);      // '®'..'ÿ'
    const cs = bs.slice();
    let n = 0;
    for (let b = 0; b < 256; b++) {
        if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
    }
    const map = new Array(256);
    for (let i = 0; i < bs.length; i++) map[bs[i]] = String.fromCharCode(cs[i]);
    _byteToUni = map;
    return map;
}

// Pre-tokenizer regex — the GPT2 "use_regex" split (contractions, letters, numbers,
// punctuation, whitespace runs). The vendored pre_tokenizer is Sequence[ Digits
// (individual_digits), ByteLevel(use_regex, add_prefix_space=false) ]; the Digits
// step is folded in by the \p{N} branch matching ONE digit at a time below (so each
// digit is its own pre-token, matching individual_digits=true). add_prefix_space is
// FALSE, so no leading space is inserted (the official recipe relies on the literal
// space already present after "<|user|>"). Uses the standard GPT2 contraction set.
const GPT2_PAT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?[0-9]| ?[^\s\p{L}0-9]+|\s+(?!\S)|\s+/gu;

// Build the BPE merge-rank map (pair "a b" -> rank) and the vocab once from a parsed
// tokenizer.json. merges is an array of either "a b" strings or ["a","b"] pairs.
export function buildBpe(tokenizerJson) {
    const model = tokenizerJson.model;
    const vocab = model.vocab;                          // token string -> id
    const ranks = new Map();
    let r = 0;
    for (const m of model.merges) {
        const pair = Array.isArray(m) ? (m[0] + " " + m[1]) : m;
        if (!ranks.has(pair)) ranks.set(pair, r++);
    }
    return { vocab, ranks, unkId: vocab[model.unk_token] };
}

// Greedy byte-level BPE on a SINGLE pre-token (already mapped through byteToUnicode →
// an array of single-char unicode "symbols"). Repeatedly merges the lowest-rank
// adjacent pair until none remain. Returns the final list of symbol-strings.
export function bpeMerge(symbols, ranks) {
    if (symbols.length < 2) return symbols;
    let word = symbols.slice();
    while (true) {
        let bestRank = Infinity, bestI = -1;
        for (let i = 0; i < word.length - 1; i++) {
            const rk = ranks.get(word[i] + " " + word[i + 1]);
            if (rk !== undefined && rk < bestRank) { bestRank = rk; bestI = i; }
        }
        if (bestI < 0) break;
        word = word.slice(0, bestI).concat(word[bestI] + word[bestI + 1], word.slice(bestI + 2));
    }
    return word;
}

// Tokenize text → array of token ids (no special tokens, no padding). Mirrors HF
// byte-level BPE: regex pre-tokenize → UTF-8 bytes → byte→unicode → BPE merge →
// vocab lookup. UTF-8 encoding is via TextEncoder so multi-byte chars map per-byte.
export function tokenizeBPE(text, bpe) {
    const { vocab, ranks, unkId } = bpe;
    const b2u = byteToUnicode();
    const enc = new TextEncoder();
    const ids = [];
    const pieces = String(text).match(GPT2_PAT) || [];
    for (const piece of pieces) {
        const bytes = enc.encode(piece);
        const symbols = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) symbols[i] = b2u[bytes[i]];
        const merged = bpeMerge(symbols, ranks);
        for (const tok of merged) {
            const id = vocab[tok];
            ids.push(id !== undefined ? id : unkId);
        }
    }
    return ids;
}

// Full preprocessing: partial transcript → { inputIds, attentionMask } (both length
// maxLength), exactly as the official `tokenizer(f"<|user|> {text}", padding=
// "max_length", max_length=256)`. Right-pads with padId; mask 1 for real, 0 for pad.
// If the prefixed text exceeds maxLength it is TRUNCATED to maxLength (HF default).
export function preprocess(text, bpe, T = TURNSENSE_TUNING) {
    let ids = tokenizeBPE(T.prefix + (text || ""), bpe);
    if (ids.length > T.maxLength) ids = ids.slice(0, T.maxLength);
    const inputIds = new Array(T.maxLength).fill(T.padId);
    const attentionMask = new Array(T.maxLength).fill(0);
    for (let i = 0; i < ids.length; i++) { inputIds[i] = ids[i]; attentionMask[i] = 1; }
    return { inputIds, attentionMask, realLen: ids.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY — lazily loads ORT + the int8 model + the tokenizer (all absolute URLs via
// document.baseURI) and returns an async textEouScore. THROWS on any load/init
// failure so the caller can fall back (TurnDetector treats a thrown/absent scorer as
// abstain). ORT import is lazy so `node --check` of this file needs no wasm.
// ─────────────────────────────────────────────────────────────────────────────
export async function createTurnSenseScorer(opts = {}) {
    const T = { ...TURNSENSE_TUNING, ...(opts.tuning || {}) };
    // Resolve vendored assets to absolute URLs against the page base (dynamic import()
    // rejects bare "vendor/…" specifiers; an absolute URL keeps the wasm/model load
    // working inside the itch game iframe too — same idiom as vad.js / smartturn.js).
    const baseRef = (typeof document !== "undefined" && document.baseURI) ? document.baseURI : undefined;
    const abs = (p) => (baseRef ? new URL(p, baseRef).href : p);
    const ortModuleUrl = abs(opts.ortModule ?? T.ortModule);
    const ortWasmDir = abs(opts.ortWasmDir ?? T.ortWasmDir);
    const modelUrl = abs(opts.modelUrl ?? T.modelPath);
    const tokUrl = abs(opts.tokenizerUrl ?? T.tokenizerPath);

    // Tokenizer: fetch + parse tokenizer.json, build the BPE tables once.
    let bpe;
    if (opts.bpe) {
        bpe = opts.bpe;
    } else {
        const res = await fetch(tokUrl);
        if (!res.ok) throw new Error(`turnsense: tokenizer fetch failed ${res.status}`);
        bpe = buildBpe(await res.json());
    }

    // ORT — reuse the Silero VAD's vendored runtime. Point it at the vendored wasm
    // (no CDN at play time) and disable the proxy worker (the lean non-jsep build's
    // wasm.proxy is broken — Kokoro memory note).
    const ORT = opts.ort || await import(/* @vite-ignore */ ortModuleUrl);
    if (ORT.env?.wasm) {
        ORT.env.wasm.wasmPaths = ortWasmDir;
        ORT.env.wasm.proxy = false;
    }
    const session = await ORT.InferenceSession.create(modelUrl);

    // The scorer: partial transcript → P(complete) ∈ [0,1]. Empty input ⇒ null
    // (abstain). Runs the session ONCE; output "probabilities"[1] is P(complete)
    // (softmax already inside the graph — NO extra softmax).
    const textEouScore = async (partialText) => {
        const t = (partialText || "").trim();
        if (!t) return null;                                   // nothing to judge → abstain
        const { inputIds, attentionMask } = preprocess(t, bpe, T);
        const idsT = new ORT.Tensor("int64", BigInt64Array.from(inputIds, BigInt), [1, T.maxLength]);
        const maskT = new ORT.Tensor("int64", BigInt64Array.from(attentionMask, BigInt), [1, T.maxLength]);
        const out = await session.run({ input_ids: idsT, attention_mask: maskT });
        const probs = out.probabilities ?? out[Object.keys(out)[0]];
        const v = probs?.data?.[1];                            // index 1 = P(complete)
        return typeof v === "number" ? v : null;
    };

    return textEouScore;
}
