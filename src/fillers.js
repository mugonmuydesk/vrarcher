// Filled-pause bank + combat barks — the snappy-conversation trick. Cloud TTS
// (Gemini) has a round-trip before the first sound, so the companion *starts*
// every turn with a short pre-recorded verbal filler ("Hmm,", "Right, so,",
// "Huh... I see what you mean,") played from a baked bank the instant the reply
// text arrives, while the real TTS renders the rest of the sentence. The filler
// need not cover the whole gap — it buys a near-zero latency to first sound, so
// the turn feels responsive even over the network.
//
// Pipeline: the Gemini prompt (gemini.js) makes the model begin each reply with
// exactly one filler from FILLERS (verbatim, chosen for emotional fit);
// splitFiller() peels it off; the adapter (voicechat.js) plays bank clip
// f<NN>.wav immediately and sends only the remainder to TTS. The bank is baked
// in the SAME Gemini voice as live synthesis, so the seam is seamless.
//
// BARKS are a SEPARATE system: short reactive combat/event callouts ("Behind
// you!", "Nice shot!") fired by game events, NOT LLM replies — also prebaked
// (b<NN>.wav) and played directly. They never go through splitFiller.
//
// ENGINE-CLEAN: just lists + a pure string split. No Babylon, no audio — the
// bank loading/playback lives in the adapter. PORT: the lists + split transcribe
// directly; the native port bakes the same clips in its companion voice.

// Conversational fillers, in fixed order — index N maps to baked clip
// assets/fillers/f<NN>.wav. Order is LOAD-BEARING: never reorder without
// re-baking. Grouped by emotional register (the model picks the one whose
// FEELING fits the moment, giving the companion range across errand-quests and
// storm-the-castle battles).
export const FILLERS = [
    "Hmm,", "Huh... I see what you mean,",              // thinking / weighing a decision
    "Aye,", "Good call,",                               // agreement / acknowledgement
    "Oh!", "Oh, now that's interesting,",               // surprise / realization
    "Now we're talking,", "Here we go,",                // excitement / eagerness
    "Right, let's do this,", "Stay sharp,",             // determination / pre-fight rally
    "Careful—", "Wait, something's off,",               // caution / something's wrong
    "Ha!", "Well, well, well,",                         // amusement / wit / banter
    "Hey,", "Easy— I've got you,",                      // reassurance / warmth
    "Really?", "You sure about that?",                  // doubt / skepticism
    "Ugh,", "Oh, come on,",                             // frustration / dismay
    "Phew,", "Well— that's a relief,",                  // relief
    "Ooh, what's this,", "Hello— what have we here,",   // curiosity / discovery
    "Yes?", "What is it,",                              // greeting / re-engagement
    "Got it,", "On it,",                                // command acknowledgement
    "Ha, nice shot,", "Nicely done,",                   // praise / pride in the player
    "Oh, no,", "I'm sorry,",                            // sympathy / sorrow
    "Whoa,", "By the gods...,",                         // wonder / awe
    "Oh, this is bad,", "I've got a bad feeling about this,", // fear / dread
    "Ugh, what is that,", "Gods, the smell,",           // disgust / revulsion
    "This doesn't sit right with me,", "I'm not sure we should,", // hesitation / moral conflict
    "Come on, nearly there,", "Hold the line,",         // encouragement / morale (mid-fight)
    "Ha! We did it,", "That's the last of them,",       // triumph / aftermath
];

// Reactive combat/event barks — index N maps to assets/fillers/b<NN>.wav.
// Fired by game events (feedback/combat systems), NOT the dialogue brain.
export const BARKS = [
    "Behind you!", "Incoming!", "Look out!", "Nice shot!", "On your left!", "Cover me!",
    "They're flanking us!", "Get down!", "Push forward!", "I'm hit!", "Right in the teeth!", "Last one— finish it!",
];

// Lowercase, collapse internal whitespace, trim. (Comparison form.)
function norm(s) { return s.toLowerCase().replace(/\s+/g, " ").trim(); }
// Drop trailing punctuation too (tolerant form — the model may alter the comma/…).
function loose(s) { return norm(s).replace(/[.,…!?;:\s]+$/, ""); }

// Peel a leading filler off a reply. Returns { index, filler, remainder } where
// `filler` is the exact leading text consumed (incl. its punctuation) and
// `remainder` is the rest to synthesise — or null if the reply doesn't start
// with a recognised filler, or IS just a filler with nothing after it (let that
// TTS whole). Two passes: exact case-insensitive prefix first (so "Hmm," and
// "Hmm, let me see," don't collide), then a punctuation-tolerant prefix.
// Longest match wins.
export function splitFiller(reply) {
    const r = (reply || "").replace(/^\s+/, "");
    if (!r) return null;
    const rl = r.toLowerCase();

    const build = (index, matchLen) => {
        let end = matchLen;
        const tail = r.slice(end).match(/^[.,…!?;:\s]+/);
        if (tail) end += tail[0].length;
        const remainder = r.slice(end).trim();
        if (!remainder) return null;
        return { index, filler: r.slice(0, end).trim(), remainder };
    };
    const bounded = (len) => { const ch = r[len]; return ch === undefined || /[\s.,…!?;:]/.test(ch); };

    // Pass 1: exact (case-insensitive) prefix, punctuation and all — longest first.
    const byLen = FILLERS.map((f, i) => ({ i, f })).sort((a, b) => b.f.length - a.f.length);
    for (const c of byLen) {
        if (rl.startsWith(c.f.toLowerCase())) { const m = build(c.i, c.f.length); if (m) return m; }
    }
    // Pass 2: tolerant — punctuation-stripped filler vs reply prefix, at a word boundary.
    const byLoose = FILLERS.map((f, i) => ({ i, l: loose(f) }))
        .filter((c) => c.l.length > 0)
        .sort((a, b) => b.l.length - a.l.length);
    for (const c of byLoose) {
        if (rl.startsWith(c.l) && bounded(c.l.length)) { const m = build(c.i, c.l.length); if (m) return m; }
    }
    return null;
}

// Zero-padded clip basenames: filler index → "f00"…, bark index → "b00"…
export function fillerClip(i) { return "f" + String(i).padStart(2, "0"); }
export function barkClip(i) { return "b" + String(i).padStart(2, "0"); }
