// Buttons (hand-interactions.md §Buttons).
//
// HoverButton — chunky plunger pressed by hand (palm) proximity along its
// local +Y move vector (default travel 0.1). Engages at 95% depth, releases
// below 90% (hysteresis). Events: onDown / onUp / onHeld (every frame while
// engaged). Not an Interactable — pure proximity, no grab.
//
// FingertipButton — small button pressed by the tracked index fingertip.
// Hover within 0.10 (highlight + optional finger-point pose snap), touch
// within 0.03, physical travel 0.02 with cubic visual easing. Haptics: 4
// detent steps across the travel (amplitude ~0.4×depth fraction),
// press-down 50 ms @ 0.6, press-up 40 ms @ 0.36.

const HOVER_BTN = {
    travel: 0.1,
    engageFrac: 0.95,
    releaseFrac: 0.90,
    handRadius: 0.05, // palm probe sphere
};

const TIP_BTN = {
    hoverDist: 0.10,
    touchDist: 0.03,
    travel: 0.02,
    detents: 4,
    downAmp: 0.6, downDur: 0.05,
    upAmp: 0.36, upDur: 0.04,
};

// TRACKED-side fingertip (spec: "tracked index-tip press"). The visual
// hand rides the physics palm, which BLOCKS on static geometry
// (handphysics full-hand collider) — a finger pressing a mounted button
// stops at the surface, so the visual tip can never close the last 8 mm
// onto the cap. Buttons must probe where the tracked finger IS (allowed to
// penetrate): remap the visual tip from the palm body's actual frame into
// the palm's target (grip) frame. Falls back to the visual tip before the
// physics hand adopts the mesh.
// PORT: in Unity probe the tracked hand-joint/controller pose directly;
// never the physics-articulated hand.
function trackedFingertip(ctx, hand) {
    const ctl = ctx.hands.hands[hand];
    const tip = ctl.fingertipPoint;
    const palm = ctx.physicsHands?.hands[hand];
    if (!tip || !palm?._visualAdopted) return tip;
    const local = BABYLON.Vector3.TransformCoordinates(
        tip, BABYLON.Matrix.Invert(palm.palmNode.getWorldMatrix()));
    const target = BABYLON.Matrix.Compose(BABYLON.Vector3.One(),
        ctl.worldRotation, ctl.worldPosition);
    return BABYLON.Vector3.TransformCoordinates(local, target);
}

// Depth a probe sphere pushes a face down along the button's world axis.
// `top` = rest position of the touch surface, `axis` = outward unit vector.
function pressDepth(point, radius, top, axis, lateralRadius, travel) {
    const rel = point.subtract(top);
    const axial = BABYLON.Vector3.Dot(rel, axis);
    const lateral = rel.subtract(axis.scale(axial)).length();
    if (lateral > lateralRadius) return 0;
    return Math.min(travel, Math.max(0, radius - axial));
}

export class HoverButton {
    constructor(ctx, {
        position, rotation = null, name = "hoverButton",
        travel = HOVER_BTN.travel, plungerRadius = 0.06,
        onDown = null, onUp = null, onHeld = null,
    } = {}) {
        this.ctx = ctx;
        this.travel = travel;
        this.plungerRadius = plungerRadius;
        this.onDown = onDown; this.onUp = onUp; this.onHeld = onHeld;
        this.depth = 0;
        this.engaged = false;

        const scene = ctx.scene;
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);
        if (rotation) this.root.rotationQuaternion = rotation.clone();

        const baseMat = new BABYLON.StandardMaterial(`${name}-baseMat`, scene);
        baseMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.22);
        const base = BABYLON.MeshBuilder.CreateCylinder(`${name}-base`,
            { diameter: plungerRadius * 2.6, height: 0.03 }, scene);
        base.position.y = 0.015;
        base.parent = this.root;
        base.material = baseMat;

        this._plungerMat = new BABYLON.StandardMaterial(`${name}-plungerMat`, scene);
        this._plungerMat.diffuseColor = new BABYLON.Color3(0.8, 0.25, 0.2);
        this.plunger = BABYLON.MeshBuilder.CreateCylinder(`${name}-plunger`,
            { diameter: plungerRadius * 2, height: travel }, scene);
        this.plunger.parent = this.root;
        this.plunger.material = this._plungerMat;
        this._setPlunger(0);

        ctx.updatables.push((dt) => this.update(dt));
    }

    // Rest: plunger spans y [0.03, 0.03+travel]; pressing sinks it.
    _setPlunger(depth) {
        this.plunger.position.y = 0.03 + this.travel / 2 - depth / 2;
        this.plunger.scaling.y = Math.max(0.05, (this.travel - depth) / this.travel);
    }

    // World position of the touch surface at rest + outward axis.
    _frame() {
        const m = this.root.getWorldMatrix();
        const top = BABYLON.Vector3.TransformCoordinates(
            new BABYLON.Vector3(0, 0.03 + this.travel, 0), m);
        const axis = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Up(), m).normalize();
        return { top, axis };
    }

    update(dt) {
        const { top, axis } = this._frame();
        let depth = 0, pressingHand = null;
        for (const hand of ["left", "right"]) {
            const h = this.ctx.hands.hands[hand];
            if (!h.tracking) continue;
            const d = pressDepth(h.worldPosition, HOVER_BTN.handRadius, top, axis,
                this.plungerRadius + HOVER_BTN.handRadius * 0.6, this.travel);
            if (d > depth) { depth = d; pressingHand = hand; }
        }

        // Detent ticks while the plunger moves (house rule).
        if (pressingHand && Math.abs(depth - this.depth) > 0.004) {
            this.ctx.feedback.detent(pressingHand, 0.2 + 0.3 * (depth / this.travel),
                `hoverbtn`, 0.04);
        }
        this.depth = depth;
        this._setPlunger(depth);

        const frac = depth / this.travel;
        if (!this.engaged && frac >= HOVER_BTN.engageFrac) {
            this.engaged = true;
            this._plungerMat.emissiveColor = new BABYLON.Color3(0.5, 0.15, 0.1);
            if (pressingHand) this.ctx.feedback.haptic(pressingHand, 0.8, 0.04);
            this.ctx.feedback.sound("click", { pitch: 0.7, volume: 0.6 });
            this.onDown?.(pressingHand);
        } else if (this.engaged && frac < HOVER_BTN.releaseFrac) {
            this.engaged = false;
            this._plungerMat.emissiveColor = BABYLON.Color3.Black();
            if (pressingHand) this.ctx.feedback.haptic(pressingHand, 0.4, 0.02);
            this.ctx.feedback.sound("click", { pitch: 1.1, volume: 0.4 });
            this.onUp?.(pressingHand);
        }
        if (this.engaged) this.onHeld?.(pressingHand);
    }
}

export class FingertipButton {
    constructor(ctx, {
        position, rotation = null, name = "tipButton",
        radius = 0.02, onDown = null, onUp = null, onHeld = null,
        fingerPose = "Point",
    } = {}) {
        this.ctx = ctx;
        this.radius = radius;
        this.onDown = onDown; this.onUp = onUp; this.onHeld = onHeld;
        this.fingerPose = fingerPose;
        this.depth = 0;
        this.hovering = false;
        this.pressed = false;
        this._lastDetent = -1;

        const scene = ctx.scene;
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);
        if (rotation) this.root.rotationQuaternion = rotation.clone();

        const plateMat = new BABYLON.StandardMaterial(`${name}-plateMat`, scene);
        plateMat.diffuseColor = new BABYLON.Color3(0.15, 0.15, 0.18);
        const plate = BABYLON.MeshBuilder.CreateCylinder(`${name}-plate`,
            { diameter: radius * 3.2, height: 0.006 }, scene);
        plate.position.y = 0.003;
        plate.parent = this.root;
        plate.material = plateMat;

        this._capMat = new BABYLON.StandardMaterial(`${name}-capMat`, scene);
        this._capMat.diffuseColor = new BABYLON.Color3(0.2, 0.65, 0.3);
        this.cap = BABYLON.MeshBuilder.CreateCylinder(`${name}-cap`,
            { diameter: radius * 2, height: TIP_BTN.travel }, scene);
        this.cap.parent = this.root;
        this.cap.material = this._capMat;
        this._setCap(0);

        ctx.updatables.push((dt) => this.update(dt));
    }

    _setCap(depth) {
        // Cubic visual easing on the physical depth.
        const t = depth / TIP_BTN.travel;
        const eased = 1 - Math.pow(1 - t, 3);
        const d = eased * TIP_BTN.travel;
        this.cap.position.y = 0.006 + TIP_BTN.travel / 2 - d / 2;
        this.cap.scaling.y = Math.max(0.15, (TIP_BTN.travel - d) / TIP_BTN.travel);
    }

    _frame() {
        const m = this.root.getWorldMatrix();
        const top = BABYLON.Vector3.TransformCoordinates(
            new BABYLON.Vector3(0, 0.006 + TIP_BTN.travel, 0), m);
        const axis = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Up(), m).normalize();
        return { top, axis };
    }

    update(dt) {
        const { top, axis } = this._frame();
        let depth = 0, hand = null, nearest = Infinity;
        for (const h of ["left", "right"]) {
            const ctl = this.ctx.hands.hands[h];
            if (!ctl.tracking) continue;
            const tip = trackedFingertip(this.ctx, h);
            if (!tip) continue;
            const dist = BABYLON.Vector3.Distance(tip, top);
            if (dist < nearest) { nearest = dist; hand = h; }
            const d = pressDepth(tip, 0.008, top, axis, this.radius * 1.6, TIP_BTN.travel);
            if (d > depth) depth = d;
        }

        // Hover highlight + optional skeletal finger-point snap, blended by
        // approach (1 at touch distance, 0 at hover distance).
        this.hovering = nearest < TIP_BTN.hoverDist;
        const approach = 1 - Math.min(1, Math.max(0,
            (nearest - TIP_BTN.touchDist) / (TIP_BTN.hoverDist - TIP_BTN.touchDist)));
        this._capMat.emissiveColor = new BABYLON.Color3(0.06, 0.25, 0.1).scale(approach);
        if (hand && this.fingerPose) {
            this.ctx.hands.hands[hand].setAuthoredPoseTarget(this.fingerPose, approach);
        }

        // 4 haptic detent steps across the travel, amplitude ~0.4×depth.
        const step = Math.floor((depth / TIP_BTN.travel) * TIP_BTN.detents);
        if (hand && step !== this._lastDetent && depth > 0) {
            this.ctx.feedback.haptic(hand, 0.4 * (depth / TIP_BTN.travel) + 0.05, 0.008);
            this.ctx.feedback.sound("tick", { pitch: 1.2 + 0.2 * step, volume: 0.15 });
        }
        this._lastDetent = depth > 0 ? step : -1;

        this.depth = depth;
        this._setCap(depth);

        const frac = depth / TIP_BTN.travel;
        if (!this.pressed && frac >= 0.95) {
            this.pressed = true;
            if (hand) this.ctx.feedback.haptic(hand, TIP_BTN.downAmp, TIP_BTN.downDur);
            this.ctx.feedback.sound("click", { pitch: 1.4, volume: 0.5 });
            this.onDown?.(hand);
        } else if (this.pressed && frac < 0.5) {
            this.pressed = false;
            if (hand) this.ctx.feedback.haptic(hand, TIP_BTN.upAmp, TIP_BTN.upDur);
            this.ctx.feedback.sound("click", { pitch: 1.7, volume: 0.3 });
            this.onUp?.(hand);
        }
        if (this.pressed) this.onHeld?.(hand);
    }
}
