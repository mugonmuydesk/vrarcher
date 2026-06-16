// VoicePanel — a small standing signboard with two fingertip buttons that
// switch the NPC voice (Wren) TTS backend live between cloud Gemini and
// on-device Kokoro-82M. Press "Kokoro" or "Gemini" with a fingertip; the active
// one is highlighted and the board shows the current load state.
//
// Engine-clean boundary: this is pure Babylon UI. It calls ctx.setVoiceBackend()
// and reads ctx.voiceBackend / ctx.voiceStatus (owned by main.js) — no TTS or
// game logic here. PORT: in Unity this is a world-space canvas with two buttons
// bound to the same backend-select call; the board text mirrors the same state.

import { FingertipButton } from "./buttons.js";

const PANEL = {
    width: 0.80, height: 0.34,    // m — signboard face (wide enough for 3 buttons)
    px: 1000,                     // DynamicTexture px per metre
    btnRadius: 0.022,             // fingertip button cap radius
    btnY: -0.075,                 // local y of the buttons (below the labels)
    btnSpacing: 0.24,             // local x pitch between buttons
    btnZ: -0.04,                  // local z (toward the player, board front = -z)
};

// Backends shown, left → right. `name` is what we pass to setVoiceBackend.
//   wasm   — on-device Kokoro, CPU worker, offline (default; smooth)
//   q32    — on-device Kokoro, fp32 on WebGPU (fast, GPU; online/experimental)
//   gemini — cloud
const BACKENDS = [
    { name: "wasm", title: "WASM", sub: "CPU" },
    { name: "q32", title: "q32", sub: "GPU" },
    { name: "gemini", title: "Gemini", sub: "cloud" },
];

// Local x of button i, centred across the row.
const xFor = (i) => (i - (BACKENDS.length - 1) / 2) * PANEL.btnSpacing;

export class VoicePanel {
    constructor(ctx, { position }) {
        this.ctx = ctx;
        const scene = ctx.scene;
        const W = PANEL.width, H = PANEL.height;

        // Yaw the board so its front (−Z) face points back at the start point
        // (same recipe as ControlBoard / the in-VR HUD).
        const toPlayer = new BABYLON.Vector3(0, 1.6, 0).subtract(position);
        const yaw = Math.atan2(-toPlayer.x, -toPlayer.z);
        this.root = new BABYLON.TransformNode("voicePanel", scene);
        this.root.position.copyFrom(position);
        this.root.rotationQuaternion = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), yaw);

        // --- face: self-lit DynamicTexture plane (front = −Z = player) -------
        const TW = Math.round(W * PANEL.px), TH = Math.round(H * PANEL.px);
        this._tex = new BABYLON.DynamicTexture("voicePanelTex", { width: TW, height: TH }, scene, false);
        this._tex.hasAlpha = true;
        this._tw = TW; this._th = TH; this._W = W; this._H = H;

        const faceMat = new BABYLON.StandardMaterial("voicePanelFaceMat", scene);
        faceMat.emissiveTexture = this._tex;
        faceMat.opacityTexture = this._tex;
        faceMat.diffuseColor = BABYLON.Color3.Black();
        faceMat.specularColor = BABYLON.Color3.Black();
        faceMat.disableLighting = true;
        faceMat.backFaceCulling = false;
        const face = BABYLON.MeshBuilder.CreatePlane("voicePanelFace", { width: W, height: H }, scene);
        face.material = faceMat;
        face.parent = this.root;
        face.isPickable = false;

        // --- backing slab + support post to the floor -----------------------
        const woodMat = new BABYLON.StandardMaterial("voicePanelWoodMat", scene);
        woodMat.diffuseColor = new BABYLON.Color3(0.18, 0.16, 0.14);
        const back = BABYLON.MeshBuilder.CreateBox("voicePanelBack",
            { width: W + 0.04, height: H + 0.04, depth: 0.025 }, scene);
        back.position.z = 0.02;
        back.material = woodMat; back.parent = this.root;
        const legLen = position.y - H / 2;
        if (legLen > 0.05) {
            const post = BABYLON.MeshBuilder.CreateBox("voicePanelPost",
                { width: 0.05, height: legLen, depth: 0.05 }, scene);
            post.position.set(0, -(H / 2 + legLen / 2), 0.02);
            post.material = woodMat; post.parent = this.root;
            const base = BABYLON.MeshBuilder.CreateBox("voicePanelBase",
                { width: 0.26, height: 0.03, depth: 0.26 }, scene);
            base.position.set(0, -(H / 2 + legLen), 0.02);
            base.material = woodMat; base.parent = this.root;
        }

        // --- two fingertip buttons on the player-facing face ----------------
        this.root.computeWorldMatrix(true);
        const wm = this.root.getWorldMatrix();
        const toWorld = (lx, ly, lz) =>
            BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(lx, ly, lz), wm);
        // Press axis (+Y) → board-local −Z (toward player), then carried into the
        // board's yawed frame: world = rootRot ⊗ tilt.
        const tilt = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Right(), -Math.PI / 2);
        const btnRot = this.root.rotationQuaternion.multiply(tilt);

        this.buttons = {};
        BACKENDS.forEach((b, i) => {
            const lx = xFor(i);
            this.buttons[b.name] = new FingertipButton(ctx, {
                name: `voiceBtn-${b.name}`,
                position: toWorld(lx, PANEL.btnY, PANEL.btnZ),
                rotation: btnRot,
                radius: PANEL.btnRadius,
                onDown: () => {
                    if (ctx.voiceBackend !== b.name) ctx.setVoiceBackend?.(b.name);
                    ctx.feedback?.sound?.("click", { pitch: 1.0, volume: 0.5 });
                },
            });
        });

        this._lastKey = "";
        this._draw();
        ctx.updatables.push(() => this._tick());
    }

    // Repaint only when the rendered state changes; keep the active button lit.
    _tick() {
        const key = `${this.ctx.voiceBackend}|${this.ctx.voiceStatus}`;
        if (key !== this._lastKey) { this._lastKey = key; this._draw(); }
        for (const b of BACKENDS) {
            const active = this.ctx.voiceBackend === b.name;
            const cap = this.buttons[b.name]?._capMat;
            if (cap) cap.diffuseColor = active
                ? new BABYLON.Color3(0.95, 0.78, 0.28)   // amber = active
                : new BABYLON.Color3(0.2, 0.45, 0.55);   // teal = inactive
        }
    }

    _draw() {
        const g = this._tex.getContext();
        const TW = this._tw, TH = this._th;
        const vPix = (ly) => (this._H / 2 - ly) / this._H * TH;   // local y(m) → px
        const xPix = (lx) => (lx + this._W / 2) / this._W * TW;   // local x(m) → px
        g.clearRect(0, 0, TW, TH);
        g.fillStyle = "rgba(10,16,12,0.85)";
        g.fillRect(0, 0, TW, TH);

        g.textBaseline = "middle";
        g.textAlign = "center";
        g.fillStyle = "#cfe9a0";
        g.font = "bold 40px monospace";
        g.fillText("NPC VOICE", TW / 2, vPix(this._H / 2 - 0.045));

        // Per-backend label, aligned above its button; active one boxed/amber.
        g.font = "bold 38px sans-serif";
        BACKENDS.forEach((b, i) => {
            const lx = xFor(i);
            const cx = xPix(lx);
            const active = this.ctx.voiceBackend === b.name;
            const yT = vPix(0.045), yS = vPix(0.005);
            if (active) {
                g.fillStyle = "rgba(150,110,30,0.35)";
                g.fillRect(cx - 105, vPix(0.075), 210, 130);
            }
            g.fillStyle = active ? "#ffd24a" : "#cdd6cf";
            g.fillText(b.title, cx, yT);
            g.font = "22px monospace";
            g.fillStyle = active ? "#e6c46a" : "#8aa092";
            g.fillText(b.sub, cx, yS);
            g.font = "bold 38px sans-serif";
        });

        // Status line at the bottom.
        g.font = "24px monospace";
        g.fillStyle = "#7fd0ff";
        g.fillText(this.ctx.voiceStatus || "", TW / 2, vPix(-this._H / 2 + 0.03));
        this._tex.update();
    }
}
