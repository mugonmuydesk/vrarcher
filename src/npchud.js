// DEBUG telemetry HUD — a billboarded text panel that floats above the companion
// NPC's head, showing its live FSM state plus a trace of the voice/decision
// pipeline (heard → intent → vad → turn → npc). It's a dev/tuning aid: ON by
// default so the in-headset session can watch the brain react in real time.
//
// This is a Babylon ADAPTER (UI only): it READS telemetry off the existing
// systems (ctx.voicechat / .vad / .turn / .npcs) and renders it — it holds NO
// game logic and never mutates anything. Every field is null-guarded because the
// systems load async (VAD's ONNX model, the NPC mesh import, the scripted brain's
// classifier), so the panel degrades to "—" until each one is present.
//
// Modelled 1:1 on voicechat.js's panel idiom: a BABYLON.DynamicTexture on a
// billboarded MeshBuilder.CreatePlane, StandardMaterial with diffuse+opacity =
// tex and disableLighting, drawn via the 2D canvas context, repositioned +
// re-rendered each frame from a ctx.updatables tick.
//
// PORT: the native Quest HUD is a worldspace UI canvas (Meta XR / uGUI) parented
// above the companion, reading the SAME brain fields (companionState, lastCommand,
// vad backend/prob, turn verdict, NpcBrain state/moving). No behaviour lives here.

// --- Tuning (the port's re-tuning checklist) -------------------------------
export const HUD_TUNING = {
    headOffsetY: 2.2,    // m — panel sits this far above the NPC mover (feet at y=0;
                         //     mannequin ~1.8 m, so this clears the head)
    panelWidth: 0.60,    // m
    panelHeight: 0.40,   // m
    texW: 512, texH: 360, // panel texture (matches the 0.60×0.40 aspect, 1.5:1-ish)
    speakProb: 0.5,      // VAD prob ≥ this ⇒ "● speaking" (else "· idle")
};

// FSM-state colours for the big header (scripted CompanionBrain states). Anything
// not listed (or "—") falls back to a neutral grey.
const STATE_COLORS = {
    FOLLOW: "#7fd0ff", WAIT: "#ffd27f", CLOSE: "#ff9a7a", SCOUT: "#9affb0",
    GUARD: "#c9a0ff", ENGAGE: "#ff7a7a", REST: "#9fb0bd",
};

export class NpcHud {
    constructor(ctx) {
        this.ctx = ctx;
        this._enabled = true;     // DEBUG panel: on by default for in-headset tuning
        this._buildPanel();
        ctx.updatables.push((dt) => this._tick(dt));
    }

    // Show/hide the panel (debug toggle). When off the plane is disabled outright.
    setEnabled(on) {
        this._enabled = !!on;
        if (!this._enabled && this._plane?.isEnabled()) this._plane.setEnabled(false);
    }
    toggle() { this.setEnabled(!this._enabled); }

    // --- per-frame: track the NPC head + re-render the telemetry --------------
    _tick() {
        const plane = this._plane;
        if (!this._enabled) { if (plane.isEnabled()) plane.setEnabled(false); return; }

        // Follow the first NPC's mover. Until the mesh import resolves (async) there
        // is no NPC — hide the panel rather than render a floating ghost.
        const npc = this.ctx.npcs?.npcs?.[0];
        const mover = npc?.mover;
        if (!mover) { if (plane.isEnabled()) plane.setEnabled(false); return; }

        if (!plane.isEnabled()) plane.setEnabled(true);
        plane.position.copyFrom(mover.position);
        plane.position.y = mover.position.y + HUD_TUNING.headOffsetY;
        // BILLBOARDMODE_ALL keeps it facing the camera — no manual orientation.

        this._render();
    }

    // --- read the telemetry off the live systems (all null-guarded) -----------
    _telemetry() {
        const ctx = this.ctx;
        const vc = ctx.voicechat;
        const brain = vc?.brain;              // dialogue brain (scripted FSM or Gemini)
        const vad = vc?.vad;
        const npc = ctx.npcs?.npcs?.[0];
        const nb = npc?.brain;                // NpcBrain (movement) — NOT the dialogue brain

        // STATE — only the scripted CompanionBrain exposes companionState; the Gemini
        // brain has none, so show "—".
        const state = brain?.companionState ?? "—";

        // heard — last transcript.
        const heard = vc?.lastText ?? "";

        // intent — last command classification from the scripted brain.
        //   lastCommand = { text, state, score, confident }; recognised via
        //   lastTurnRecognized. Confident → "STATE  score✓"; not → "—  score✗ (say again)".
        let intent = "—";
        const lc = brain?.lastCommand;
        if (lc) {
            const sc = typeof lc.score === "number" ? lc.score.toFixed(2) : "?";
            const ok = !!brain.lastTurnRecognized;
            intent = ok ? `${lc.state}  ${sc} ✓` : `—  ${sc} ✗ (say again)`;
        }

        // vad — backend + live speech indicator from prob.
        let vadLine = "—";
        if (vad) {
            const backend = vad.backend ?? "?";
            const p = typeof vad.prob === "number" ? vad.prob : null;
            const ind = p != null && p >= HUD_TUNING.speakProb ? "● speaking" : "· idle";
            const pv = p != null ? p.toFixed(2) : "—";
            vadLine = `${backend}  ${ind}  ${pv}`;
        }

        // turn — turn.js exposes NO persisted "last verdict" field (isTurnComplete
        // returns its verdict to the caller; nothing is stored). Degrade to the
        // voicechat pipeline state (idle/listening/thinking/speaking), which is the
        // best-effort end-of-turn signal actually available.
        const turn = vc?.state ?? "—";

        // npc — the MOVEMENT brain (NpcBrain): state (wander/attend) + moving. No
        // .command field today; surface it if a later phase adds one.
        let npcLine = "—";
        if (nb) {
            const mv = nb.moving ? "moving" : "still";
            npcLine = `${nb.state ?? "—"}  ${mv}`;
            if (nb.command != null) npcLine += `  cmd:${nb.command}`;
        }

        return { state, heard, intent, vad: vadLine, turn, npc: npcLine };
    }

    // --- panel (DynamicTexture plane, billboarded toward the player) ----------
    _buildPanel() {
        const scene = this.ctx.scene;
        const T = HUD_TUNING;
        const tex = new BABYLON.DynamicTexture("npcHudTex", { width: T.texW, height: T.texH }, scene, false);
        tex.hasAlpha = true;
        this._tex = tex;

        const mat = new BABYLON.StandardMaterial("npcHudMat", scene);
        mat.diffuseTexture = tex;
        mat.opacityTexture = tex;
        mat.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.9);
        mat.disableLighting = true;
        mat.backFaceCulling = false;

        const plane = BABYLON.MeshBuilder.CreatePlane("npcHud",
            { width: T.panelWidth, height: T.panelHeight }, scene);
        plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        plane.material = mat;
        plane.isPickable = false;
        plane.setEnabled(false);   // hidden until an NPC exists (see _tick)
        this._plane = plane;
        this._render();
    }

    // Truncate a string to n chars with an ellipsis (telemetry lines must not wrap).
    _clip(s, n) {
        s = String(s ?? "");
        return s.length > n ? s.slice(0, n - 1) + "…" : s;
    }

    _render() {
        const T = HUD_TUNING;
        const t = this._telemetry();
        const g = this._tex.getContext();
        g.clearRect(0, 0, T.texW, T.texH);

        // Rounded translucent backdrop.
        g.fillStyle = "rgba(8, 12, 16, 0.78)";
        roundRect(g, 6, 6, T.texW - 12, T.texH - 12, 18);
        g.fill();

        // STATE header — big, FSM-coloured.
        const stateStr = t.state || "—";
        g.fillStyle = STATE_COLORS[stateStr] || "#9fb0bd";
        g.font = "bold 52px sans-serif";
        g.fillText(this._clip(stateStr, 12), 24, 64);

        // Telemetry lines — monospace, label + value.
        const lines = [
            ["heard",  t.heard || "—"],
            ["intent", t.intent],
            ["vad",    t.vad],
            ["turn",   t.turn],
            ["npc",    t.npc],
        ];
        let y = 116;
        g.font = "22px monospace";
        for (const [label, value] of lines) {
            g.fillStyle = "#6f8a99";
            g.fillText(label, 24, y);
            g.fillStyle = "#e6ecec";
            g.fillText(this._clip(value, 34), 110, y);
            y += 40;
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
