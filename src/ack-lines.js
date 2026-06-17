// Prebaked companion-VOICE clip lists + manifest (ENGINE-CLEAN data — no Babylon,
// no audio). The adapter that fetches/plays the clips is acks.js; the bake tool
// (debug/bake-acks-gemini.js) and the node manifest dump import THIS file. Same
// engine-clean/adapter split as fillers.js (data) vs barks.js (adapter).
//
// Two stages of clip (see acks.js for the why):
//   • RECEIPTS — Stage A. Content-free "heard you / thinking" tokens played the
//     moment the turn ends, before STT-final + intent. Commit to nothing.
//   • Stage B response clips — the line the brain chose: a movement-ack
//     (ACK_LINES), a small-talk line (SOCIAL_LINES), or a "say again"
//     (FALLBACK_LINES). Their TEXT lives in command-bank.js, so editing a line
//     keeps text + clip in lock-step.
//
// PORT: the lists + manifest transcribe directly; the native build bakes the same
// clips in its companion voice.

import { ACK_LINES, SOCIAL_LINES, FALLBACK_LINES, STATES, SOCIAL_INTENTS } from "./command-bank.js";

// STAGE A — receipt tokens. The last ("Hm?") rises, so it still reads as "sorry?"
// if the transcript came back empty — the safe pick when capture is least certain.
// ORDER IS LOAD-BEARING once baked (index → clip file); never reorder without
// re-baking.
export const RECEIPTS = [
    "Hm.", "Mm.", "Hmm…", "Let me see.", "One moment.", "Hang on…", "Just a tick.", "Hm?",
];

// One flat, ordered list of every baked clip: { key, text, file }. The bake tool
// reads `text` → synthesises → writes assets/acks/`file`.wav; the runtime resolves
// a logical (stage/category/index) to `file` via the key. ORDER IS LOAD-BEARING
// once baked — append, don't reorder/insert (it renumbers every later file).
function buildManifest() {
    const out = [];
    const push = (key, text) => out.push({ key, text, file: "ak" + String(out.length).padStart(2, "0") });
    RECEIPTS.forEach((t, i) => push(`receipt:${i}`, t));                                   // Stage A
    for (const st of STATES) (ACK_LINES[st] || []).forEach((t, i) => push(`ack:${st}:${i}`, t));        // Stage B — movement acks
    for (const k of SOCIAL_INTENTS) (SOCIAL_LINES[k] || []).forEach((t, i) => push(`social:${k}:${i}`, t)); // Stage B — small-talk
    FALLBACK_LINES.forEach((t, i) => push(`fallback:${i}`, t));                            // Stage B — "say again"
    return out;
}

export const ACK_MANIFEST = buildManifest();
// key → manifest entry, for O(1) runtime resolution.
export const ACK_BY_KEY = new Map(ACK_MANIFEST.map((e) => [e.key, e]));
