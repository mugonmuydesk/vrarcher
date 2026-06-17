// Headless ACK-clip baker — talks DIRECTLY to the Gemini TTS API (no browser, no
// proxy, no Chrome). Reads the clip list from src/ack-lines.js (ACK_MANIFEST) and
// the dev key from src/geminikey.js (gitignored), synthesises each line in the
// companion voice, trims trailing silence, and writes assets/acks/akNN.wav.
//
// Voice + delivery (per the companion spec): prebuilt voice "Leda", a British
// accent at a natural pace with a warm vocal smile (the STYLE directive below).
// Same WAV format the runtime expects: mono 16-bit PCM at the model's rate (24 kHz).
//
// Run from the repo root:  node tools/bake-acks-direct.mjs
//   --only=ak00,ak29   bake just these files (re-bake a few)
//   --dry              list what would be baked, make no calls
// Re-run after editing RECEIPTS / the line banks, then regenerate manifest.json.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACK_MANIFEST } from "../src/ack-lines.js";
import { GEMINI_API_KEY } from "../src/geminikey.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "assets", "acks");

const MODEL = "gemini-2.5-flash-preview-tts";
const VOICE = "Leda";
const STYLE = "Read the following aloud in a British accent, at a natural pace, with a warm smile in your voice:";
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Tunables (match the browser bake): trim trailing near-silence, keep a short tail.
const SILENCE = 0.01;        // |sample| below this (of full scale) counts as silence
const TAIL_SEC = 0.05;       // keep this much audio past the last non-silent sample
const BASE_DELAY_MS = 1500;  // throttle between calls (TTS preview models are rate-limited)
const MAX_RETRY = 4;         // on 429 / 5xx, back off and retry

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a WAV (mono 16-bit PCM) from an Int16Array of samples.
function encodeWav(int16, rate) {
    const n = int16.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(int16[i], 44 + i * 2);
    return buf;
}

// One TTS call → { int16, rate }, with retry/backoff on transient failures.
async function synth(text) {
    const body = {
        contents: [{ parts: [{ text: `${STYLE}\n\n${text}` }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
    };
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        if (attempt > 0) await sleep(BASE_DELAY_MS * Math.pow(2, attempt)); // exp backoff
        let res;
        try {
            res = await fetch(URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (e) { lastErr = e; continue; }
        if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`HTTP ${res.status}`);
            continue; // transient → retry
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`); // hard fail
        const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
        if (!part?.data) throw new Error("no audio in response");
        const rate = parseInt((/rate=(\d+)/.exec(part.mimeType || "") || [])[1], 10) || 24000;
        const raw = Buffer.from(part.data, "base64");
        const int16 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
        return { int16, rate };
    }
    throw lastErr || new Error("synth failed");
}

function trimSilence(int16, rate) {
    const thresh = SILENCE * 0x8000;
    let end = int16.length;
    while (end > 1 && Math.abs(int16[end - 1]) < thresh) end--;
    end = Math.min(int16.length, end + Math.round(TAIL_SEC * rate));
    return int16.subarray(0, end);
}

async function main() {
    if (!GEMINI_API_KEY) { console.error("No GEMINI_API_KEY (src/geminikey.js)."); process.exit(1); }
    mkdirSync(OUT, { recursive: true });
    const items = ACK_MANIFEST.filter((e) => !only || only.has(e.file));
    console.log(`Baking ${items.length} clip(s) → ${OUT}  (voice=${VOICE}, model=${MODEL})`);
    if (dry) { items.forEach((e) => console.log(`  ${e.file}.wav  "${e.text}"`)); return; }

    const done = [], failed = [];
    for (let i = 0; i < items.length; i++) {
        const { text, file } = items[i];
        try {
            const { int16, rate } = await synth(text);
            const trimmed = trimSilence(int16, rate);
            writeFileSync(join(OUT, `${file}.wav`), encodeWav(trimmed, rate));
            const ms = Math.round((trimmed.length / rate) * 1000);
            done.push(file);
            console.log(`  [${i + 1}/${items.length}] ${file}.wav  ${ms}ms  "${text}"`);
        } catch (e) {
            failed.push({ file, text, err: String(e?.message || e).slice(0, 100) });
            console.log(`  [${i + 1}/${items.length}] ${file}.wav  FAILED: ${e?.message || e}`);
        }
        if (i < items.length - 1) await sleep(BASE_DELAY_MS);
    }
    console.log(`\nDone: ${done.length} baked, ${failed.length} failed.`);
    if (failed.length) { console.log("Failed:"); failed.forEach((f) => console.log(`  ${f.file}  "${f.text}"  — ${f.err}`)); process.exit(2); }
}

main();
