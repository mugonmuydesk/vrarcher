// Physics hand presence ("touch"): hands stop on surfaces instead of
// clipping through them.
//
// Architecture (avoids both BabylonHands failure modes):
//   ANIMATED anchor body — driven each frame by body.setTargetTransform()
//     from the grip pose. Velocity-correct: NEVER teleport the anchor's
//     transform; a teleported anchor makes the damper fight phantom
//     velocity -> energy injection -> jitter.
//   DYNAMIC palm body — gravity factor 0, ALWAYS_ACTIVE, 0.5 kg, chunky
//     7 cm collider.
//   6DOF constraint between them — ALL axes FREE; each axis gets a
//     raw-WASM SPRING_ACCELERATION motor targeting zero offset (in the
//     anchor's frame, so there is no per-frame error decomposition and no
//     180° singularity), max-force capped.
//
// The visual hand mesh is adopted from the grip onto the palm body's node.
// Hand↔anchor displacement drives press haptics, gated on live Havok
// contact (free-air tracking lag alone crosses the threshold); beyond
// 0.3 m the palm snaps back (the one permitted teleport, velocities zeroed).

import { LINEAR_AXES, ANGULAR_AXES, LAYERS } from "./physics.js";
import { HAND_PITCH_Q } from "./hands.js";

export const HAND_TUNING = {
    mass: 0.5,                 // kg (BabylonHands)
    colliderExtent: 0.07,      // m box edge — placeholder until the GLB lands
    // SPRING_ACCELERATION motors: accel = k·err − c·vel (mass-independent),
    // so critical damping is c = 2√k exactly. Keep ζ = 1 when retuning:
    // underdamped wobbles, overdamped smears tracking.
    linear: { stiffness: 3500, damping: 118.3, maxForce: 500 },  // ωn ≈ 59 rad/s
    angular: { stiffness: 2000, damping: 89.4, maxForce: 60 },   // ωn ≈ 45 rad/s
    snapDistance: 0.3,         // m
    // contactGrace: how long after the last Havok contact event the palm
    // still counts as touching (s) — covers the event→update gap; keep it
    // a few physics steps long.
    press: { min: 0.008, max: 0.06, ampMin: 0.1, ampMax: 0.7, contactGrace: 0.07 },
    // unpinGrace: after a hand pin releases the ghost may be far from the
    // palm; suppress the snap-teleport this long so the spring pulls the
    // hand back smoothly instead (s).
    unpinGrace: 0.4,
    // Full-hand compound collider (palm slab + finger slab + thumb), built
    // from the rest-pose skeleton once the hand GLB loads. Pads are the
    // half-thickness added around the bone AABBs (m).
    palmPad: 0.014,
    fingerPad: 0.011,
    thumbPad: 0.011,
};

export class PhysicsHand {
    constructor(ctx, hand) {
        this.ctx = ctx;
        this.hand = hand;
        const scene = ctx.scene;
        const phys = ctx.physics;

        // Anchor: ANIMATED, collides with nothing.
        this.anchorNode = new BABYLON.TransformNode(`${hand}-palm-anchor`, scene);
        this.anchorNode.rotationQuaternion = new BABYLON.Quaternion();
        this.anchorBody = new BABYLON.PhysicsBody(
            this.anchorNode, BABYLON.PhysicsMotionType.ANIMATED, false, scene);
        const anchorShape = new BABYLON.PhysicsShapeSphere(BABYLON.Vector3.Zero(), 0.005, scene);
        anchorShape.filterMembershipMask = 0;
        anchorShape.filterCollideMask = 0;
        this.anchorBody.shape = anchorShape;

        // Palm: DYNAMIC, no gravity, always active.
        const e = HAND_TUNING.colliderExtent;
        this.palmNode = BABYLON.MeshBuilder.CreateBox(`${hand}-palm-body`, { size: e }, scene);
        this.palmNode.rotationQuaternion = new BABYLON.Quaternion();
        this.palmNode.visibility = 0; // set 0.4 to debug
        this.palmBody = new BABYLON.PhysicsBody(
            this.palmNode, BABYLON.PhysicsMotionType.DYNAMIC, false, scene);
        const palmShape = new BABYLON.PhysicsShapeBox(
            BABYLON.Vector3.Zero(), BABYLON.Quaternion.Identity(),
            new BABYLON.Vector3(e, e, e), scene);
        this._setHandFilter(palmShape);
        this.palmBody.shape = palmShape;
        this.palmBody.setMassProperties({ mass: HAND_TUNING.mass });
        this.palmBody.setGravityFactor(0);
        this.palmBody.setLinearDamping(0.5);
        this.palmBody.setAngularDamping(2);

        // ALWAYS_ACTIVE — only reachable through raw WASM.
        const hknp = phys.hknp;
        hknp.HP_Body_SetActivationControl(
            phys.bodyId(this.palmBody), hknp.ActivationControl.ALWAYS_ACTIVE);

        // Contact gate for press haptics. The spring palm lags the tracked
        // hand in free air too (steady-state lag ≈ v·c/k ≈ 34 ms of travel),
        // so displacement alone can't tell "pressed into a surface" from
        // "moving" — only tick while Havok reports live contact. The body
        // observable gets COLLISION_STARTED + CONTINUED every step a contact
        // persists (FINISHED routes to the ended observable), so a refreshed
        // timestamp + short grace window is enough; no contact counting.
        this._lastContactTime = -Infinity;
        this.palmBody.setCollisionCallbackEnabled(true);
        this.palmBody.getCollisionObservable().add(() => {
            this._lastContactTime = performance.now() / 1000;
        });

        // 6DOF, all axes free, spring-acceleration motors to zero.
        this.constraint = phys.make6DoF(scene);
        this.anchorBody.addConstraint(this.palmBody, this.constraint);
        for (const axis of LINEAR_AXES) phys.setSpringMotor(this.constraint, axis, HAND_TUNING.linear);
        for (const axis of ANGULAR_AXES) phys.setSpringMotor(this.constraint, axis, HAND_TUNING.angular);

        this._visualAdopted = false;
        this._snapRestoreCountdown = 0;
        this.displacement = 0;
        this.enabled = true;
        this._wasPinned = false;
        this._unpinGrace = 0;
    }

    // Environment + free grabbables; held items move to LAYERS.HELD so they
    // never shove the hand that carries them (throwable.js wireHeldFilter).
    _setHandFilter(shape) {
        shape.filterMembershipMask = LAYERS.HAND;
        shape.filterCollideMask = LAYERS.DEFAULT | LAYERS.GRABBABLE;
    }

    // Move the visual hand mesh from the grip onto the palm body node,
    // preserving its local counter-rotation.
    _adoptVisual() {
        const rig = this.ctx.hands.hands[this.hand].rig;
        if (!rig) return;
        const root = rig.root;
        const localRot = root.rotationQuaternion?.clone();
        const localPos = root.position.clone();
        root.parent = this.palmNode;
        root.position = localPos;
        if (localRot) root.rotationQuaternion = localRot;
        this._visualAdopted = true;
        this._buildHandShape();
    }

    // Replace the placeholder palm box with a compound shape covering the
    // whole hand: palm slab (wrist→knuckles), finger slab (knuckles→tips,
    // open pose) and thumb box. The UNPITCHED hand sits nearly axis-
    // aligned in grip space (fingers -Y, palm normal ±X, thumb +Z), so
    // the AABBs are fitted in the unpitched frame (bone points counter-
    // rotated by HAND_PITCH_Q⁻¹) and each box is rotated back — keeping
    // the fit tight under the visual pitch trim.
    _buildHandShape() {
        const handCtl = this.ctx.hands.hands[this.hand];
        const skinned = handCtl._skinned;
        const rig = handCtl.rig;
        if (!skinned || this._handShapeBuilt) return;

        const root = rig.root;
        root.computeWorldMatrix(true);
        skinned.skeleton.computeAbsoluteTransforms(true);
        // bone world → palm-node local = bone world → root local → root's
        // local transform under the palm node.
        const invRoot = BABYLON.Matrix.Invert(root.getWorldMatrix());
        const rootLocal = BABYLON.Matrix.Compose(
            root.scaling, root.rotationQuaternion ?? BABYLON.Quaternion.Identity(), root.position);
        const toPalm = invRoot.multiply(rootLocal);

        const bones = {};
        for (const b of skinned.skeleton.bones) bones[b.name] = b;
        const invPitch = BABYLON.Quaternion.Inverse(HAND_PITCH_Q);
        const pt = (name) => {
            const b = bones[name];
            return b ? BABYLON.Vector3.TransformCoordinates(
                b.getAbsolutePosition(skinned), toPalm)
                .applyRotationQuaternionInPlace(invPitch) : null;
        };
        // Fingertips: last joint extended by 80% of the last segment.
        const tip = (bName, cName) => {
            const b = pt(bName), c = pt(cName);
            return (b && c) ? c.add(c.subtract(b).scaleInPlace(0.8)) : null;
        };
        const groups = {
            palm: { pad: HAND_TUNING.palmPad, points: [
                pt("Palm"), pt("F1a"), pt("F2a"), pt("F3a"), pt("F4a"), pt("Ta")] },
            fingers: { pad: HAND_TUNING.fingerPad, points: [
                pt("F1a"), pt("F2a"), pt("F3a"), pt("F4a"),
                pt("F1b"), pt("F2b"), pt("F3b"), pt("F4b"),
                pt("F1c"), pt("F2c"), pt("F3c"), pt("F4c"),
                tip("F1b", "F1c"), tip("F2b", "F2c"), tip("F3b", "F3c"), tip("F4b", "F4c")] },
            thumb: { pad: HAND_TUNING.thumbPad, points: [
                pt("Ta"), pt("Tb"), pt("Tc"), tip("Tb", "Tc")] },
        };

        const scene = this.ctx.scene;
        const container = new BABYLON.PhysicsShapeContainer(scene);
        for (const [name, g] of Object.entries(groups)) {
            const pts = g.points.filter(Boolean);
            if (pts.length < 2) continue;
            const min = pts[0].clone(), max = pts[0].clone();
            for (const p of pts) {
                min.minimizeInPlace(p);
                max.maximizeInPlace(p);
            }
            // AABB fitted in the unpitched frame; rotate the box (and its
            // center) back into palm space.
            const center = min.add(max).scaleInPlace(0.5)
                .applyRotationQuaternionInPlace(HAND_PITCH_Q);
            const extent = max.subtract(min).addInPlace(
                new BABYLON.Vector3(2 * g.pad, 2 * g.pad, 2 * g.pad));
            const box = new BABYLON.PhysicsShapeBox(
                center, HAND_PITCH_Q, extent, scene);
            this._setHandFilter(box);
            container.addChild(box);
            this.ctx.debug.set(`${this.hand} ${name} box`,
                `c(${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)}) ` +
                `e(${extent.x.toFixed(2)},${extent.y.toFixed(2)},${extent.z.toFixed(2)})`);
        }
        this._setHandFilter(container);

        const old = this.palmBody.shape;
        this.palmBody.shape = container;
        old.dispose();
        // Pin the mass properties: letting Havok derive them from the
        // compound shape moves the centre of mass ~5 cm toward the fingers
        // (off the constraint pivot) and grows inertia ~10× — the servo
        // then drives a lopsided body and every move swings like a
        // pendulum. Keep CoM on the pivot and the old 7 cm-box inertia the
        // springs were tuned against.
        this.palmBody.setMassProperties({
            mass: HAND_TUNING.mass,
            centerOfMass: BABYLON.Vector3.Zero(),
            inertia: new BABYLON.Vector3(4e-4, 4e-4, 4e-4),
        });
        this._handShapeBuilt = true;
    }

    _snapTo(pos, rot) {
        // Teleport the DYNAMIC palm (allowed only here): enable pre-step
        // sync for one frame so the node transform reaches the body.
        this.palmNode.position.copyFrom(pos);
        this.palmNode.rotationQuaternion.copyFrom(rot);
        this.palmBody.setLinearVelocity(BABYLON.Vector3.Zero());
        this.palmBody.setAngularVelocity(BABYLON.Vector3.Zero());
        this.palmBody.disablePreStep = false;
        this._snapRestoreCountdown = 2;
    }

    update(dt) {
        const handCtl = this.ctx.hands.hands[this.hand];
        if (!this.enabled || !handCtl.tracking) return;

        if (!this._visualAdopted) this._adoptVisual();

        if (this._snapRestoreCountdown > 0 && --this._snapRestoreCountdown === 0) {
            this.palmBody.disablePreStep = true;
        }

        // Hand pin (handpin.js): while holding a constrained mechanism the
        // servo targets the mechanism's grab pose, not the tracked grip —
        // the controller is reduced to ghost input. On unpin the ghost may
        // be far away: a grace window suppresses the snap-teleport so the
        // spring pulls the hand back smoothly.
        const pin = this.ctx.handPins[this.hand];
        if (this._wasPinned && !pin) this._unpinGrace = HAND_TUNING.unpinGrace;
        this._wasPinned = !!pin;
        if (this._unpinGrace > 0) this._unpinGrace -= dt;

        const pinned = pin ? pin.pose() : null;
        const targetPos = pinned ? pinned.position : handCtl.worldPosition;
        const targetRot = pinned ? pinned.rotation : handCtl.worldRotation;

        // Velocity-correct anchor drive.
        this.anchorBody.setTargetTransform(targetPos, targetRot);

        // Displacement: how far the physical palm lags its target pose.
        this.displacement = BABYLON.Vector3.Distance(this.palmNode.absolutePosition, targetPos);

        if (this.displacement > HAND_TUNING.snapDistance && this._unpinGrace <= 0) {
            this._snapTo(targetPos, targetRot);
            this.displacement = 0;
            return;
        }

        // Press haptics: continuous ticks scaled by how hard the hand is
        // being pushed into a surface. Contact-gated — see constructor.
        const p = HAND_TUNING.press;
        const touching =
            performance.now() / 1000 - this._lastContactTime < p.contactGrace;
        if (touching && this.displacement > p.min) {
            const t = Math.min(1, (this.displacement - p.min) / (p.max - p.min));
            const amp = p.ampMin + t * (p.ampMax - p.ampMin);
            this.ctx.feedback.detent(this.hand, amp, "press", 0.05, this.palmNode);
        }
    }
}

export class PhysicsHandSystem {
    constructor(ctx) {
        this.ctx = ctx;
        // Per-hand pose-override registry: a HandPin (handpin.js) or null.
        // Writers: interaction.js (held mechanisms), arrow.js (nocked
        // string). Consumer: PhysicsHand.update above.
        ctx.handPins = { left: null, right: null };
        this.hands = {
            left: new PhysicsHand(ctx, "left"),
            right: new PhysicsHand(ctx, "right"),
        };
    }

    update(dt) {
        this.hands.left.update(dt);
        this.hands.right.update(dt);
        this.ctx.debug.set("palm disp", `L:${this.hands.left.displacement.toFixed(3)} R:${this.hands.right.displacement.toFixed(3)}`);
    }
}
