// Constrained handles (hand-interactions.md §Constrained handles).
//
// Joystick — grab the knob then deflect: hand displacement SINCE GRAB in
// the base plane maps to −1…+1 per axis across the 0.1 m active zone
// (grab-relative, because the grip pose sits a few cm off the knob centre —
// absolute measurement biases the axes the moment you grab); auto-detach
// if the hand strays >0.3 m from its grab point; recenters over 0.1 s on
// release; haptic tick every 2° of deflection change (0.2 amp).
//
// IKArm — desk-lamp: a 3-segment FABRIK chain pinned at the base. Grab the
// head; the IK goal chases the hand with weighted smoothing (rate 4.0 /s);
// auto-detach beyond 0.3 m hand↔effector; haptic every 12 ms with amplitude
// from effector speed (0.3→2.0 m/s ⇒ 0.5→1.0).

import { Interactable, GrabType } from "./interaction.js";

export const JOYSTICK_TUNING = {
    zone: 0.1,        // m — full deflection (spec)
    breakDist: 0.3,   // m — auto-detach (spec)
    recenter: 0.1,    // s (spec)
    tickDeg: 2,       // ° per haptic tick (spec)
    tickAmp: 0.2,     // (spec)
    maxTilt: 0.45,    // rad — visual tilt at full deflection
};

export const IKARM_TUNING = {
    smoothing: 4.0,     // 1/s — goal chase rate (spec)
    breakDist: 0.3,     // m (spec)
    hapticPeriod: 0.012, // s (spec)
    speedMin: 0.3, speedMax: 2.0, ampMin: 0.5, ampMax: 1.0, // (spec)
    segments: [0.22, 0.22, 0.12],
    iterations: 4,
};

export class Joystick {
    constructor(ctx, { name = "joystick", position, onValue = null } = {}) {
        this.ctx = ctx;
        this.onValue = onValue;
        this.axes = { x: 0, z: 0 };
        this._held = false;
        this._recenterT = 0;
        this._lastTiltDeg = 0;

        const scene = ctx.scene;
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);

        const baseMat = new BABYLON.StandardMaterial(`${name}-baseMat`, scene);
        baseMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.22);
        const base = BABYLON.MeshBuilder.CreateCylinder(`${name}-base`,
            { diameter: 0.16, height: 0.04 }, scene);
        base.position.y = 0.02;
        base.parent = this.root;
        base.material = baseMat;

        this.pivot = new BABYLON.TransformNode(`${name}-pivot`, scene);
        this.pivot.parent = this.root;
        this.pivot.position.y = 0.04;

        const stickMat = new BABYLON.StandardMaterial(`${name}-stickMat`, scene);
        stickMat.diffuseColor = new BABYLON.Color3(0.4, 0.4, 0.45);
        this.stickLen = 0.12;
        const stick = BABYLON.MeshBuilder.CreateCylinder(`${name}-stick`,
            { diameter: 0.025, height: this.stickLen }, scene);
        stick.position.y = this.stickLen / 2;
        stick.parent = this.pivot;
        stick.material = stickMat;

        const knobMat = new BABYLON.StandardMaterial(`${name}-knobMat`, scene);
        knobMat.diffuseColor = new BABYLON.Color3(0.8, 0.3, 0.2);
        this.knob = BABYLON.MeshBuilder.CreateSphere(`${name}-knob`,
            { diameter: 0.06 }, scene);
        this.knob.position.y = this.stickLen;
        this.knob.parent = this.pivot;
        this.knob.material = knobMat;

        this.interactable = ctx.interaction.register(new Interactable(this.knob, {
            grabTypes: [GrabType.GRIP, GrabType.PINCH],
            parentToHand: false,
            kinematic: false,
            holdPose: "Hold",
            hoverRadius: 0.045,
            // Hand rides the knob through the tilt; the stick doesn't
            // twist, so no roll freedom either.
            pinHand: {},
            onGrab: (hand) => {
                this._held = hand;
                this._grabLocal = this._handLocal(hand);
            },
            attachedUpdate: (dt, hand) => this._heldUpdate(dt, hand),
            onRelease: () => { this._held = false; this._recenterT = 0; },
        }));

        ctx.updatables.push((dt) => this.update(dt));
    }

    // Recenter over 0.1 s after release.
    update(dt) {
        if (this._held || (this.axes.x === 0 && this.axes.z === 0)) return;
        this._recenterT += dt;
        const k = Math.min(1, dt / Math.max(1e-3, JOYSTICK_TUNING.recenter - this._recenterT + dt));
        this.axes.x += (0 - this.axes.x) * k;
        this.axes.z += (0 - this.axes.z) * k;
        if (Math.hypot(this.axes.x, this.axes.z) < 0.01) {
            this.axes.x = 0; this.axes.z = 0;
        }
        this._applyTilt();
        this.onValue?.(this.axes.x, this.axes.z);
    }

    _handLocal(hand) {
        return BABYLON.Vector3.TransformCoordinates(
            this.ctx.hands.hands[hand].worldPosition,
            BABYLON.Matrix.Invert(this.root.getWorldMatrix()));
    }

    _applyTilt() {
        this.pivot.rotation.x = this.axes.z * JOYSTICK_TUNING.maxTilt;
        this.pivot.rotation.z = -this.axes.x * JOYSTICK_TUNING.maxTilt;
    }

    _heldUpdate(dt, hand) {
        const rel = this._handLocal(hand).subtract(this._grabLocal);
        if (rel.length() > JOYSTICK_TUNING.breakDist) {
            this.ctx.interaction.release(hand); // strayed: auto-detach
            return;
        }
        const clamp1 = (v) => Math.min(1, Math.max(-1, v));
        this.axes.x = clamp1(rel.x / JOYSTICK_TUNING.zone);
        this.axes.z = clamp1(rel.z / JOYSTICK_TUNING.zone);
        this._applyTilt();

        // Tick every 2° of deflection change.
        const tiltDeg = Math.hypot(this.axes.x, this.axes.z)
            * JOYSTICK_TUNING.maxTilt * 180 / Math.PI;
        if (Math.abs(tiltDeg - this._lastTiltDeg) >= JOYSTICK_TUNING.tickDeg) {
            this._lastTiltDeg = tiltDeg;
            this.ctx.feedback.detent(hand, JOYSTICK_TUNING.tickAmp, "joystick", 0.02, this.root);
        }
        this.onValue?.(this.axes.x, this.axes.z);
    }
}

// ---------------------------------------------------------------------------

export class IKArm {
    constructor(ctx, { name = "ikarm", position, onMove = null } = {}) {
        this.ctx = ctx;
        this.onMove = onMove;
        const T = IKARM_TUNING;
        this._held = false;
        this._goal = null;
        this._hapticAccum = 0;
        this._prevEffector = null;

        const scene = ctx.scene;
        this.base = position.clone();

        // Joints: base pinned; start gently bent so the lamp reads as a lamp.
        this.joints = [
            this.base.clone(),
            this.base.add(new BABYLON.Vector3(0.05, T.segments[0], 0)),
            this.base.add(new BABYLON.Vector3(0.16, T.segments[0] + 0.17, 0)),
            this.base.add(new BABYLON.Vector3(0.22, T.segments[0] + 0.27, 0)),
        ];
        this._fixLengths();

        const mat = new BABYLON.StandardMaterial(`${name}-mat`, scene);
        mat.diffuseColor = new BABYLON.Color3(0.35, 0.4, 0.5);
        const footMat = new BABYLON.StandardMaterial(`${name}-footMat`, scene);
        footMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.25);

        const foot = BABYLON.MeshBuilder.CreateCylinder(`${name}-foot`,
            { diameter: 0.14, height: 0.03 }, scene);
        foot.position = this.base.add(new BABYLON.Vector3(0, 0.015, 0));
        foot.material = footMat;

        this.segMeshes = T.segments.map((len, i) => {
            const seg = BABYLON.MeshBuilder.CreateCylinder(`${name}-seg${i}`,
                { diameter: 0.03 - i * 0.005, height: len }, scene);
            seg.rotationQuaternion = new BABYLON.Quaternion();
            seg.material = mat;
            return seg;
        });

        const headMat = new BABYLON.StandardMaterial(`${name}-headMat`, scene);
        headMat.diffuseColor = new BABYLON.Color3(0.85, 0.75, 0.3);
        headMat.emissiveColor = new BABYLON.Color3(0.3, 0.25, 0.05);
        this.head = BABYLON.MeshBuilder.CreateSphere(`${name}-head`,
            { diameter: 0.07 }, scene);
        this.head.material = headMat;

        this._syncMeshes();

        this.interactable = ctx.interaction.register(new Interactable(this.head, {
            grabTypes: [GrabType.GRIP, GrabType.PINCH],
            parentToHand: false,
            kinematic: false,
            holdPose: "Hold",
            hoverRadius: 0.05,
            // Ball grip: hand position welded to the lamp head (which the
            // IK goal chases), wrist rotation stays free.
            pinHand: { freeRotation: true },
            onGrab: (hand) => {
                this._held = hand;
                this._goal = this.effector.clone();
                this._prevEffector = this.effector.clone();
                this._hapticAccum = 0;
            },
            attachedUpdate: (dt, hand) => this._heldUpdate(dt, hand),
            onRelease: () => { this._held = false; },
        }));
    }

    get effector() { return this.joints[3]; }

    _fixLengths() {
        const T = IKARM_TUNING;
        for (let i = 0; i < 3; i++) {
            const d = this.joints[i + 1].subtract(this.joints[i]);
            this.joints[i + 1] = this.joints[i].add(d.normalize().scale(T.segments[i]));
        }
    }

    _solve(target) {
        const T = IKARM_TUNING;
        const j = this.joints;
        for (let it = 0; it < T.iterations; it++) {
            // Backward: effector to target, walk in.
            j[3] = target.clone();
            for (let i = 2; i >= 0; i--) {
                const d = j[i].subtract(j[i + 1]).normalize();
                j[i] = j[i + 1].add(d.scale(T.segments[i]));
            }
            // Forward: re-pin the base, walk out.
            j[0] = this.base.clone();
            for (let i = 0; i < 3; i++) {
                const d = j[i + 1].subtract(j[i]).normalize();
                j[i + 1] = j[i].add(d.scale(T.segments[i]));
            }
        }
    }

    _syncMeshes() {
        for (let i = 0; i < 3; i++) {
            const a = this.joints[i], b = this.joints[i + 1];
            const mid = a.add(b).scale(0.5);
            const dir = b.subtract(a).normalize();
            this.segMeshes[i].position = mid;
            const dot = BABYLON.Vector3.Dot(BABYLON.Vector3.Up(), dir);
            if (Math.abs(dot) > 0.9999) {
                this.segMeshes[i].rotationQuaternion = BABYLON.Quaternion.Identity();
            } else {
                const axis = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), dir).normalize();
                this.segMeshes[i].rotationQuaternion =
                    BABYLON.Quaternion.RotationAxis(axis, Math.acos(dot));
            }
        }
        this.head.position = this.joints[3];
    }

    _heldUpdate(dt, hand) {
        const T = IKARM_TUNING;
        const handPos = this.ctx.hands.hands[hand].worldPosition;
        if (BABYLON.Vector3.Distance(handPos, this.effector) > T.breakDist) {
            this.ctx.interaction.release(hand); // effector can't keep up: detach
            return;
        }
        // Weighted goal smoothing toward the hand.
        const k = Math.min(1, T.smoothing * dt);
        this._goal = BABYLON.Vector3.Lerp(this._goal, handPos, k);
        this._solve(this._goal);
        this._syncMeshes();
        this.onMove?.(this.effector);

        // Haptic every 12 ms, amplitude from effector speed.
        const speed = dt > 0
            ? BABYLON.Vector3.Distance(this.effector, this._prevEffector) / dt : 0;
        this._prevEffector.copyFrom(this.effector);
        this._hapticAccum += dt;
        if (this._hapticAccum >= T.hapticPeriod && speed > T.speedMin) {
            this._hapticAccum = 0;
            const t = Math.min(1, (speed - T.speedMin) / (T.speedMax - T.speedMin));
            this.ctx.feedback.haptic(hand, T.ampMin + t * (T.ampMax - T.ampMin), 0.01);
        }
    }
}
