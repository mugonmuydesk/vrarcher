// Rotational + linear drives (hand-interactions.md §Rotational/Linear drives).
//
// CircularDrive — crank/valve/wheel. Hand position is projected onto the
// rotation plane (local XY, axis = local +Z); the angle accumulates
// (unlimited, with revolution counting) or clamps to [min,max]. At a limit
// the drive freezes until the hand backs off (tolerance 0.15 rad) — the
// hand's overshoot is capped at limit+tolerance, so it must unwind that
// much before the handle responds again. Two modes: "direct" snap-to-hand
// and "physics" (acceleration 5.0 toward the hand's angular velocity,
// friction 0.3, momentum after release). Haptic detent every 1° (amplitude
// 0.8, velocity-scaled in physics mode); a flourish of 10 random 100–900 µs
// pulses fires on release. Exposes value 0–1 (limits remapped) via onValue.
//
// LinearDrive — slider/drawer. Hand projected onto the start→end segment,
// value 0–1; optional momentum after release (5-frame velocity window,
// dampen rate 5). Detent ticks every 5% of travel (house rule).

import { Interactable, GrabType } from "./interaction.js";

export const CIRCULAR_TUNING = {
    acceleration: 5.0,  // 1/s — physics mode chase rate (spec)
    friction: 0.3,      // 1/s — free-spin decay (spec)
    detentDeg: 1.0,     // ° per haptic detent (spec)
    detentAmp: 0.8,     // (spec)
    tolerance: 0.15,    // rad — freeze-at-limit back-off (spec 0.1–0.2)
    flourish: { count: 10, usMin: 100, usMax: 900, spread: 0.25 }, // (spec)
};

export const LINEAR_TUNING = {
    dampenRate: 5,      // 1/s (spec)
    velocityFrames: 5,  // (spec)
    detentStep: 0.05,   // value per haptic tick (house rule)
};

const TWO_PI = Math.PI * 2;
const wrapPi = (a) => ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;

export class CircularDrive {
    /**
     * opts: position, rotation (Quaternion|null — local +Z is the axis),
     * armLength, limits [min,max] rad or null (unlimited), startAngle,
     * mode "direct"|"physics", onValue(value, angle)
     */
    constructor(ctx, {
        name = "crank", position, rotation = null,
        armLength = 0.12, limits = [0, TWO_PI], startAngle = 0,
        mode = "direct", onValue = null,
    } = {}) {
        this.ctx = ctx;
        this.limits = limits;
        this.mode = mode;
        this.onValue = onValue;
        this.armLength = armLength;
        this.omega = 0;          // rad/s (physics mode)
        this._lastHandAngle = 0;
        this._detentAccum = 0;
        this._held = false;

        const scene = ctx.scene;
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);
        if (rotation) this.root.rotationQuaternion = rotation.clone();

        const mat = new BABYLON.StandardMaterial(`${name}-mat`, scene);
        mat.diffuseColor = new BABYLON.Color3(0.55, 0.35, 0.15);
        const knobMat = new BABYLON.StandardMaterial(`${name}-knobMat`, scene);
        knobMat.diffuseColor = new BABYLON.Color3(0.75, 0.2, 0.15);

        // Axle along the rotation axis (+Z), arm out along pivot +X, knob
        // handle at the arm tip pointing back toward the player (−Z) so the
        // grab point sits clear of the arm.
        const axle = BABYLON.MeshBuilder.CreateCylinder(`${name}-axle`,
            { diameter: 0.04, height: 0.08 }, scene);
        axle.rotation.x = Math.PI / 2;
        axle.parent = this.root;
        axle.material = mat;

        this.pivot = new BABYLON.TransformNode(`${name}-pivot`, scene);
        this.pivot.parent = this.root;

        const arm = BABYLON.MeshBuilder.CreateBox(`${name}-arm`,
            { width: armLength, height: 0.03, depth: 0.03 }, scene);
        arm.position.x = armLength / 2;
        arm.parent = this.pivot;
        arm.material = mat;

        this.handle = BABYLON.MeshBuilder.CreateCylinder(`${name}-handle`,
            { diameter: 0.035, height: 0.09 }, scene);
        this.handle.rotation.x = Math.PI / 2;
        this.handle.position.set(armLength, 0, -0.055);
        this.handle.parent = this.pivot;
        this.handle.material = knobMat;

        this.setAngle(startAngle);

        this.interactable = ctx.interaction.register(new Interactable(this.handle, {
            grabTypes: [GrabType.GRIP, GrabType.PINCH],
            parentToHand: false,
            kinematic: false,
            holdPose: "Hold",
            hoverRadius: 0.06,
            // Hand rides the knob around the circle; free roll about the
            // knob's own bar axis (cylinder local +Y) only.
            pinHand: { rollAxis: new BABYLON.Vector3(0, 1, 0) },
            onGrab: (hand) => {
                this._held = hand;
                this._lastHandAngle = this._handAngle(hand);
                if (this.mode === "physics") this.omega = 0;
            },
            attachedUpdate: (dt, hand) => this._heldUpdate(dt, hand),
            onRelease: (hand) => {
                this._held = false;
                this._flourish(hand);
            },
        }));

        ctx.updatables.push((dt) => this.update(dt));
    }

    // Free spin with friction (momentum after release).
    update(dt) {
        if (this._held || this.mode !== "physics" || Math.abs(this.omega) < 1e-3) return;
        this._applyDelta(this.omega * dt, null);
        this.omega *= Math.max(0, 1 - CIRCULAR_TUNING.friction * dt);
        if (this.limits && (this.virtual <= this.limits[0] || this.virtual >= this.limits[1])) {
            this.omega = 0; // hit a hard stop
        }
    }

    get value() {
        if (!this.limits) return this.angle;
        const [a, b] = this.limits;
        return Math.min(1, Math.max(0, (this.angle - a) / (b - a)));
    }

    get revolutions() { return Math.floor(this.angle / TWO_PI); }

    setAngle(angle) {
        this.virtual = angle;
        this.angle = this.limits
            ? Math.min(this.limits[1], Math.max(this.limits[0], angle)) : angle;
        this.pivot.rotation.z = this.angle;
        this.onValue?.(this.value, this.angle);
    }

    _handAngle(hand) {
        const p = this.ctx.hands.hands[hand].worldPosition;
        const local = BABYLON.Vector3.TransformCoordinates(
            p, BABYLON.Matrix.Invert(this.root.getWorldMatrix()));
        return Math.atan2(local.y, local.x);
    }

    _heldUpdate(dt, hand) {
        const handAngle = this._handAngle(hand);
        const delta = wrapPi(handAngle - this._lastHandAngle);
        this._lastHandAngle = handAngle;

        if (this.mode === "direct") {
            this._applyDelta(delta, hand);
        } else {
            // Chase the hand's angular velocity; the lag is the momentum feel.
            const handOmega = dt > 0 ? delta / dt : 0;
            this.omega += (handOmega - this.omega)
                * Math.min(1, CIRCULAR_TUNING.acceleration * dt);
            this._applyDelta(this.omega * dt, hand);
        }
    }

    _applyDelta(delta, hand) {
        const prev = this.angle;
        let v = this.virtual + delta;
        if (this.limits) {
            const t = CIRCULAR_TUNING.tolerance;
            // Overshoot caps at limit+tolerance: the freeze-at-limit
            // back-off the hand must unwind before the handle moves again.
            v = Math.min(this.limits[1] + t, Math.max(this.limits[0] - t, v));
        }
        this.virtual = v;
        this.angle = this.limits
            ? Math.min(this.limits[1], Math.max(this.limits[0], v)) : v;
        this.pivot.rotation.z = this.angle;

        const moved = Math.abs(this.angle - prev);
        if (moved > 0) {
            this._detentAccum += moved;
            const step = CIRCULAR_TUNING.detentDeg * Math.PI / 180;
            if (this._detentAccum >= step && hand) {
                this._detentAccum = 0;
                let amp = CIRCULAR_TUNING.detentAmp;
                if (this.mode === "physics") {
                    amp *= Math.min(1, Math.abs(this.omega) / 3);
                }
                this.ctx.feedback.detent(hand, amp, "crank", 0.015);
            }
            this.onValue?.(this.value, this.angle);
        }
    }

    _flourish(hand) {
        const f = CIRCULAR_TUNING.flourish;
        for (let i = 0; i < f.count; i++) {
            setTimeout(() => {
                this.ctx.feedback.hapticUs(hand,
                    f.usMin + Math.random() * (f.usMax - f.usMin));
            }, Math.random() * f.spread * 1000);
        }
    }
}

// ---------------------------------------------------------------------------

export class LinearDrive {
    /**
     * opts: start/end (world Vector3 rail endpoints), startValue,
     * momentum (default true), onValue(value)
     */
    constructor(ctx, {
        name = "slider", start, end, startValue = 0,
        momentum = true, onValue = null,
    } = {}) {
        this.ctx = ctx;
        this.start = start.clone();
        this.end = end.clone();
        this.momentum = momentum;
        this.onValue = onValue;
        this.velocity = 0; // value/s after release
        this._held = false;
        this._samples = []; // { value, dt } ring for the release velocity
        this._lastDetent = 0;

        const scene = ctx.scene;
        const railMat = new BABYLON.StandardMaterial(`${name}-railMat`, scene);
        railMat.diffuseColor = new BABYLON.Color3(0.25, 0.25, 0.28);
        const axis = end.subtract(start);
        this.length = axis.length();
        this.rail = BABYLON.MeshBuilder.CreateCylinder(`${name}-rail`,
            { diameter: 0.02, height: this.length }, scene);
        this.rail.position = start.add(end).scale(0.5);
        // Cylinder +Y -> rail axis.
        const dir = axis.normalize();
        const yAxis = BABYLON.Vector3.Up();
        const dot = BABYLON.Vector3.Dot(yAxis, dir);
        if (Math.abs(dot) < 0.999) {
            const rotAxis = BABYLON.Vector3.Cross(yAxis, dir).normalize();
            this.rail.rotationQuaternion =
                BABYLON.Quaternion.RotationAxis(rotAxis, Math.acos(dot));
        }
        this.rail.material = railMat;

        const knobMat = new BABYLON.StandardMaterial(`${name}-knobMat`, scene);
        knobMat.diffuseColor = new BABYLON.Color3(0.2, 0.5, 0.8);
        this.knob = BABYLON.MeshBuilder.CreateSphere(`${name}-knob`,
            { diameter: 0.07 }, scene);
        this.knob.material = knobMat;

        this.setValue(startValue);

        this.interactable = ctx.interaction.register(new Interactable(this.knob, {
            grabTypes: [GrabType.GRIP, GrabType.PINCH],
            parentToHand: false,
            kinematic: false,
            holdPose: "Hold",
            hoverRadius: 0.05,
            // Hand slides with the knob along the rail; free roll about
            // the rail axis only (knob never rotates, so its local frame
            // is world-aligned and the world rail direction is correct).
            pinHand: { rollAxis: dir.clone() },
            onGrab: () => { this._held = true; this.velocity = 0; this._samples.length = 0; },
            attachedUpdate: (dt, hand) => this._heldUpdate(dt, hand),
            onRelease: () => {
                this._held = false;
                if (!this.momentum) return;
                // 5-frame velocity window.
                let dv = 0, time = 0;
                for (const s of this._samples) { dv += s.dv; time += s.dt; }
                this.velocity = time > 0 ? dv / time : 0;
            },
        }));

        ctx.updatables.push((dt) => this.update(dt));
    }

    // Post-release momentum along the rail.
    update(dt) {
        if (this._held || Math.abs(this.velocity) < 1e-3) return;
        this.setValue(this.value + this.velocity * dt, null);
        this.velocity *= Math.max(0, 1 - LINEAR_TUNING.dampenRate * dt);
        if (this.value <= 0 || this.value >= 1) this.velocity = 0;
    }

    setValue(v, hand = undefined) {
        const prev = this.value ?? 0;
        this.value = Math.min(1, Math.max(0, v));
        this.knob.position = BABYLON.Vector3.Lerp(this.start, this.end, this.value);
        if (this.value !== prev) {
            if (hand && Math.abs(this.value - this._lastDetent) >= LINEAR_TUNING.detentStep) {
                this._lastDetent = this.value;
                this.ctx.feedback.detent(hand, 0.3, "slider", 0.02);
            }
            this.onValue?.(this.value);
        }
    }

    _heldUpdate(dt, hand) {
        const p = this.ctx.hands.hands[hand].worldPosition;
        const axis = this.end.subtract(this.start);
        const t = BABYLON.Vector3.Dot(p.subtract(this.start), axis)
            / axis.lengthSquared();
        const prev = this.value;
        this.setValue(t, hand);
        this._samples.push({ dv: this.value - prev, dt });
        if (this._samples.length > LINEAR_TUNING.velocityFrames) this._samples.shift();
    }
}
