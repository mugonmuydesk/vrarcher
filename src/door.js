// Latched door: the panel won't move until the handle is turned.
//
// Grab the lever handle (grip/pinch). Twisting the hand rotates the lever
// (valve-style limited angle, spring-return on release, haptic tick every
// 3° @ 0.6 per the valve-turn spec). Once the lever passes the unlatch
// threshold (~40°) the latch bolt is free and the same hand can push/pull
// the panel: the hand's yaw arc around the hinge drives the swing, both
// directions, clamped at ±MAX_SWING. While the door is ajar (>3.5°) the
// bolt can't re-engage, so the handle is only needed from fully closed —
// matching a real spring-latch door. Re-latches with a clunk on closing.
//
// The panel carries an ANIMATED physics body (pre-step sync) so arrows and
// thrown props collide with it; the swing itself is hand-kinematic like the
// other drives, not a Havok hinge.

import { Interactable, GrabType } from "./interaction.js";

export const DOOR_TUNING = {
    unlatchAngle: 0.7,   // rad of handle turn that frees the bolt (~40°)
    handleMax: 1.2,      // rad — lever hard stop
    handleReturn: 5,     // 1/s — spring-return rate
    ajarAngle: 0.06,     // rad — beyond this the bolt can't re-engage
    maxSwing: 1.9,       // rad — frame stop both ways
    breakDist: 0.45,     // m — hand strays this far from the handle: release
    tickDeg: 3, tickAmp: 0.6, // valve-turn haptics (spec)
    pushMargin: 0.075,   // m — hand-radius slab around the panel for palm pushes
    pushMaxRate: 3,      // rad/s — palm-push swing speed cap
    pushMinLever: 0.15,  // m — clamp tiny lever arms near the hinge
    // Free-swing momentum: hand/push-imparted angular velocity carries the
    // panel after release, with hinge friction bleeding it off.
    swingVelSmooth: 10,  // 1/s — smoothing of the imparted-velocity estimate
    swingFriction: 0.9,  // 1/s — exponential hinge friction while coasting
    swingMinVel: 0.12,   // rad/s — below this the hinge sticks (Coulomb-ish)
    stopRestitution: 0.25, // bounce kept when slamming into the frame stop
};

const wrapPi = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

export class Door {
    // Hinge post at `position` (ground level); panel extends +X (rotated by
    // root.rotation.y), handle near the free edge.
    constructor(ctx, {
        name = "door", position,
        width = 0.7, height = 1.9, thickness = 0.05,
    } = {}) {
        this.ctx = ctx;
        this.latched = true;
        this.handleAngle = 0;   // signed lever turn, rad
        this.doorAngle = 0;     // signed swing, rad (0 = closed)
        this.swingVel = 0;      // rad/s — smoothed; coasts the panel when free
        this._held = false;
        this._lastHandYaw = 0;
        this._lastTwist = 0;
        this._detentAccum = 0;

        const scene = ctx.scene;
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);
        this._closedYaw = 0;

        const mk = (n, r, g, b) => {
            const m = new BABYLON.StandardMaterial(`${name}-${n}`, scene);
            m.diffuseColor = new BABYLON.Color3(r, g, b);
            return m;
        };
        const frameMat = mk("frameMat", 0.25, 0.2, 0.15);
        const panelMat = mk("panelMat", 0.5, 0.36, 0.22);
        const handleMat = mk("handleMat", 0.75, 0.7, 0.3);

        // Frame: two posts + lintel (static, world-anchored — not under root).
        for (const dx of [-0.05, width + 0.05]) {
            const post = BABYLON.MeshBuilder.CreateBox(`${name}-post${dx > 0 ? "R" : "L"}`,
                { width: 0.08, height: height + 0.1, depth: 0.1 }, scene);
            post.position.set(position.x + dx, (height + 0.1) / 2, position.z);
            post.material = frameMat;
            new BABYLON.PhysicsAggregate(post, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
        }
        const lintel = BABYLON.MeshBuilder.CreateBox(`${name}-lintel`,
            { width: width + 0.18, height: 0.08, depth: 0.1 }, scene);
        lintel.position.set(position.x + width / 2, height + 0.14, position.z);
        lintel.material = frameMat;
        new BABYLON.PhysicsAggregate(lintel, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);

        // Panel, hinged at the root (its -X edge).
        this.panel = BABYLON.MeshBuilder.CreateBox(`${name}-panel`,
            { width, height, depth: thickness }, scene);
        this.panel.position.set(width / 2, height / 2, 0);
        this.panel.parent = this.root;
        this.panel.material = panelMat;
        const agg = new BABYLON.PhysicsAggregate(this.panel,
            BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
        agg.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
        agg.body.disablePreStep = false;
        this.panelBody = agg.body;

        // Lever handle on the player-facing side near the free edge.
        this.handlePivot = new BABYLON.TransformNode(`${name}-handlePivot`, scene);
        this.handlePivot.parent = this.root;
        this.handlePivot.position.set(width - 0.08, 1.0, -(thickness / 2 + 0.03));

        const boss = BABYLON.MeshBuilder.CreateCylinder(`${name}-boss`,
            { diameter: 0.05, height: 0.06 }, scene);
        boss.rotation.x = Math.PI / 2;
        boss.position.z = 0.015;
        boss.parent = this.handlePivot;
        boss.material = handleMat;

        const lever = BABYLON.MeshBuilder.CreateBox(`${name}-lever`,
            { width: 0.14, height: 0.025, depth: 0.025 }, scene);
        lever.position.x = -0.06; // toward the hinge, like a real door
        lever.parent = this.handlePivot;
        lever.material = handleMat;

        this.knob = BABYLON.MeshBuilder.CreateSphere(`${name}-knob`,
            { diameter: 0.045 }, scene);
        this.knob.position.x = -0.12;
        this.knob.parent = this.handlePivot;
        this.knob.material = handleMat;

        this.interactable = ctx.interaction.register(new Interactable(this.knob, {
            grabTypes: [GrabType.GRIP, GrabType.PINCH],
            parentToHand: false,
            kinematic: false,
            holdPose: "Hold",
            hoverRadius: 0.05,
            // Knob composes door swing × handle twist through its node
            // chain (knob ← handlePivot ← root), so the pin inherits both
            // DOF for free; roll allowed about the lever bar (local X).
            pinHand: { rollAxis: new BABYLON.Vector3(1, 0, 0) },
            onGrab: (hand) => {
                this._held = hand;
                this._lastHandYaw = this._handYaw(hand);
                this._lastTwist = this._handTwist(hand);
            },
            attachedUpdate: (dt, hand) => this._heldUpdate(dt, hand),
            onRelease: () => { this._held = false; },
        }));

        this._panelDims = { width, height, thickness };

        ctx.updatables.push((dt) => this.update(dt));
    }

    // Handle spring-return, palm pushes, momentum coast and latch state
    // live even when the handle isn't held.
    update(dt) {
        if (!this._held && this.handleAngle !== 0) {
            const k = Math.min(1, DOOR_TUNING.handleReturn * dt);
            this.handleAngle += (0 - this.handleAngle) * k;
            if (Math.abs(this.handleAngle) < 0.01) this.handleAngle = 0;
            this._applyHandle();
        }
        this._pushedThisFrame = false;
        if (!this._held) this._palmPush(dt);
        if (!this._held) this._coast(dt);
        this._updateLatch();
    }

    // Fold an applied swing delta into the smoothed angular-velocity
    // estimate (also called with delta 0 by a stationary holding hand so
    // the estimate bleeds off — releasing a still door must not coast).
    _impartSwing(delta, dt) {
        if (dt <= 0) return;
        const k = Math.min(1, DOOR_TUNING.swingVelSmooth * dt);
        this.swingVel += (delta / dt - this.swingVel) * k;
    }

    // Free-swing momentum: integrate the imparted velocity with hinge
    // friction, bounce off the frame stops, let the latch catch it at home.
    _coast(dt) {
        const T = DOOR_TUNING;
        if (dt <= 0 || this.swingVel === 0) return;
        // Friction always bleeds; integration pauses on frames where a palm
        // push already moved the panel (it owns the motion that frame).
        this.swingVel *= Math.max(0, 1 - T.swingFriction * dt);
        if (Math.abs(this.swingVel) < T.swingMinVel) { this.swingVel = 0; return; }
        if (this._pushedThisFrame || this.latched) return;
        let a = this.doorAngle + this.swingVel * dt;
        if (Math.abs(a) >= T.maxSwing) {
            a = Math.sign(a) * T.maxSwing;
            const hit = Math.abs(this.swingVel);
            this.swingVel = -this.swingVel * T.stopRestitution;
            this.ctx.feedback.sound("impact", { pitch: 0.8, volume: Math.min(0.8, 0.25 + hit * 0.2) });
        }
        this.doorAngle = a;
        this.root.rotation.y = this._closedYaw + this.doorAngle;
    }

    // An unlatched door yields to hands pressing on the panel — including
    // hands that are stationary on the tracker but moving through the WORLD
    // because the player is locomoting (rig translation composes into the
    // controller poses): walking into a half-open door with an outstretched
    // hand pushes it further open, exactly like an arm push. Resolution:
    // when a hand's grip point enters the panel slab (thickness/2 + hand
    // radius), swing the door about the hinge so the surface stays ahead of
    // the hand — penetration / lever arm, rate-capped. Latched doors don't
    // budge (the bolt holds). Skipped while the handle is held: the held
    // hand's hinge-arc drive already absorbs locomotion-induced motion.
    _palmPush(dt) {
        if (this.latched) return;
        const T = DOOR_TUNING;
        const { width, height, thickness } = this._panelDims;
        const slab = thickness / 2 + T.pushMargin;
        const inv = BABYLON.Matrix.Invert(this.root.getWorldMatrix());
        for (const hand of ["left", "right"]) {
            const ctl = this.ctx.hands.hands[hand];
            if (!ctl.tracking) continue;
            const local = BABYLON.Vector3.TransformCoordinates(ctl.worldPosition, inv);
            if (local.x < 0.03 || local.x > width) continue;
            if (local.y < 0.05 || local.y > height) continue;
            if (Math.abs(local.z) >= slab) continue;
            const pen = slab - Math.abs(local.z);
            // LH small +Y rotation moves a point at local +x by −x·dA in
            // local z, so dA = sign(z)·pen/x moves the panel away from the
            // hand's side.
            let dA = Math.sign(local.z || 1) * pen / Math.max(local.x, T.pushMinLever);
            const cap = T.pushMaxRate * dt;
            dA = Math.min(cap, Math.max(-cap, dA));
            const prev = this.doorAngle;
            this.doorAngle = Math.min(T.maxSwing, Math.max(-T.maxSwing, this.doorAngle + dA));
            this.root.rotation.y = this._closedYaw + this.doorAngle;
            if (Math.abs(this.doorAngle - prev) > 1e-4) {
                this._pushedThisFrame = true;
                this._impartSwing(this.doorAngle - prev, dt);
                this.ctx.feedback.detent(hand, 0.25, "doorPush", 0.06);
            }
        }
    }

    get open() { return Math.abs(this.doorAngle); }
    get unlatched() { return !this.latched; }

    // Hand yaw around the hinge axis (world XZ).
    _handYaw(hand) {
        const p = this.ctx.hands.hands[hand].worldPosition;
        return Math.atan2(p.z - this.root.position.z, p.x - this.root.position.x);
    }

    // Hand roll around the handle boss axis, in the door PANEL's XY plane.
    // Must NOT be measured in the pivot's own frame: that frame rotates
    // with the lever, and lever-follows-hand in a rotating frame converges
    // to half the hand's angle (caught by the ext6 demo: 0.8 rad of hand
    // circling produced exactly 0.40 rad of lever).
    _handTwist(hand) {
        const local = BABYLON.Vector3.TransformCoordinates(
            this.ctx.hands.hands[hand].worldPosition,
            BABYLON.Matrix.Invert(this.root.getWorldMatrix()));
        const p = this.handlePivot.position;
        return Math.atan2(local.y - p.y, local.x - p.x);
    }

    _applyHandle() {
        this.handlePivot.rotation.z = this.handleAngle;
    }

    _updateLatch() {
        const wasLatched = this.latched;
        const boltFree = Math.abs(this.handleAngle) >= DOOR_TUNING.unlatchAngle
            || this.open > DOOR_TUNING.ajarAngle;
        this.latched = !boltFree;
        if (wasLatched !== this.latched) {
            let volume = 0.5;
            if (this.latched) {
                // Bolt catches: the door clicks home and momentum dies.
                volume = Math.min(0.9, 0.4 + Math.abs(this.swingVel) * 0.2);
                this.doorAngle = 0;
                this.swingVel = 0;
                this.root.rotation.y = this._closedYaw;
            }
            this.ctx.feedback.sound("impact", { pitch: this.latched ? 0.7 : 1.0, volume });
            if (this._held) this.ctx.feedback.haptic(this._held, 0.7, 0.03);
        }
        this.ctx.debug.set("door", `${this.latched ? "latched" : "free"} `
            + `handle ${(this.handleAngle * 180 / Math.PI).toFixed(0)}° `
            + `swing ${(this.doorAngle * 180 / Math.PI).toFixed(0)}°`);
    }

    _heldUpdate(dt, hand) {
        const knobWorld = this.knob.getAbsolutePosition();
        const handPos = this.ctx.hands.hands[hand].worldPosition;
        if (BABYLON.Vector3.Distance(handPos, knobWorld) > DOOR_TUNING.breakDist) {
            this.ctx.interaction.release(hand);
            return;
        }

        // Lever twist (valve-style): grab-relative, hard stops at ±handleMax.
        const twist = this._handTwist(hand);
        const dTwist = wrapPi(twist - this._lastTwist);
        this._lastTwist = twist;
        const prevHandle = this.handleAngle;
        this.handleAngle = Math.min(DOOR_TUNING.handleMax,
            Math.max(-DOOR_TUNING.handleMax, this.handleAngle + dTwist));
        if (this.handleAngle !== prevHandle) {
            this._applyHandle();
            this._detentAccum += Math.abs(this.handleAngle - prevHandle);
            const step = DOOR_TUNING.tickDeg * Math.PI / 180;
            if (this._detentAccum >= step) {
                this._detentAccum = 0;
                this.ctx.feedback.detent(hand, DOOR_TUNING.tickAmp, "doorHandle", 0.02);
            }
        }

        // Swing: hand yaw arc around the hinge drives the panel while the
        // bolt is free. Babylon LH: a +Y rotation lowers a vector's
        // atan2(z,x) yaw, so the panel follows the hand with rotY -= dYaw.
        const yaw = this._handYaw(hand);
        const dYaw = wrapPi(yaw - this._lastHandYaw);
        this._lastHandYaw = yaw;
        this._updateLatch();
        const prev = this.doorAngle;
        if (!this.latched && dYaw !== 0) {
            this.doorAngle = Math.min(DOOR_TUNING.maxSwing,
                Math.max(-DOOR_TUNING.maxSwing, this.doorAngle - dYaw));
            this.root.rotation.y = this._closedYaw + this.doorAngle;
        }
        // Track imparted velocity every held frame (zero deltas decay the
        // estimate) so a flung door keeps swinging on release.
        this._impartSwing(this.doorAngle - prev, dt);
    }
}
