// The companion's VOCABULARY and CHARACTER, as editable data. This is the file
// you tune to teach the on-device (no-LLM) companion brain new commands and to
// give "Wren" — the player's brave, warm, quick-witted, dry-humoured companion —
// more things to say. It feeds two systems:
//
//   COMMAND_BANK : per-state example utterances. The intent classifier embeds
//                  these and forms a centroid per state; a spoken command is
//                  routed to the nearest centroid (see src/intent.js). MORE and
//                  MORE-VARIED examples = better recognition. Misroutes cluster
//                  at semantically-adjacent state pairs (FOLLOW<->CLOSE<->WAIT,
//                  ENGAGE<->REST) — add disambiguating examples there if a real
//                  in-headset command lands in the wrong state.
//
//   ACK_LINES    : 2-3 acknowledgement lines per state, IN WREN'S VOICE. When a
//                  command is recognised the companion brain returns one of these
//                  (rotated, so it doesn't repeat). Tier 1 is text-only — these
//                  strings ARE what the companion "says". Keep them short, warm,
//                  a touch dry; brevity matters because they'll be spoken aloud.
//
// The example bank is copied verbatim from the validated harness
// (debug/intent-test/command-bank.json) so accuracy is preserved — see the
// regression test in that folder. Edit freely, but re-run that test if you
// change examples, to confirm accuracy holds.
//
// Engine-clean: plain data, no imports. PORT: ships as a JSON/ScriptableObject;
// the FSM + classifier consume it identically.

// Ordered list of companion states. FOLLOW is the default / home state.
export const STATES = ["FOLLOW", "WAIT", "CLOSE", "SCOUT", "GUARD", "ENGAGE", "REST"];

// One-line description of each state's intent (documentation + future tooltip).
export const STATE_INTENT = {
    FOLLOW: "Default. Travel with the player, keeping up.",
    WAIT:   "Hold this position until told otherwise.",
    CLOSE:  "Heel — stay tight by the player's side, no wandering.",
    SCOUT:  "Range ahead, explore, report what's there.",
    GUARD:  "Combat-ready, alert, covering the player.",
    ENGAGE: "Attack — go in and fight the enemy.",
    REST:   "Stand down, relax, the danger has passed.",
};

// Per-state example utterances. The classifier's centroids are built from these.
export const COMMAND_BANK = {
    FOLLOW: [
        "follow me",
        "come on, stay with me",
        "let's go, keep up",
        "we're moving out together",
        "stick close behind me as we go",
        "this way, walk with me",
        "come along now",
        "tag along, we've got ground to cover",
        // Short directional recalls — "over here" was a borderline reject; these
        // pull the centroid toward terse "come to me" phrasings without colliding
        // with WAIT's "wait here / stay here" (verified: wait here still → WAIT).
        "over here",
        "come here",
        "get over here",
        "back over to me",
    ],
    WAIT: [
        "wait here",
        "hold this position",
        "stay put for a moment",
        "don't move, I'll be right back",
        "stop and wait for me",
        "remain here until I return",
        "hang back, stay where you are",
        "give me a minute, just wait",
    ],
    CLOSE: [
        "stay close to me",
        "heel, right by my side",
        "keep tight, don't wander",
        "stick to me like glue",
        "no straying, stay near",
        "shoulder to shoulder, close in",
        "don't drift off, keep beside me",
        "hold near me, nice and close",
    ],
    SCOUT: [
        "go scout ahead",
        "range out in front and see what's there",
        "check the path up ahead for me",
        "run forward and look around",
        "take point and explore",
        "go on ahead and report back",
        "scout out what's beyond that ridge",
        "head out front and scan the area",
    ],
    GUARD: [
        "get ready to defend",
        "watch my back, something's coming",
        "stay alert and cover me",
        "brace yourself, be on guard",
        "keep your guard up, danger near",
        "be ready for trouble",
        "shields up, defensive stance",
        "stand ready to protect us",
    ],
    ENGAGE: [
        "attack",
        "take them down",
        "go get them",
        "open fire on the enemy",
        "charge in and fight",
        "strike now, hit them hard",
        "engage the target",
        "let them have it, go",
    ],
    REST: [
        "stand down, relax",
        "ease up, the danger's passed",
        "take a breather",
        "you can relax now",
        "at ease, no need to fight",
        "settle down and rest",
        "calm down, it's over",
        "lower your weapon, we're safe",
    ],
};

// Acknowledgement lines, in Wren's voice — brave, warm, quick-witted, dry. One
// is returned (rotated) when the matching command is recognised.
export const ACK_LINES = {
    FOLLOW: [
        "Right behind you.",
        "Lead on — I'm with you.",
        "After you, then.",
    ],
    WAIT: [
        "Holding here.",
        "I'll wait. Don't be long.",
        "Staying put — go on.",
    ],
    CLOSE: [
        "Glued to your side.",
        "Close as your shadow.",
        "Tucked in tight.",
    ],
    SCOUT: [
        "On point.",
        "Ranging ahead — back shortly.",
        "I'll have a look. Eyes open.",
    ],
    GUARD: [
        "Guard's up.",
        "Watching your back — let them try.",
        "Ready for trouble.",
    ],
    ENGAGE: [
        "On it — let's end this.",
        "Going in!",
        "With pleasure.",
    ],
    REST: [
        "At ease, then.",
        "Good. I'll catch my breath.",
        "Standing down — that was close.",
    ],
};

// --- ASK / query intents ---------------------------------------------------
// Voice queries the companion ANSWERS from live game state. Unlike COMMAND_BANK
// these do NOT switch companionState (no movement) — they're a spoken report.
// Classified by the SAME nearest-centroid pass as the movement states (see
// src/intent.js): each ask intent forms its own centroid from these examples,
// and a confident match routes to a TEMPLATE instead of an FSM transition.
//
// Add MORE / MORE-VARIED phrasings to sharpen recognition. If a real in-headset
// query lands in a movement state (or vice-versa), add disambiguating examples
// on the side that's being stolen from.
export const ASK_BANK = {
    ASK_SCORE: [
        "how am I doing?",
        "what's my score?",
        "how's my score looking?",
        "what's the score?",
        "how many points have I got?",
        "tell me my score",
        "how am I scoring?",
        "what am I on?",
    ],
    ASK_ARROWS: [
        "how many arrows do I have?",
        "how many arrows are left?",
        "how many arrows have I got?",
        "what's my arrow count?",
        "how many arrows left?",
        "how many shots have I got left?",
        "do I have many arrows?",
        "count my arrows",
    ],
};

// The ordered list of ask-intent keys (parity with STATES for the classifier).
export const ASK_INTENTS = Object.keys(ASK_BANK);

// Response TEMPLATES, in Wren's voice — functions of the live game state
// { score, hits, arrows }. Keyed by ask intent. Editable data alongside the
// command/ack banks; keep them short, warm, a touch dry (spoken aloud).
// PORT: these transcribe to string.Format calls reading the same game state.
export const ASK_TEMPLATES = {
    ASK_SCORE: (s) =>
        (s.hits > 0
            ? `You're on ${s.score} from ${s.hits} ${s.hits === 1 ? "shot" : "shots"}.`
            : `Nothing on the board yet — let's change that.`),
    ASK_ARROWS: (s) =>
        (s.arrows > 0
            ? `${s.arrows} ${s.arrows === 1 ? "arrow" : "arrows"} in hand.`
            : `Out of arrows — grab some more.`),
};

// Returned when an ask intent fires but no live game state is wired (degrade
// gracefully rather than throwing). One per ask intent, in Wren's voice.
export const ASK_FALLBACK = {
    ASK_SCORE: "Hard to say right now.",
    ASK_ARROWS: "Hard to say right now.",
};

// --- SOCIAL / conversational intents ---------------------------------------
// Small-talk the companion ANSWERS in character but that — like ASK intents —
// does NOT switch companionState (no movement). Classified by the SAME
// nearest-centroid pass as the movement states and ask intents (src/intent.js),
// as a THIRD centroid table; a confident match routes to a rotating SOCIAL_LINES
// reply instead of an FSM transition or a game-state report.
//
// These centroids share embedding space with the movement states and asks, so a
// few pairs sit close together — the seed phrases below are chosen to pull them
// apart, and intent.js returns a top1-top2 MARGIN the brain uses to reject the
// near-ties (see INTENT_TUNING.socialMargin). Known confusions handled here:
//   • SOCIAL_LOCATION ("where are we") vs SOCIAL_WHATNEXT ("where to now") —
//     both say "where"; location is seeded on PLACE, whatnext on PLAN/ACTION.
//   • SOCIAL_GREET vs SOCIAL_HOWAREYOU — the bundled "hey, how are you" form is
//     seeded under HOWAREYOU so it wins the bundle (its reply greets too).
//   • SOCIAL_THANKS vs SOCIAL_PRAISE — thanking-act vs a judgement of Wren.
//   • SOCIAL_PRAISE vs SOCIAL_CRITICISM — opposite polarity. WEAKNESS: the
//     static embedding is bag-of-words-ish, so it reads polarity from the WORDS
//     ("brilliant" vs "useless") and BREAKS on negation/sarcasm ("you're NOT
//     useless", "oh, GREAT job"). Seeded on unambiguous phrasings; accept the
//     misfire. Do not "fix" with negated seeds without re-validating.
//
// Add MORE / MORE-VARIED phrasings to widen recognition (the centroid is just
// their mean). Re-run debug/intent-test/intent-node-eval.mjs after editing.
export const SOCIAL_BANK = {
    SOCIAL_GREET: [
        "hello", "hi there", "hey Wren", "good to see you", "well met",
        "morning", "good evening", "hey", "greetings", "there you are",
    ],
    SOCIAL_BYE: [
        "goodbye", "see you later", "I'm off", "farewell", "bye",
        "I have to go", "take care", "until next time", "I'm heading out", "that's me done",
        // Terse farewells embed weakly and were drifting onto movement states
        // ("see you"→SCOUT, "catch you later"→WAIT); these pull the centroid
        // toward short goodbyes so they classify as BYE, not a command.
        "see you around", "catch you soon", "later", "good night",
    ],
    SOCIAL_THANKS: [
        "thank you", "thanks", "cheers", "appreciate it", "thanks for that",
        "much obliged", "thanks Wren", "nice one, thanks", "I appreciate the help", "ta",
    ],
    SOCIAL_PRAISE: [
        "you're brilliant", "good work", "well done", "you're amazing", "I like you",
        "you're the best", "you're a great help", "you're wonderful", "glad you're here", "couldn't do this without you",
    ],
    SOCIAL_CRITICISM: [
        "you're useless", "you're rubbish", "that was terrible", "you're no help", "you're annoying",
        "you're hopeless", "stop messing about", "you're doing it wrong", "I don't like you", "you're letting me down",
    ],
    SOCIAL_HOWAREYOU: [
        "how are you", "how are you doing", "you alright", "how do you feel", "everything ok with you",
        "how's it going", "you holding up", "are you well", "how have you been", "hey, how are you",
    ],
    SOCIAL_LOCATION: [
        "where are we", "what is this place", "where am I", "what's this area", "do you know this place",
        "where are we now", "what place is this", "tell me about this place", "what is this area", "have you been here before",
    ],
    SOCIAL_WHATNEXT: [
        "what do we do now", "what's next", "where to now", "what should I do", "what now",
        "any ideas", "what's the plan", "where do we go from here", "what should we do next", "got a plan",
    ],
};

// Ordered list of social-intent keys (parity with STATES / ASK_INTENTS).
export const SOCIAL_INTENTS = Object.keys(SOCIAL_BANK);

// Response lines per social intent, in Wren's voice — rotated like ACK_LINES so
// they don't repeat. Tier 1 has no TTS, so these strings are what the companion
// "says" (shown on the NPC HUD; an optional prebaked-clip bank in acks.js can
// voice them). location/whatnext are PLACE-FIXED (the archery range) — a fully
// scripted answer that needs no game state. Keep short, warm, a touch dry.
export const SOCIAL_LINES = {
    SOCIAL_GREET: ["Hello there.", "Ah — there you are.", "Good to see you up and about."],
    SOCIAL_BYE: ["Take care, then.", "Until next time.", "Mind how you go."],
    SOCIAL_THANKS: ["Anytime.", "Think nothing of it.", "That's what I'm here for."],
    SOCIAL_PRAISE: ["Kind of you to say.", "Ha — you're not so bad yourself.", "I'll take that."],
    SOCIAL_CRITICISM: ["Noted. I'll do better.", "Steady on — I'm doing my best.", "Fair enough. Point taken."],
    SOCIAL_HOWAREYOU: ["Right as rain, thanks.", "Can't complain. You?", "Sharp and ready."],
    SOCIAL_LOCATION: ["The old archery range — good place to find your aim.", "Home ground. Targets are downrange.", "Just the range. Quiet, for now."],
    SOCIAL_WHATNEXT: ["Keep at the targets — tighten those groupings.", "Pick your mark and draw. I'll watch.", "Plenty of shooting left. When you're ready."],
};

// Banter / "say again" fallbacks — returned when an utterance is NOT a confident
// command (chatter, a question, an unclear order). The FSM stays put. Kept light
// and in-character so a misheard order or a bit of chat still feels like Wren.
export const FALLBACK_LINES = [
    "Didn't catch that — say again?",
    "Hm? Run that by me once more.",
    "Not sure what you mean — what's the order?",
    "Come again? The wind ate that one.",
];
