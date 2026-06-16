// Arrow system: spawn pool, magnetic nock state machine, draw tracking
// (Phase 5); fire + flight with manual swept-cast CCD, deflection and
// stick-in-target (Phase 6). Web Havok has no CCD at any layer, so each
// frame the head is swept along its motion with plugin.shapeCast and the
// CAST hit — not engine contacts — drives all impact logic at exact
// time-of-impact. Verified: the cast SHAPE's filter masks are honored by
// the Havok query (membership ARROW / collide DEFAULT|GRABBABLE skips the
// palm bodies), so no FilterInfo on ShapeCastInput is needed.
//
// Flight is integrated by US, not Havok: a flying arrow is a KINEMATIC body
// whose pose we write each frame, and _updateFlight advances it in capped
// MAX_FLIGHT_STEP sub-steps (manual gravity + position) with a swept cast per
// sub-step. A DYNAMIC body can only be integrated once per render frame, so on
// a frame hitch a 30 m/s arrow leaps >1 m in a single step and the stick then
// re-seats it along a stale heading — a visible sideways teleport at impact.
// Sub-stepping keeps every step short, so the planted arrow always lands on
// the path it actually flew. (Measured: hitch-frame impact veer 17 cm -> <1 cm.)
//
// Arrow local frame: origin at the nock end, +Z toward the tip — matches
// the bow frame (+Z = flight), so a nocked arrow seats with identity
// rotation under bow.nock.
//
// A held arrow is UNPARENTED; every frame its world pose is written from
// the draw hand's nockOrigin, blended toward the bow's seat pose by the
// approach factor (spec §3). Nocking parents it to bow.nock so it tracks
// the aim pivot with zero lag.

import { LAYERS } from "./physics.js";
import { HandPin } from "./handpin.js";

const ARROW_LEN = 0.7;            // m, nock to tip
const MAX_LIVE = 10;              // live arrows; oldest free arrow recycled
const SPAWN_COOLDOWN = 0.5;       // s between spawns
const APPROACH_DIST = 0.15;       // m — magnetic lerp begins
const READY_DIST = 0.10;          // m — eligible to nock, "ready" cue
const LERP_DONE_DIST = 0.08;      // m — one-shot haptic (500 µs)
const NOCK_BUTTON = "trigger";    // the nock/draw button on the draw hand
const NOCK_PRESS = 0.5;           // commit threshold
const NOCK_RELEASE = 0.3;         // release threshold (hysteresis)
const MAX_DRAW = 0.5;             // m
const MIN_DRAW = 0.05;            // m — minimum meaningful draw
const DRAW_TICK_STEP = 0.01;      // m of pull per haptic detent
const CREAK_EVERY = 10;           // 1 in N detents is a bigger pulse + a creak
                                  // (~5 creaks across a full draw; pace tracks
                                  // draw speed since detents are per-distance)
const TICK_AMP_BASE = 0.05, TICK_AMP_SCALE = 0.10;  // small detent buzz
const CREAK_AMP_BASE = 0.30, CREAK_AMP_SCALE = 0.40; // bigger creak buzz
const STRAIN_MIN = 0.1;           // s, full-draw strain tick interval
const STRAIN_MAX = 0.5;
const HOLD_POSE = "Hold";         // authored clip blended by approach

// Pick the arrow-impact clip from the struck surface's soundMaterial tag
// (set on meshes in main.js / scene.js). Falls back to wood for untagged hits.
function arrowHitName(node) {
    const mat = node?.metadata?.soundMaterial ?? node?.parent?.metadata?.soundMaterial;
    switch (mat) {
        case "metal": return "arrow_hit_metal";
        case "rock": return "arrow_hit_rock";
        case "soil": case "sand": return "arrow_hit_ground";
        case "wood": return "arrow_hit_wood";
        default: return "arrow_hit_wood";
    }
}

// --- fire + flight (Phase 6, spec §5–7) -----------------------------------
const SPEED_MIN = 3;              // m/s at minimum draw
const SPEED_MAX = 30;             // m/s at full draw
const SPIN_RATE = 10;             // rad/s shaft roll in flight
const HEAD_RADIUS = 0.01;         // m — cast sphere (spec: 1 cm)
const PRE_FIRE_GUARD = 0.8;       // m sphere-cast ahead at release
const GRACE_TIME = 0.04;          // s — "first 2 frames" at the spec's 50 Hz
const DEFLECT_SCALE = 0.25;       // velocity kept on deflection
const MIN_TARGET_SPEED2 = 0.2;    // speed² floor for a valid target hit
const SPENT_SPEED = 1.5;          // m/s — below this after a bounce, give up CCD
const SPENT_TTL = 8;              // s — spent ground arrows clean themselves up
const MAX_FLIGHT_STEP = 1 / 120;  // s — cap per flight sub-step. A frame can be
                                  // long (XR hitch); integrating flight in chunks
                                  // no longer than this keeps the swept cast and
                                  // the stick on the arrow's real path (a single
                                  // full-frame step would re-seat it off-path).

// --- particle tuning (live-editable in-VR via the control boards) ----------
// These blocks are read on every spawn, so a slider write takes effect on the
// next arrow fired (streak) or next impact (puff). Each field carries its
// sensible [min..max] range as the control-board slider bounds. Colours stay
// fixed; the boards expose the shape/feel knobs that actually need tuning.
//
// Smoke trail left behind a flying arrow (additive tracer). PORT: a Unity
// particle trail maps emitRate->Emission.rateOverTime, lifetime->Start
// Lifetime, size->Start Size, spread->shape-velocity, riseY->Gravity Modifier.
export const STREAK_TUNING = {
    emitRate: 500,    // particles/s        [50 .. 1500]  density of the trail
    lifetime: 0.23,   // s                  [0.2 .. 3.0]  how long the tail lingers
    minSize: 0.01,    // m                  [0.004 .. 0.06]
    maxSize: 0.03,    // m                  [0.01 .. 0.12]
    opacity: 0.10,    // base alpha 0..1    [0 .. 1]      overall visibility
    spread: 0.1,      // m/s emit power     [0 .. 0.6]    billow/turbulence
    riseY: 0.25,      // m/s^2 gravity Y    [-1.5 .. 1.5] rise (+) or sink (-)
};

// Smoke puff at an arrow impact point (single burst).
export const PUFF_TUNING = {
    count: 15,        // particles in burst [5 .. 150]    thickness of the cloud
    minLifetime: 0.2, // s                  [0.1 .. 1.5]
    maxLifetime: 0.7, // s                  [0.2 .. 2.5]
    minSize: 0.03,    // m                  [0.004 .. 0.06]
    maxSize: 0.1,     // m                  [0.01 .. 0.12]
    spread: 0.3,      // m/s emit power     [0 .. 0.4]    cloud radius / puffiness
    riseY: 0.2,       // m/s^2 gravity Y    [-1.5 .. 1.5] drift up (+) or down (-)
    opacity: 0.7,     // base alpha 0..1    [0 .. 1]
};

class Arrow {
    constructor(ctx, name, mats) {
        const scene = ctx.scene;
        this.ctx = ctx;
        this.root = new BABYLON.TransformNode(name, scene);
        this.root.rotationQuaternion = new BABYLON.Quaternion();

        const { shaftMat, headMat, vaneMat } = mats;

        const shaft = BABYLON.MeshBuilder.CreateCylinder(`${name}-shaft`,
            { height: ARROW_LEN, diameter: 0.009, tessellation: 8 }, scene);
        shaft.rotation.x = Math.PI / 2; // cylinder +Y -> arrow +Z
        shaft.position.z = ARROW_LEN / 2;
        shaft.parent = this.root;
        shaft.material = shaftMat;

        const head = BABYLON.MeshBuilder.CreateCylinder(`${name}-head`,
            { height: 0.05, diameterTop: 0, diameterBottom: 0.018, tessellation: 8 }, scene);
        head.rotation.x = Math.PI / 2;
        head.position.z = ARROW_LEN + 0.025;
        head.parent = this.root;
        head.material = headMat;
        this.head = head;
        this.shaft = shaft; // streak emitter rides mid-shaft

        // Three vanes, 120° apart around the shaft near the nock.
        for (let i = 0; i < 3; i++) {
            const holder = new BABYLON.TransformNode(`${name}-vane${i}`, scene);
            holder.parent = this.root;
            holder.rotation.z = i * 2 * Math.PI / 3;
            const vane = BABYLON.MeshBuilder.CreateBox(`${name}-vane${i}-m`,
                { width: 0.002, height: 0.035, depth: 0.08 }, scene);
            vane.parent = holder;
            vane.position.set(0, 0.02, 0.09);
            vane.material = vaneMat;
        }

        this.state = "held"; // held | nocked | flying | spent | stuck
        this.body = null;
        this.vel = null;     // flight velocity (we integrate it; see makeFlightBody)
        this.flightTime = 0;
        this.roll = 0;
        this.streak = null;  // flight particle trail
    }

    // KINEMATIC body for flight: WE integrate the arrow's motion (this.vel +
    // gravity) in sub-steps and write the node pose each frame;
    // disablePreStep=false pushes that pose into the body pre-step. Kinematic
    // (not dynamic) so Havok doesn't also integrate it — we need full control
    // of the step size to sub-step a long/hitched frame (see _updateFlight and
    // the file header). The capsule keeps its filter masks so the swept cast
    // can ignore it. PORT: a kinematic Rigidbody moved by code + Physics.SphereCast.
    makeFlightBody(velocity) {
        const scene = this.ctx.scene;
        this.vel = velocity.clone();
        this.body = new BABYLON.PhysicsBody(
            this.root, BABYLON.PhysicsMotionType.KINEMATIC, false, scene);
        this._shape = new BABYLON.PhysicsShapeCapsule(
            new BABYLON.Vector3(0, 0, 0.02),
            new BABYLON.Vector3(0, 0, ARROW_LEN - 0.02), 0.006, scene);
        this._shape.filterMembershipMask = LAYERS.ARROW;
        this._shape.filterCollideMask = LAYERS.DEFAULT | LAYERS.GRABBABLE;
        this.body.shape = this._shape;
        this.body.disablePreStep = false;
    }

    disposeBody() {
        this.body?.dispose();
        this._shape?.dispose();
        this.body = null;
        this._shape = null;
    }

    dispose() {
        this.disposeBody();
        this.root.dispose(); // shared materials stay alive
    }
}

export class ArrowSystem {
    constructor(ctx) {
        this.ctx = ctx;
        this.live = [];          // all live arrows (held + flying + stuck)
        this.held = null;        // arrow on the draw hand
        this.nocked = false;
        this.pull = 0;           // current draw distance, m
        this._cooldown = 0;
        this._spawnCount = 0;
        this._readyCued = false;
        this._lerpCued = false;
        this._lastTickPull = 0;
        this._tickCount = 0;     // detents since draw start (every Nth creaks)
        this._strainTimer = 0;
        this._drawHand = null;   // cached: bow.drawHand is nulled before onReleased

        // Fire hook — overridable, defaults to the Phase 6 fire path. An
        // under-pull release (or a cleared hook) cancels back to the hand.
        this.onFire = (arrow, info) => this._fire(arrow, info);
        // Scoring hook (Phase 7): (targetNode, {arrow, point, speed}) => {}
        this.onTargetHit = null;

        ctx.bow.onReleased = () => this._onBowReleased();

        const mkMat = (name, r, g, b) => {
            const m = new BABYLON.StandardMaterial(name, ctx.scene);
            m.diffuseColor = new BABYLON.Color3(r, g, b);
            return m;
        };
        this._mats = {
            shaftMat: mkMat("arrowShaftMat", 0.75, 0.6, 0.4),
            headMat: mkMat("arrowHeadMat", 0.3, 0.3, 0.32),
            vaneMat: mkMat("arrowVaneMat", 0.85, 0.2, 0.2),
        };
        this._mats.vaneMat.backFaceCulling = false;

        // Swept-cast plumbing: a 1 cm sphere whose own filter masks do the
        // filtering (Havok honors them; ShapeCastInput has no FilterInfo).
        this._castShape = new BABYLON.PhysicsShapeSphere(
            BABYLON.Vector3.Zero(), HEAD_RADIUS, ctx.scene);
        this._castShape.filterMembershipMask = LAYERS.ARROW;
        this._castShape.filterCollideMask = LAYERS.DEFAULT | LAYERS.GRABBABLE;
        this._castInput = new BABYLON.ShapeCastResult();
        this._castHit = new BABYLON.ShapeCastResult();

        this._particleTex = this._makeParticleTex();
    }

    // --- particle effects ------------------------------------------------

    // Soft radial blob so the particle systems need no texture asset.
    _makeParticleTex() {
        const dt = new BABYLON.DynamicTexture("arrowParticleTex",
            { width: 64, height: 64 }, this.ctx.scene, false);
        const c = dt.getContext();
        const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.5, "rgba(255,255,255,0.35)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = g;
        c.fillRect(0, 0, 64, 64);
        dt.update();
        dt.hasAlpha = true;
        return dt;
    }

    // Subtle additive streak left behind a flying arrow. World-space
    // particles with no velocity of their own — the moving emitter lays
    // them out along the flight path.
    _startStreak(arrow) {
        const t = STREAK_TUNING;
        const ps = new BABYLON.ParticleSystem(`${arrow.root.name}-streak`, 1200, this.ctx.scene);
        ps.particleTexture = this._particleTex;
        ps.emitter = arrow.shaft;
        ps.minEmitBox = BABYLON.Vector3.Zero();
        ps.maxEmitBox = BABYLON.Vector3.Zero();
        // Fixed pale-blue palette; opacity slider scales the alphas together
        // (color2 keeps the original 0.6 ratio to color1).
        ps.color1 = new BABYLON.Color4(0.8, 0.85, 1.0, t.opacity);
        ps.color2 = new BABYLON.Color4(0.6, 0.7, 0.9, t.opacity * 0.6);
        ps.colorDead = new BABYLON.Color4(0.5, 0.6, 0.8, 0);
        ps.minSize = t.minSize;
        ps.maxSize = t.maxSize;
        ps.minLifeTime = t.lifetime;
        ps.maxLifeTime = t.lifetime;
        ps.emitRate = t.emitRate;
        ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
        // Radial directions so the spread slider can billow the trail; at
        // spread 0 the emit power is 0 and particles stay where laid down.
        ps.direction1 = new BABYLON.Vector3(-1, -1, -1);
        ps.direction2 = new BABYLON.Vector3(1, 1, 1);
        ps.minEmitPower = 0;
        ps.maxEmitPower = t.spread;
        ps.gravity = new BABYLON.Vector3(0, t.riseY, 0);
        ps.start();
        arrow.streak = ps;
    }

    _stopStreak(arrow) {
        const ps = arrow.streak;
        if (!ps) return;
        arrow.streak = null;
        // Pin the emitter to a point so a later arrow despawn can't leave
        // the system reading a disposed mesh.
        ps.emitter = arrow.shaft.getAbsolutePosition().clone();
        ps.stop();
        // dispose(false): the default disposes the SHARED particle texture
        // and silently kills every later arrow's effects.
        setTimeout(() => ps.dispose(false), STREAK_TUNING.lifetime * 1000 + 500);
    }

    // Little smoke puff at an impact point.
    _puff(point) {
        const t = PUFF_TUNING;
        const ps = new BABYLON.ParticleSystem("arrowPuff", 150, this.ctx.scene);
        ps.particleTexture = this._particleTex;
        ps.emitter = point.clone();
        // Fixed grey palette; opacity slider scales the alphas together
        // (color2 keeps the original 0.75 ratio to color1).
        ps.color1 = new BABYLON.Color4(0.65, 0.65, 0.65, t.opacity);
        ps.color2 = new BABYLON.Color4(0.5, 0.5, 0.5, t.opacity * 0.75);
        ps.colorDead = new BABYLON.Color4(0.4, 0.4, 0.4, 0);
        // Dense puff: born within ~1 cm of the impact point. Spread = emit
        // velocity (direction × power) over lifetime, so the cloud radius is
        // ~spread × lifetime; small sprites keep it reading as one tight
        // cloud rather than a few big blobs.
        ps.minSize = t.minSize;
        ps.maxSize = t.maxSize;
        ps.minLifeTime = t.minLifetime;
        ps.maxLifeTime = t.maxLifetime;
        ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
        ps.minEmitBox = new BABYLON.Vector3(-0.01, -0.01, -0.01); // born within 1 cm
        ps.maxEmitBox = new BABYLON.Vector3(0.01, 0.01, 0.01);
        ps.direction1 = new BABYLON.Vector3(-1, -1, -1); // even radial puff
        ps.direction2 = new BABYLON.Vector3(1, 1, 1);
        ps.minEmitPower = 0;
        ps.maxEmitPower = t.spread;
        ps.gravity = new BABYLON.Vector3(0, t.riseY, 0);
        ps.emitRate = 0;
        ps.manualEmitCount = Math.round(t.count);
        ps.start();
        setTimeout(() => ps.dispose(false), 2500); // false: texture is shared
    }

    // Closest swept-sphere hit from->to, or null. ignoreBody excludes the
    // arrow's own capsule.
    _cast(from, to, ignoreBody) {
        this._castInput.reset();
        this._castHit.reset();
        const query = {
            shape: this._castShape,
            rotation: BABYLON.Quaternion.Identity(),
            startPosition: from,
            endPosition: to,
            shouldHitTriggers: false,
        };
        if (ignoreBody) query.ignoreBody = ignoreBody;
        this.ctx.physics.plugin.shapeCast(query, this._castInput, this._castHit);
        return this._castHit.hasHit ? this._castHit : null;
    }

    // --- spawn / despawn -------------------------------------------------

    _spawn() {
        if (this.live.length >= MAX_LIVE) {
            const oldest = this.live.find(a => a !== this.held);
            if (!oldest) return;
            this._despawn(oldest);
        }
        const arrow = new Arrow(this.ctx, `arrow${this._spawnCount++}`, this._mats);
        this.live.push(arrow);
        this.held = arrow;
        this._cooldown = SPAWN_COOLDOWN;
        this._readyCued = false;
        this._lerpCued = false;
    }

    _despawn(arrow) {
        const i = this.live.indexOf(arrow);
        if (i >= 0) this.live.splice(i, 1);
        if (this.held === arrow) this.held = null;
        this._stopStreak(arrow);
        arrow.dispose();
    }

    _onBowReleased() {
        if (this.nocked) this._cancelNock();
        if (this.held) this._despawn(this.held);
        if (this._drawHand) {
            this.ctx.hands.hands[this._drawHand].setAuthoredPoseTarget(HOLD_POSE, 0);
        }
        this._drawHand = null;
        this._cooldown = SPAWN_COOLDOWN;
    }

    // --- nock state machine ------------------------------------------------

    _nock(hand) {
        const bow = this.ctx.bow;
        this.nocked = true;
        this.held.state = "nocked";
        this.held.root.parent = bow.nock;
        this.held.root.position.setAll(0);
        this.held.root.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
        this.pull = 0;
        this._lastTickPull = 0;
        this._tickCount = 0;
        this._strainTimer = 0;
        bow.aimActive = true;
        this.ctx.interaction.lockHover(bow.drawHand);
        // Pin the visual draw hand to the nock: it rides the string along
        // its one sliding axis (bow −Z, driven by projecting the ghost in
        // _updateDraw); pinch orientation locked to the bow frame.
        this._nockPinHand = bow.drawHand;
        this._nockPin = new HandPin(this.ctx, bow.drawHand, bow.nock, {});
        this.ctx.handPins[bow.drawHand] = this._nockPin;
        hand.setAuthoredPoseTarget(HOLD_POSE, 1);
        this.ctx.feedback.sound("nock", { at: this.ctx.bow.nock });
        this.ctx.feedback.haptic(bow.drawHand, 0.5, 0.02);
    }

    _cancelNock() {
        const bow = this.ctx.bow;
        this.nocked = false;
        if (this.held) {
            this.held.state = "held";
            // parent=null does NOT preserve world transform — reseat at the
            // nock's world pose so there's no one-frame jump to the origin.
            const pos = bow.nock.getAbsolutePosition();
            const rot = bow.seatRotation;
            this.held.root.parent = null;
            this.held.root.position.copyFrom(pos);
            this.held.root.rotationQuaternion.copyFrom(rot);
        }
        this.pull = 0;
        bow.aimActive = false;
        bow.setTension(0);
        bow.nock.position.z = bow.restZ;
        if (this._nockPin) {
            if (this.ctx.handPins[this._nockPinHand] === this._nockPin) {
                this.ctx.handPins[this._nockPinHand] = null;
            }
            this._nockPin = null;
        }
        if (this._drawHand) this.ctx.interaction.unlockHover(this._drawHand);
        this._readyCued = true; // no instant re-cue while still in range
    }

    _release(hand) {
        const pull = this.pull;
        const bow = this.ctx.bow;
        if (pull >= MIN_DRAW && this.onFire) {
            const arrow = this.held;
            const direction = bow.flightDirection;
            this._cancelNock();
            this.held = null; // arrow leaves the hand
            this._cooldown = SPAWN_COOLDOWN;
            hand.setAuthoredPoseTarget(HOLD_POSE, 0);
            this.onFire(arrow, { pull, direction });
        } else {
            // Under-pull (or Phase 5, no fire handler): back to the hand.
            this._cancelNock();
            this.ctx.feedback.sound("release", { volume: 0.25, at: this.held?.root });
        }
    }

    // --- fire + flight (spec §5–7) -------------------------------------------

    _fire(arrow, { pull, direction }) {
        const fb = this.ctx.feedback;
        const dir = direction.clone().normalize();
        const t = Math.min(1, Math.max(0, (pull - MIN_DRAW) / (MAX_DRAW - MIN_DRAW)));
        const speed = SPEED_MIN + t * (SPEED_MAX - SPEED_MIN);

        // Point-blank guard: 1 cm sphere-cast 0.8 m ahead of the tip; if
        // anything blocks it, destroy the arrow instead of firing.
        const tip = arrow.root.position.add(dir.scale(ARROW_LEN));
        if (this._cast(tip, tip.add(dir.scale(PRE_FIRE_GUARD)), null)) {
            this._despawn(arrow);
            fb.sound("impact", { volume: 0.4, pitch: 0.7, at: arrow.root });
            return;
        }

        arrow.state = "flying";
        arrow.flightTime = 0;
        arrow.roll = 0;
        arrow.prevTip = tip.clone();
        arrow.makeFlightBody(dir.scale(speed)); // sets arrow.vel; we integrate it
        this._startStreak(arrow);

        fb.sound("drawrelease", { volume: 0.85, at: this.ctx.bow.aimPivot });
        fb.sound("whoosh", { volume: 0.5, pitch: 0.8 + 0.6 * t, at: tip });
        // Release cascade: bow hand 1500/800/500/300 µs at 50 ms; decaying
        // ramp on the draw hand.
        const bowHand = this.ctx.bow.bowHand;
        const drawHand = this._drawHand;
        [1500, 800, 500, 300].forEach((us, i) =>
            setTimeout(() => bowHand && fb.hapticUs(bowHand, us), i * 50));
        [800, 400, 200].forEach((us, i) =>
            setTimeout(() => drawHand && fb.hapticUs(drawHand, us), i * 50));
    }

    // World +Z of a rotation (the shaft axis for our arrows).
    _forwardOf(rot) {
        return new BABYLON.Vector3(0, 0, 1).applyRotationQuaternion(rot);
    }

    // Rotation mapping local +Z onto dir. Built from axes — NOT
    // FromLookDirectionLH, which returns a view-style rotation with +Z
    // facing AWAY from dir (cost a long debug: arrows flew tail-first and
    // the CCD window swept 0.7 m behind the real tip).
    _lookAlong(dir, roll) {
        const upHint = Math.abs(dir.y) < 0.99 ? BABYLON.Vector3.Up() : BABYLON.Vector3.Right();
        const right = BABYLON.Vector3.Cross(upHint, dir).normalize();
        const up = BABYLON.Vector3.Cross(dir, right);
        const look = BABYLON.Quaternion.RotationQuaternionFromAxis(right, up, dir);
        return roll ? look.multiply(BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Forward(), roll))
            : look;
    }

    _updateFlight(dt, arrow) {
        const g = (this._gravity ??= this.ctx.scene.getPhysicsEngine().gravity);
        // Integrate flight in capped sub-steps so a long/hitched frame can't
        // make the arrow leap far in one go (see makeFlightBody). The swept
        // cast runs per sub-step, so impact placement always sits on the path
        // the arrow actually flew — no teleport at the moment of impact.
        let rem = dt;
        while (rem > 1e-6 && arrow.state === "flying") {
            const h = Math.min(MAX_FLIGHT_STEP, rem);
            rem -= h;

            arrow.vel.addInPlace(g.scale(h)); // gravity (set velocity, never force)
            const speed = arrow.vel.length();
            if (speed < 1e-3) return;
            const dir = arrow.vel.scale(1 / speed);

            const pos = arrow.root.position; // unparented: local == world
            const newPos = pos.add(arrow.vel.scale(h));
            if (newPos.y < -2 || Math.abs(newPos.z) > 40 || Math.abs(newPos.x) > 20) {
                this._despawn(arrow); // left play
                return;
            }

            // Sweep the head over the segment it traverses this sub-step
            // (prevTip -> new tip) plus a small forward margin. Cast hits —
            // not engine contacts — drive all impact logic, at time-of-impact.
            const newTip = newPos.add(dir.scale(ARROW_LEN));
            const from = arrow.prevTip ?? pos.add(dir.scale(ARROW_LEN));
            const margin = Math.max(speed * h * 0.5, 0.03);
            const hit = this._cast(from, newTip.add(dir.scale(margin)), arrow.body);

            if (!hit) {
                arrow.root.position.copyFrom(newPos);
                arrow.flightTime += h;
                arrow.roll += SPIN_RATE * h;
                // Orient the shaft along velocity (+ shaft roll); pre-step sync
                // pushes it into the kinematic body.
                arrow.root.rotationQuaternion.copyFrom(this._lookAlong(dir, arrow.roll));
                arrow.prevTip = newPos.add(this._forwardOf(arrow.root.rotationQuaternion).scale(ARROW_LEN));
                continue;
            }

            const node = hit.body?.transformNode ?? null;
            const isTarget = !!(node?.metadata?.arrowTarget || node?.parent?.metadata?.arrowTarget);
            const hp = hit.hitPoint.clone();
            const n = hit.hitNormal.clone();
            const reflect = () => arrow.vel.subtract(n.scale(2 * BABYLON.Vector3.Dot(arrow.vel, n)))
                .scaleInPlace(DEFLECT_SCALE);

            if (isTarget && speed * speed > MIN_TARGET_SPEED2) {
                this._stick(arrow, node, hp, dir, speed);
                return;
            }

            if (arrow.flightTime < GRACE_TIME) {
                // Bounce protection: reflect at 25%, restart the grace window
                // (spec §7). Per-sub-step casting means the arrow hasn't been
                // committed into the surface, so there's nothing to roll back.
                arrow.vel = reflect();
                arrow.flightTime = 0;
                arrow.prevTip = null;
                this._puff(hp);
                return;
            }

            // Real impact on a non-target: seat at TOI (tip on the surface),
            // damped bounce; once slow, freeze as a spent arrow.
            arrow.root.position.copyFrom(hp.subtract(dir.scale(ARROW_LEN * 0.98)));
            arrow.vel = reflect();
            arrow.prevTip = null;
            this.ctx.feedback.sound(arrowHitName(node), { volume: Math.min(0.8, 0.2 + speed / 40), at: arrow.root });
            this._stopStreak(arrow);
            this._puff(hp);
            if (arrow.vel.length() < SPENT_SPEED) {
                arrow.state = "spent";
                arrow.spentAt = performance.now() / 1000;
            }
            return;
        }
    }

    _stick(arrow, node, hp, dir, speed) {
        // penetration = 0.75 − (remapClamped(speed, 0→10, 0→0.1) + rand 0.05)
        // (spec §7); the tip embeds by ARROW_LEN − penetration.
        const pen = 0.75 - (Math.min(speed, 10) / 10 * 0.1 + Math.random() * 0.05);
        const embed = Math.min(0.25, Math.max(0.02, ARROW_LEN - pen));
        arrow.root.position.copyFrom(hp.subtract(dir.scale(ARROW_LEN - embed)));
        arrow.root.rotationQuaternion.copyFrom(this._lookAlong(dir, arrow.roll));
        arrow.disposeBody(); // freeze + collider off
        arrow.root.setParent(node); // preserves world transform
        arrow.state = "stuck";
        this._stopStreak(arrow);
        this._puff(hp);
        this.ctx.feedback.sound("arrow_hit_target", { volume: 0.8, at: hp });
        node.metadata?.onArrowHit?.({ arrow, point: hp, speed });
        this.onTargetHit?.(node, { arrow, point: hp, speed });
    }

    // --- draw tracking -------------------------------------------------------

    _updateDraw(dt, hand, origin) {
        const bow = this.ctx.bow;
        const fb = this.ctx.feedback;
        const inv = bow.aimPivot.getWorldMatrix().clone().invert();
        const local = BABYLON.Vector3.TransformCoordinates(origin.getAbsolutePosition(), inv);
        const pull = Math.min(MAX_DRAW, Math.max(0, bow.restZ - local.z));
        this.pull = pull;
        bow.setTension(pull / MAX_DRAW);
        bow.nock.position.z = bow.restZ - pull;

        // Detent on both hands per 0.01 m of pull change. Every CREAK_EVERY-th
        // detent is a bigger pulse paired with a bow-limb creak; the rest are
        // small silent buzzes. Detents are per-distance, so the creak cadence
        // speeds up the faster you draw. Overlap is fine — each creak's audible
        // part is front-loaded, the tail is decay.
        if (Math.abs(pull - this._lastTickPull) >= DRAW_TICK_STEP) {
            this._lastTickPull = pull;
            this._tickCount++;
            const tension = pull / MAX_DRAW;
            const big = this._tickCount % CREAK_EVERY === 0;
            const amp = big ? CREAK_AMP_BASE + tension * CREAK_AMP_SCALE
                            : TICK_AMP_BASE + tension * TICK_AMP_SCALE;
            fb.haptic(bow.bowHand, amp, big ? 0.02 : 0.005);
            fb.haptic(bow.drawHand, amp, big ? 0.02 : 0.005);
            if (big) fb.sound("creak", { volume: 0.4 + tension * 0.4, at: bow.handle });
        }

        // Full-draw strain ticks at random intervals: a buzz on both hands
        // (no sound at full draw).
        if (pull >= MAX_DRAW - 1e-3) {
            this._strainTimer -= dt;
            if (this._strainTimer <= 0) {
                this._strainTimer = STRAIN_MIN + Math.random() * (STRAIN_MAX - STRAIN_MIN);
                fb.haptic(bow.bowHand, 0.5, 0.01);
                fb.haptic(bow.drawHand, 0.5, 0.01);
            }
        } else {
            this._strainTimer = 0;
        }
    }

    // --- per-frame -----------------------------------------------------------

    update(dt) {
        this._cooldown = Math.max(0, this._cooldown - dt);
        const bow = this.ctx.bow;
        const d = this.ctx.debug;

        // Flight first — independent of bow/held state. Copy: _stick and
        // _despawn mutate live.
        const now = performance.now() / 1000;
        for (const a of [...this.live]) {
            if (a.state === "flying") this._updateFlight(dt, a);
            else if (a.state === "spent" && now - a.spentAt > SPENT_TTL) this._despawn(a);
        }

        if (bow.bowHand && bow.drawHand) {
            this._drawHand = bow.drawHand;
            if (!this.held && this._cooldown === 0) this._spawn();
        }
        if (!this.held || !bow.drawHand) {
            d.set("arrow", `${this.held ? this.held.state : "-"} (live ${this.live.length})`);
            return;
        }

        const hand = this.ctx.hands.hands[bow.drawHand];
        const origin = bow.nockOrigin;

        if (!this.nocked) {
            const seatPos = bow.nockRest.getAbsolutePosition();
            const handPos = origin.getAbsolutePosition();
            const dist = BABYLON.Vector3.Distance(handPos, seatPos);
            const approach = Math.min(1, Math.max(0,
                (APPROACH_DIST - dist) / (APPROACH_DIST - LERP_DONE_DIST)));

            // World pose: hand hold blended toward the seat by approach.
            // Held pose points the shaft (+Z = tip) along the draw hand's
            // pointer (index-finger) direction, not grip -Y (which is down).
            const ptr = hand.controller?.pointer ?? hand.gripNode;
            const aFwd = BABYLON.Vector3.TransformNormal(
                new BABYLON.Vector3(0, 0, 1), ptr.getWorldMatrix()).normalize();
            const aRight = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), aFwd).normalize();
            const aUp = BABYLON.Vector3.Cross(aFwd, aRight);
            const handRot = BABYLON.Quaternion.RotationQuaternionFromAxis(aRight, aUp, aFwd);
            const pos = BABYLON.Vector3.Lerp(handPos, seatPos, approach);
            const rot = approach > 0
                ? BABYLON.Quaternion.Slerp(handRot, bow.seatRotation, approach)
                : handRot;
            this.held.root.position.copyFrom(pos);
            this.held.root.rotationQuaternion.copyFrom(rot);

            // Nock finger pose follows the approach factor.
            hand.setAuthoredPoseTarget(HOLD_POSE, approach);

            // One-shot cues (no sound at nock-ready).
            if (dist < READY_DIST && !this._readyCued) {
                this._readyCued = true;
            }
            if (dist >= APPROACH_DIST) { this._readyCued = false; this._lerpCued = false; }
            if (dist < LERP_DONE_DIST && !this._lerpCued) {
                this._lerpCued = true;
                this.ctx.feedback.hapticUs(bow.drawHand, 500);
            }

            // Commit.
            if (dist < READY_DIST && hand[NOCK_BUTTON] >= NOCK_PRESS) this._nock(hand);
            d.set("arrow", `held d=${dist.toFixed(3)} appr=${approach.toFixed(2)}`);
        } else {
            if (hand[NOCK_BUTTON] <= NOCK_RELEASE) {
                this._release(hand);
            } else {
                this._updateDraw(dt, hand, origin);
            }
            d.set("arrow", `nocked pull=${this.pull.toFixed(3)} tension=${bow.tension.toFixed(2)}`);
        }
    }
}
