// Bow item (hand-modeled from primitives — NOT from reference/ assets).
//
// Hierarchy:  root (snapped under the bow hand's grip; x-scale -1 mirror
//             for right-handed grip)
//             └─ aimPivot (aim-while-nocked rotation, 0.15 s lerp in/out)
//                ├─ handle, upper/lower limb segment chains
//                ├─ tipTop / tipBottom (string anchors, follow limb flex)
//                ├─ nockRest (string rest position)
//                ├─ nock (slides local -Z with draw; Phase 5)
//                └─ string segments (two cylinders tip->nock, stretched
//                   and re-aimed every frame)
//
// Bow local frame: +Y up the stave, +Z = arrow flight direction, string
// on the -Z side.
//
// Flex: limb segments get a per-segment bend angle scaled by tension —
// the procedural equivalent of scrubbing a baked flex clip 0..1.
//
// Two-handed package: grabbing the bow auto-attaches a draw-hand
// controller (nock origin node) to the other hand.

const LIMB_SEGMENTS = 3;
const SEG_LEN = 0.16;
const BASE_BEND = 0.20;        // rad per segment at rest (bow curve)
const FLEX_BEND = 0.18;        // extra rad per segment at full tension
const HANDLE_LEN = 0.28;
const AIM_BLEND_TIME = 0.15;   // s — nocked-aim blend in/out
// Nocked aim (user-specified 2026-06-13): YAW (world Y) is always the bow
// wrist's, nocked or not. Un-nocked the whole rotation follows the grip.
// While nocked, the remaining axes conform to the draw hand: the bow
// PITCHES so +Z matches the elevation of the nockOrigin→pivot line, and
// the stave stays upright (zero roll). Lateral draw-hand offset is NOT
// compensated — that would need yaw, which the wrist owns. Replaces the
// reference's eye-line aim assist (HMD→nock pivot + draw offset).
// Local pose of the bow root under the grip node (tuned in-emulator).
// Grip-space axes (Babylon, from the IWE hand tables): fingers extend
// along -Y, thumb +Z, palm normal ±X. In the natural fist-vertical bow
// hold the thumb is up and the extended-finger direction faces the
// target, so: bow +Y (stave) -> grip +Z (top toward the thumb), bow +Z
// (flight) -> grip -Y (out along the fingers, NOT the palm normal —
// the palm faces the body midline). That's a 90° rotation about X
// (X->X, Y->Z, Z->-Y), which commutes with the right-hand X-mirror, so
// one quaternion serves both hands. Identity here leaves the arrow
// flying along the thumb — straight up in a natural hold.
const SNAP_POS = new BABYLON.Vector3(0, 0, 0);
const SNAP_ROT = new BABYLON.Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2);

export class Bow {
    constructor(ctx, interactionOpts = {}) {
        this.ctx = ctx;
        const scene = ctx.scene;

        this.root = new BABYLON.TransformNode("bow", scene);
        this.root.rotationQuaternion = new BABYLON.Quaternion();
        this.aimPivot = new BABYLON.TransformNode("bow-aimPivot", scene);
        this.aimPivot.parent = this.root;
        this.aimPivot.rotationQuaternion = new BABYLON.Quaternion();

        this._buildGeometry(scene);

        this.bowHand = null;     // hand holding the bow
        this.drawHand = null;    // opposite hand (owns arrow / nock origin)
        this.nockOrigin = null;  // node on the draw hand we measure against
        this.tension = 0;
        this.aimActive = false;  // Phase 5 gates this on "nocked"
        this._aimWeight = 0;

        this.onGrabbed = null;   // (bowHand, drawHand) => {}
        this.onReleased = null;

        this.setTension(0);
    }

    _buildGeometry(scene) {
        const mat = new BABYLON.StandardMaterial("bowMat", scene);
        mat.diffuseColor = new BABYLON.Color3(0.45, 0.28, 0.15);
        const stringMat = new BABYLON.StandardMaterial("bowStringMat", scene);
        stringMat.diffuseColor = new BABYLON.Color3(0.9, 0.9, 0.85);

        this.handle = BABYLON.MeshBuilder.CreateCylinder("bow-handle",
            { height: HANDLE_LEN, diameter: 0.045, tessellation: 10 }, scene);
        this.handle.parent = this.aimPivot;
        this.handle.material = mat;

        // Limb chains: nested nodes so bend angles accumulate.
        const buildLimb = (sign) => {
            const segs = [];
            let parent = this.aimPivot;
            let y = sign * HANDLE_LEN / 2;
            for (let i = 0; i < LIMB_SEGMENTS; i++) {
                const joint = new BABYLON.TransformNode(`bow-limb${sign > 0 ? "U" : "L"}${i}`, scene);
                joint.parent = parent;
                joint.position = i === 0 ? new BABYLON.Vector3(0, y, 0)
                    : new BABYLON.Vector3(0, sign * SEG_LEN, 0);
                const seg = BABYLON.MeshBuilder.CreateBox(`bow-seg${sign}${i}`,
                    { width: 0.03 - i * 0.006, height: SEG_LEN, depth: 0.018 }, scene);
                seg.parent = joint;
                seg.position.y = sign * SEG_LEN / 2;
                seg.material = mat;
                segs.push(joint);
                parent = joint;
            }
            const tip = new BABYLON.TransformNode(`bow-tip${sign > 0 ? "Top" : "Bottom"}`, scene);
            tip.parent = parent;
            tip.position = new BABYLON.Vector3(0, sign * SEG_LEN, -0.01);
            return { segs, tip };
        };
        const upper = buildLimb(+1);
        const lower = buildLimb(-1);
        this.upperSegs = upper.segs;
        this.lowerSegs = lower.segs;
        this.tipTop = upper.tip;
        this.tipBottom = lower.tip;

        // String: two stretched cylinders tip -> nock.
        const mkString = (n) => {
            const m = BABYLON.MeshBuilder.CreateCylinder(n, { height: 1, diameter: 0.004, tessellation: 6 }, scene);
            m.parent = this.aimPivot;
            m.material = stringMat;
            m.rotationQuaternion = new BABYLON.Quaternion();
            return m;
        };
        this.stringTop = mkString("bow-stringTop");
        this.stringBottom = mkString("bow-stringBottom");

        // Nock rest + nock. Their -Z offset matches the tips' rest Z so the
        // undrawn string is straight; computed after the first setTension.
        this.nockRest = new BABYLON.TransformNode("bow-nockRest", scene);
        this.nockRest.parent = this.aimPivot;
        this.nock = new BABYLON.TransformNode("bow-nock", scene);
        this.nock.parent = this.aimPivot;
        const nockMarker = BABYLON.MeshBuilder.CreateSphere("bow-nockMarker", { diameter: 0.012 }, scene);
        nockMarker.parent = this.nock;
        nockMarker.material = stringMat;
    }

    // tension 0..1 — bends the limbs (procedural flex "clip" scrub).
    setTension(t) {
        this.tension = t;
        for (let i = 0; i < LIMB_SEGMENTS; i++) {
            const bend = BASE_BEND + FLEX_BEND * t;
            this.upperSegs[i].rotation = new BABYLON.Vector3(-bend * (i === 0 ? 0.5 : 1), 0, 0);
            this.lowerSegs[i].rotation = new BABYLON.Vector3(bend * (i === 0 ? 0.5 : 1), 0, 0);
        }
        // Rest Z for the string line, from the tip position at tension 0.
        if (this._restZ === undefined) {
            this.aimPivot.computeWorldMatrix(true);
            this.tipTop.computeWorldMatrix(true);
            const tipLocal = BABYLON.Vector3.TransformCoordinates(
                this.tipTop.getAbsolutePosition(),
                this.aimPivot.getWorldMatrix().clone().invert());
            this._restZ = tipLocal.z;
            this.nockRest.position = new BABYLON.Vector3(0, 0, this._restZ);
            this.nock.position = this.nockRest.position.clone();
        }
    }

    // Keep the two string segments stretched tip->nock (call every frame).
    _updateString() {
        const inv = this.aimPivot.getWorldMatrix().clone().invert();
        const toLocal = (node) => BABYLON.Vector3.TransformCoordinates(node.getAbsolutePosition(), inv);
        const nock = toLocal(this.nock);
        for (const [str, tipNode] of [[this.stringTop, this.tipTop], [this.stringBottom, this.tipBottom]]) {
            const tip = toLocal(tipNode);
            const mid = tip.add(nock).scaleInPlace(0.5);
            const dir = nock.subtract(tip);
            const len = Math.max(dir.length(), 1e-4);
            str.position = mid;
            BABYLON.Quaternion.FromUnitVectorsToRef(BABYLON.Vector3.Up(), dir.scale(1 / len), str.rotationQuaternion);
            str.scaling.y = len;
        }
    }

    // --- two-handed package -------------------------------------------
    _attachDrawHand() {
        const other = this.bowHand === "left" ? "right" : "left";
        this.drawHand = other;
        const grip = this.ctx.hands.hands[other].gripNode;
        this.nockOrigin = new BABYLON.TransformNode("drawhand-nockOrigin", this.ctx.scene);
        this.nockOrigin.parent = grip;
        this.nockOrigin.position = new BABYLON.Vector3(0, 0.01, 0.02); // near the knuckles
        // Held arrows copy this node's world rotation (+Z = tip): same
        // 90°-about-X grip rotation as the bow, so the shaft runs along
        // the extended index finger, not the thumb.
        this.nockOrigin.rotationQuaternion = SNAP_ROT.clone();
    }

    _detachDrawHand() {
        this.nockOrigin?.dispose();
        this.nockOrigin = null;
        this.drawHand = null;
    }

    grabbed(hand) {
        this.bowHand = hand;
        // Authored for a left-hand hold; mirror for right-handed grip.
        this.root.scaling.x = hand === "right" ? -1 : 1;
        // Grip-local pose (overrides the interaction snap, which is
        // identity — see SNAP_ROT above; same quaternion both hands).
        this.root.position.copyFrom(SNAP_POS);
        this.root.rotationQuaternion.copyFrom(SNAP_ROT);
        this._attachDrawHand();
        this.onGrabbed?.(this.bowHand, this.drawHand);
    }

    released() {
        this._detachDrawHand();
        this.root.scaling.x = 1;
        this.bowHand = null;
        this.aimActive = false;
        // update() skips _updateAim with no bow hand — drop any nocked-aim
        // tilt now so a released bow doesn't freeze mid-aim.
        this._aimWeight = 0;
        this.aimPivot.rotationQuaternion.copyFrom(BABYLON.Quaternion.Identity());
        this.onReleased?.();
    }

    // aimPivot-local rotation that puts bow +Z along world `forward` and the
    // stave (+Y) along world `up`, accounting for the root's grip pose and
    // x-mirror. Map the world axes through root⁻¹ and rebuild via cross
    // products — the mirror turns a mapped triple left-handed, and quaternion
    // math under negative scale is invalid (see seatRotation).
    _localOrient(forward, up) {
        const invRoot = this.root.getWorldMatrix().clone().invert();
        const lz = BABYLON.Vector3.TransformNormal(forward, invRoot).normalize();
        const lyRaw = BABYLON.Vector3.TransformNormal(up, invRoot).normalize();
        const lx = BABYLON.Vector3.Cross(lyRaw, lz).normalize();
        const ly = BABYLON.Vector3.Cross(lz, lx).normalize();
        return BABYLON.Quaternion.RotationQuaternionFromAxis(lx, ly, lz);
    }

    // --- aim: rest = index-finger pointing; nocked = aim down the arrow ----
    // Un-nocked, the bow points where the bow hand's index finger / aim ray
    // points (so it never dangles at the ground). Nocked, the flight axis is
    // the line from the draw hand THROUGH the bow hand (pivot) — the draw
    // hand owns both yaw and pitch — while ROLL (cant) follows the bow hand's
    // wrist. Blended over AIM_BLEND_TIME.
    _updateAim(dt) {
        const active = this.aimActive && this.bowHand && this.drawHand;
        this._aimWeight = Math.min(1, Math.max(0,
            this._aimWeight + (active ? dt : -dt) / AIM_BLEND_TIME));

        // Rest forward: the bow hand's pointer (index/aim) direction.
        const ctl = this.ctx.hands.hands[this.bowHand];
        const ptr = ctl.controller?.pointer ?? ctl.gripNode;
        const restFwd = ptr
            ? BABYLON.Vector3.TransformNormal(new BABYLON.Vector3(0, 0, 1), ptr.getWorldMatrix()).normalize()
            : new BABYLON.Vector3(0, 0, 1);
        const restLocal = this._localOrient(restFwd, BABYLON.Vector3.Up());

        if (this._aimWeight <= 0) {
            this.aimPivot.rotationQuaternion.copyFrom(restLocal);
            return;
        }

        // Nocked: forward = draw hand -> bow (pivot), so the draw hand sets
        // yaw AND pitch. Roll reference = the bow hand's grip +Z (thumb /
        // stave-up at the neutral pose), so cant follows the bow wrist.
        // Falls back to rest if the geometry is degenerate.
        let aimLocal = restLocal;
        const from = (this.nockOrigin ?? this.ctx.hands.hands[this.drawHand].gripNode)
            .getAbsolutePosition();
        const forward = this.aimPivot.getAbsolutePosition().subtract(from);
        if (forward.lengthSquared() >= 1e-6) {
            forward.normalize();
            const bowGrip = this.ctx.hands.hands[this.bowHand].gripNode;
            const upRef = BABYLON.Vector3.TransformNormal(
                new BABYLON.Vector3(0, 0, 1), bowGrip.getWorldMatrix()).normalize();
            aimLocal = this._localOrient(forward, upRef);
        }

        BABYLON.Quaternion.SlerpToRef(restLocal, aimLocal, this._aimWeight,
            this.aimPivot.rotationQuaternion);
    }

    update(dt) {
        if (this.bowHand) this._updateAim(dt);
        this._updateString();
    }

    // World direction an arrow would fly (bow local +Z).
    get flightDirection() {
        return BABYLON.Vector3.TransformNormal(
            new BABYLON.Vector3(0, 0, 1), this.aimPivot.getWorldMatrix()).normalize();
    }

    // Rest-position local Z of the nock/string line (negative; set once
    // from the tension-0 tip position).
    get restZ() { return this._restZ; }

    // World rotation that seats an arrow: +Z along flight, +Y up the stave.
    // Built from world POSITIONS so it stays valid under the x-scale -1
    // right-hand mirror (decomposed rotations don't).
    get seatRotation() {
        const wm = this.aimPivot.getWorldMatrix();
        const origin = BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.Zero(), wm);
        const forward = BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(0, 0, 1), wm)
            .subtractInPlace(origin).normalize();
        const up = this.tipTop.getAbsolutePosition()
            .subtract(this.tipBottom.getAbsolutePosition()).normalize();
        const right = BABYLON.Vector3.Cross(up, forward).normalize();
        const trueUp = BABYLON.Vector3.Cross(forward, right);
        return BABYLON.Quaternion.RotationQuaternionFromAxis(right, trueUp, forward);
    }
}
