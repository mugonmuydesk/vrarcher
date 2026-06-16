// ControlBoard — a standing signboard carrying a column of physical sliders
// that tune live parameters (used for the two particle-tuning boards to the
// player's left). Each row is a LinearDrive (drives.js) whose 0..1 travel is
// remapped onto a parameter's [min..max] range and written through apply();
// the board's DynamicTexture face shows the title plus each row's label and
// current value, redrawn whenever a slider moves.
//
// Engine-clean: this is a debug/authoring surface, so it lives entirely in
// the Babylon adapter layer. The values it edits live in the arrow module's
// TUNING blocks — a native port re-tunes those blocks directly and need not
// reproduce this board.

import { LinearDrive } from "./drives.js";

const ROW_H = 0.115;       // m — vertical pitch between slider rows
const RAIL_INSET = 0.09;   // m — rail margin from the board's side edges
const RAIL_Z = -0.055;     // m — rail floats this far toward the player
const TEXT_LIFT = 0.02;    // m — label/value baseline sits above its rail
const PX_PER_M = 1000;     // DynamicTexture resolution

export class ControlBoard {
    /**
     * opts:
     *   name      unique base name
     *   position  Vector3 — board centre (world)
     *   title     header string
     *   width     board width in metres (default 0.72)
     *   params    [{ label, unit, min, max, value, fmt?, apply(v) }]
     *             value = current/default (sets the slider start position);
     *             apply(v) writes the remapped value into its TUNING block.
     */
    constructor(ctx, { name, position, title, params, width = 0.72 }) {
        this.ctx = ctx;
        this.params = params;
        const scene = ctx.scene;
        const n = params.length;
        const height = 0.16 + n * ROW_H;   // title band + one band per row

        // Yaw so the textured face points back at the start point (same
        // recipe as the in-VR HUD, which reads non-mirrored from there).
        const toPlayer = new BABYLON.Vector3(0, 1.6, 0).subtract(position);
        const yaw = Math.atan2(-toPlayer.x, -toPlayer.z);
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);
        this.root.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
            BABYLON.Vector3.Up(), yaw);

        // --- face: DynamicTexture on a self-lit plane (front = -Z = player) -
        const TW = Math.round(width * PX_PER_M);
        const TH = Math.round(height * PX_PER_M);
        this._tex = new BABYLON.DynamicTexture(`${name}-tex`,
            { width: TW, height: TH }, scene, false);
        this._tex.hasAlpha = true;
        this._tw = TW; this._th = TH;
        this._height = height; this._width = width;
        this._title = title;

        const faceMat = new BABYLON.StandardMaterial(`${name}-faceMat`, scene);
        faceMat.emissiveTexture = this._tex;
        faceMat.opacityTexture = this._tex;
        faceMat.diffuseColor = BABYLON.Color3.Black();
        faceMat.specularColor = BABYLON.Color3.Black();
        faceMat.disableLighting = true;
        faceMat.backFaceCulling = false;
        const face = BABYLON.MeshBuilder.CreatePlane(`${name}-face`,
            { width, height }, scene);
        face.material = faceMat;
        face.parent = this.root;

        // --- backing slab + support post to the floor ----------------------
        const woodMat = new BABYLON.StandardMaterial(`${name}-woodMat`, scene);
        woodMat.diffuseColor = new BABYLON.Color3(0.18, 0.16, 0.14);
        const back = BABYLON.MeshBuilder.CreateBox(`${name}-back`,
            { width: width + 0.05, height: height + 0.05, depth: 0.025 }, scene);
        back.position.z = 0.02;            // behind the face (away from player)
        back.material = woodMat;
        back.parent = this.root;

        const legLen = position.y - height / 2;  // board bottom down to floor
        if (legLen > 0.05) {
            const post = BABYLON.MeshBuilder.CreateBox(`${name}-post`,
                { width: 0.05, height: legLen, depth: 0.05 }, scene);
            post.position.set(0, -(height / 2 + legLen / 2), 0.02);
            post.material = woodMat;
            post.parent = this.root;
            const base = BABYLON.MeshBuilder.CreateBox(`${name}-base`,
                { width: 0.3, height: 0.03, depth: 0.3 }, scene);
            base.position.set(0, -(height / 2 + legLen), 0.02);
            base.material = woodMat;
            base.parent = this.root;
        }

        // --- one physical slider per parameter -----------------------------
        this.root.computeWorldMatrix(true);
        const wm = this.root.getWorldMatrix();
        const toWorld = (lx, ly, lz) =>
            BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(lx, ly, lz), wm);

        // Initialise every row's display state first: the first slider's
        // construction fires onValue -> _draw(), which reads _cur/_rowY for
        // ALL rows, so they must exist before any drive is built.
        params.forEach((p, i) => {
            p._cur = p.value;
            p._rowY = height / 2 - 0.13 - i * ROW_H;   // local y of this row
        });

        this.drives = [];
        params.forEach((p, i) => {
            const railY = p._rowY - 0.025;
            const span = p.max - p.min;
            const startValue = span > 0 ? (p.value - p.min) / span : 0;
            const drive = new LinearDrive(ctx, {
                name: `${name}-s${i}`,
                start: toWorld(-width / 2 + RAIL_INSET, railY, RAIL_Z),
                end: toWorld(width / 2 - RAIL_INSET, railY, RAIL_Z),
                startValue,
                onValue: (t) => {
                    p._cur = p.min + t * span;
                    p.apply(p._cur);
                    this._draw();
                },
            });
            this.drives.push(drive);
        });

        this._draw();
    }

    // Repaint the face: title, then "LABEL ............ value unit" per row,
    // each aligned to its slider's row so the readout sits above the knob.
    _draw() {
        const g = this._tex.getContext();
        const TW = this._tw, TH = this._th;
        g.clearRect(0, 0, TW, TH);
        g.fillStyle = "rgba(10,16,12,0.82)";
        g.fillRect(0, 0, TW, TH);

        // local y (m, +up from centre) -> texture v (px, +down from top)
        const vPix = (ly) => (this._height / 2 - ly) / this._height * TH;

        g.textBaseline = "middle";
        g.fillStyle = "#cfe9a0";
        g.font = "bold 34px monospace";
        g.textAlign = "center";
        g.fillText(this._title, TW / 2, vPix(this._height / 2 - 0.06));

        g.font = "28px monospace";
        for (const p of this.params) {
            const y = vPix(p._rowY + TEXT_LIFT);
            const fmt = p.fmt ?? ((v) => v.toFixed(2));
            g.fillStyle = "#9fe07a";
            g.textAlign = "left";
            g.fillText(p.label, 16, y);
            g.fillStyle = "#ffffff";
            g.textAlign = "right";
            g.fillText(`${fmt(p._cur)} ${p.unit}`.trim(), TW - 16, y);
        }
        this._tex.update();
    }
}
