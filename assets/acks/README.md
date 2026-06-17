# Companion ACK voice clips (`akNN.wav`)

Prebaked clips the Tier-1 (no-TTS) companion plays so she's audible even when
replies are otherwise text-only. Two stages (see `src/acks.js`):

- **Stage A — receipt tokens** (`receipt:*`): content-free "heard you / thinking"
  sounds played the instant a turn ends, before the transcript + intent are
  processed.
- **Stage B — responses** (`ack:*` movement acks, `social:*` small-talk,
  `fallback:*` "say again"): the line the brain chose, played after it classifies.

`manifest.json` is the canonical list (`{ key, text, file }`, 57 clips), generated
from `src/ack-lines.js`. **Order is load-bearing** — `file` (`ak00`…) is the
index; append, never reorder/insert, or every later clip renumbers.

The `.wav` files are **not committed until baked**. Runtime is graceful-silent on
a missing clip (the reply still shows on the NPC HUD), so the build ships before
they exist.

## Baking (Wren's Gemini voice, so they seam with live TTS)

1. From the repo root: `python3 tools/bake-acks-receiver.py` (writes here, port 8078).
2. Serve the repo on :8000 (proxy origin allow-listed) and load `http://localhost:8000`.
3. In the page console:
   `import("/debug/bake-acks-gemini.js").then(m => m.bakeAcksGemini())`
   then watch `window.__bakeAcks`.

Re-bake whenever `GEMINI_TUNING.voice/ttsStyle`, `RECEIPTS`, or the line banks
(`command-bank.js` `ACK_LINES` / `SOCIAL_LINES` / `FALLBACK_LINES`) change, then
regenerate `manifest.json`:
`node --input-type=module -e 'import {ACK_MANIFEST} from "./src/ack-lines.js"; import {writeFileSync} from "node:fs"; writeFileSync("assets/acks/manifest.json", JSON.stringify(ACK_MANIFEST,null,2)+"\n")'`
