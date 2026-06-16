// Throwable family: physical Interactables.
//
// makeThrowable — basic: kinematic (ANIMATED) while in hand — the node
// rides the hand and pre-step sync pushes its transform into the body so it
// still shoves dynamic objects — then DYNAMIC on release with the
// estimator's release velocities applied directly (set, don't force).
// Optional auto-catch: an object flying AT the hand above a speed threshold
// attaches without a button press.
//
// makeHeavyThrowable — never kinematic: the hand drags the body by force
// (≤800 N) and torque (≤900, per-axis gains 8/9/8, angular damping 30×mass
// multiplier) applied at the nearest surface point; the visual hand snaps
// to that point. Mass multiplier scales effort.
//
// makeTwoHandedThrowable — multiple simultaneous holds on one rigidbody:
// spring force (attach 800, damper 25) at the closest surface point to each
// hand; hover haptics 800 µs enter / 500 µs exit.
//
// Collision haptics while held (all variants): impulse window 0.5→3.0 maps
// to amplitude 0.5→1.0, min 0.2 s apart. (Havok only emits contact events
// when at least one body is dynamic, so a held/kinematic item ticks against
// dynamic objects, not static walls — acceptable for now.)

import { Interactable, GrabType } from "./interaction.js";
import { LAYERS } from "./physics.js";

const COLLISION_HAPTIC = {
    minImpulse: 0.5, maxImpulse: 3.0,
    minAmp: 0.5, maxAmp: 1.0,
    minInterval: 0.2, // s
};

const AUTO_CATCH = {
    minSpeed: 2.0,     // m/s — object must be flying, not drifting
    radius: 0.25,      // m — catch sphere around the palm
    approachDot: 0.5,  // velocity must point at the hand
    releaseCooldown: 0.3, // s — no instant re-catch of a fresh throw
};

export const HEAVY_TUNING = {
    maxForce: 800,            // N (spec)
    maxTorque: 900,           // N·m (spec)
    angularGains: [8, 9, 8],  // per-axis (spec)
    angularDamping: 30,       // × mass multiplier (spec)
    linStiffness: 100,        // 1/s² — accel per metre of error
    linDamping: 20,           // 1/s
};

export const TWOHAND_TUNING = {
    attach: 800,  // N/m spring (spec)
    damper: 25,   // N·s/m (spec)
    hoverEnterUs: 800,
    hoverExitUs: 500,
};

// Object-impact sound matrix. Each collidable mesh is tagged (in main.js /
// scene.js) with metadata.soundMaterial {wood,metal,rock,sand} and dynamic
// objects also metadata.soundSize {small,medium,big}. The impact clip is
// drop_<striker material>_<striker size>_on_<surface material>.
const SIZE_RANK = { small: 0, medium: 1, big: 2 };
// The striker's material vocab includes "sand", but the surface vocab uses
// "soil" — a sand body acting as the struck surface maps to soil.
function toSurface(mat) { return mat === "sand" ? "soil" : (mat || "wood"); }

function wireCollisionHaptics(ctx, body, it) {
    let last = 0;
    body.setCollisionCallbackEnabled(true);
    body.getCollisionObservable().add((ev) => {
        if (ev.type !== "COLLISION_STARTED") return;
        const now = performance.now() / 1000;
        if (now - last < COLLISION_HAPTIC.minInterval) return;
        const impulse = ev.impulse ?? 0;
        if (impulse < COLLISION_HAPTIC.minImpulse) return;
        last = now;
        const t = Math.min(1, (impulse - COLLISION_HAPTIC.minImpulse)
            / (COLLISION_HAPTIC.maxImpulse - COLLISION_HAPTIC.minImpulse));

        // Haptics only while the item is held (a hand has to be on it to feel them).
        if (it.heldBy) {
            const amp = COLLISION_HAPTIC.minAmp + t * (COLLISION_HAPTIC.maxAmp - COLLISION_HAPTIC.minAmp);
            for (const hand of it.holders) ctx.feedback.haptic(hand, amp, 0.02);
        }

        // Material-matched impact clip. This object is the striker; the thing it
        // hit is the surface. When BOTH are dynamic tagged objects, only the
        // smaller one plays (tie broken by name) so the clip sounds once — a
        // static surface has no callback of its own, so against the world this
        // object always plays.
        const mine = it.mesh.metadata || {};
        const myMat = mine.soundMaterial || "wood";
        const mySize = mine.soundSize || "medium";
        const otherNode = ev.collidedAgainst?.transformNode;
        const other = otherNode?.metadata || {};
        if (other.soundSize) {
            const mineRank = SIZE_RANK[mySize] ?? 1;
            const otherRank = SIZE_RANK[other.soundSize] ?? 1;
            const iAmStriker = mineRank < otherRank
                || (mineRank === otherRank && it.mesh.name < (otherNode.name || ""));
            if (!iAmStriker) return;
        }
        // Only sound against a tagged object or surface — untagged geometry and
        // hand/palm bodies stay silent rather than playing a default impact.
        if (!other.soundSize && !other.soundMaterial) return;
        const name = `drop_${myMat}_${mySize}_on_${toSurface(other.soundMaterial)}`;
        ctx.feedback.sound(name, { volume: 0.25 + 0.55 * t, at: ev.point ?? it.mesh });
    });
}

function makeAggregate(ctx, mesh, opts) {
    const agg = new BABYLON.PhysicsAggregate(
        mesh,
        opts.shapeType ?? BABYLON.PhysicsShapeType.CONVEX_HULL,
        { mass: opts.mass ?? 0.3, restitution: opts.restitution ?? 0.3, friction: opts.friction ?? 0.6 },
        ctx.scene);
    agg.shape.filterMembershipMask = LAYERS.GRABBABLE;
    // HAND included so the physics hands can push/block free grabbables.
    agg.shape.filterCollideMask = LAYERS.DEFAULT | LAYERS.GRABBABLE | LAYERS.HAND;
    return agg;
}

// While held, an item moves to LAYERS.HELD (no HAND bit) so it can't shove
// the palm bodies of the hand carrying it. The GRABBABLE masks come back
// only once the item is CLEAR of both palms (or after a timeout): restoring
// at the release instant would let Havok's depenetration kick the palm
// overlap apart and corrupt the throw velocity.
const HELD_CLEARANCE = { dist: 0.1, timeout: 0.4 }; // m past the surface / s

function wireHeldFilter(ctx, it, shape) {
    // Plain polled state, driven by the item's per-frame update (no
    // self-removing observers): `restorePending` is set on release and the
    // clearance check runs in update() until it restores the masks.
    let restorePending = false;
    let restoreT0 = 0;
    const noHand = () => {
        restorePending = false;
        shape.filterMembershipMask = LAYERS.HELD;
        shape.filterCollideMask = LAYERS.DEFAULT | LAYERS.GRABBABLE;
    };
    // Restore hand collision once the item is clear of both palms.
    const requestRestore = () => {
        if (restorePending || it.heldBy) return;
        restorePending = true;
        restoreT0 = performance.now() / 1000;
    };
    const update = () => {
        if (!restorePending) return;
        if (it.heldBy) { restorePending = false; return; } // regrabbed mid-flight
        const timedOut = performance.now() / 1000 - restoreT0 > HELD_CLEARANCE.timeout;
        const clear = timedOut || ["left", "right"].every(h => {
            const palm = ctx.physicsHands?.hands[h]?.palmNode;
            return !palm || it.distanceTo(palm.absolutePosition) > HELD_CLEARANCE.dist;
        });
        if (clear) {
            shape.filterMembershipMask = LAYERS.GRABBABLE;
            shape.filterCollideMask = LAYERS.DEFAULT | LAYERS.GRABBABLE | LAYERS.HAND;
            restorePending = false;
        }
    };
    // Grab-intent suspension (InteractionSystem): a hand hovering this item
    // with the grab button part-squeezed must not punch it away while
    // reaching — hand collision pauses until the intent (or hover) ends.
    it.suspendHandCollision = noHand;
    it.resumeHandCollision = requestRestore;
    return { onGrab: noHand, onRelease: requestRestore, update };
}

// Closest point on the mesh's local bounding box to a world-space point,
// returned in LOCAL space ("nearest surface point" approximation).
function closestLocalPoint(mesh, worldPoint) {
    const inv = BABYLON.Matrix.Invert(mesh.getWorldMatrix());
    const local = BABYLON.Vector3.TransformCoordinates(worldPoint, inv);
    const bb = mesh.getBoundingInfo().boundingBox;
    return BABYLON.Vector3.Clamp(local, bb.minimum, bb.maximum);
}

// World-space velocity of a body at a world point (v + ω×r).
function velocityAtPoint(body, center, worldPoint) {
    const v = body.getLinearVelocity();
    const w = body.getAngularVelocity();
    return v.add(BABYLON.Vector3.Cross(w, worldPoint.subtract(center)));
}

// ---------------------------------------------------------------------------

export function makeThrowable(ctx, mesh, opts = {}) {
    const agg = makeAggregate(ctx, mesh, opts);
    const body = agg.body;

    let lastRelease = -Infinity;
    let heldFilter;

    // Held-follow: drive the ANIMATED body from the palm's CURRENT world pose
    // each frame. Parenting the mesh to the palm and relying on the prestep
    // node->body sync alone freezes the body — the palm moves after the mesh's
    // world matrix was last computed, so the prestep reads a STALE matrix and
    // the body stays at the grab pose (the mesh's local offset then shifts to
    // cancel the parent move, pinning the world pose). Instead, capture the
    // grab-time mesh->palm offset and re-derive the body target from the live
    // palm matrix. // PORT: where a kinematic body tracks a parented node
    // without a frame-stale read, this collapses back to plain parenting.
    let heldOffset = null;                  // meshWorld * inv(palmWorld) at grab
    const _heldWorld = new BABYLON.Matrix();
    const _heldPos = new BABYLON.Vector3();
    const _heldRot = new BABYLON.Quaternion();
    const palmOf = (hand) => ctx.physicsHands.hands[hand].palmNode;
    const driveHeld = () => {
        if (!heldOffset || !it.heldBy || !it.kinematic) return;
        const palm = palmOf(it.heldBy);
        palm.computeWorldMatrix(true);
        heldOffset.multiplyToRef(palm.getWorldMatrix(), _heldWorld);
        _heldWorld.getTranslationToRef(_heldPos);
        BABYLON.Quaternion.FromRotationMatrixToRef(_heldWorld, _heldRot);
        body.setTargetTransform(_heldPos, _heldRot);
    };

    const it = new Interactable(mesh, {
        curlToContact: opts.curlToContact ?? true,
        ...opts,
        onGrab: (hand, info) => {
            heldFilter.onGrab();
            if (it.kinematic) {
                body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
                body.disablePreStep = false; // hand-parented node drives the body
                // Snap/parent are already applied by InteractionSystem.grab;
                // freeze the offset from the now-current world poses.
                const palm = palmOf(hand);
                palm.computeWorldMatrix(true);
                mesh.computeWorldMatrix(true);
                heldOffset = mesh.getWorldMatrix().multiply(
                    BABYLON.Matrix.Invert(palm.getWorldMatrix()));
            }
            opts.onGrab?.(hand, info);
        },
        onRelease: (hand, info) => {
            lastRelease = performance.now() / 1000;
            heldOffset = null;
            body.disablePreStep = true;
            body.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
            body.setGravityFactor(it.gravityOff ? 0 : 1);
            body.setLinearVelocity(info.linearVelocity);
            body.setAngularVelocity(info.angularVelocity);
            heldFilter.onRelease();
            opts.onRelease?.(hand, info);
        },
    });
    heldFilter = wireHeldFilter(ctx, it, agg.shape);
    it.body = body;
    it.aggregate = agg;
    ctx.interaction.register(it);

    // Auto-catch: each frame the item is free and flying, check both hands.
    const autoCatch = () => {
        if (it.heldBy || it._forcePulling) return; // force-pull lands it itself
        if (performance.now() / 1000 - lastRelease < AUTO_CATCH.releaseCooldown) return;
        const v = body.getLinearVelocity();
        const speed = v.length();
        if (speed < AUTO_CATCH.minSpeed) return;
        for (const hand of ["left", "right"]) {
            const handCtl = ctx.hands.hands[hand];
            if (!handCtl.tracking || ctx.interaction.held[hand]) continue;
            const toHand = handCtl.worldPosition.subtract(mesh.absolutePosition);
            const dist = toHand.length();
            if (dist > AUTO_CATCH.radius) continue;
            if (dist > 1e-4
                && BABYLON.Vector3.Dot(v, toHand) / (speed * dist) < AUTO_CATCH.approachDot) continue;
            if (ctx.interaction.grab(hand, it, GrabType.GRIP)) {
                ctx.feedback.sound("grab", { pitch: 1.3, at: it.mesh });
                break;
            }
        }
    };
    ctx.updatables.push(() => {
        heldFilter.update();
        driveHeld();
        if (opts.autoCatch) autoCatch();
    });

    wireCollisionHaptics(ctx, body, it);
    return it;
}

// ---------------------------------------------------------------------------

export function makeHeavyThrowable(ctx, mesh, opts = {}) {
    const agg = makeAggregate(ctx, mesh, { shapeType: BABYLON.PhysicsShapeType.BOX, ...opts });
    const body = agg.body;
    const massMul = opts.massMultiplier ?? 1;
    const mass = opts.mass ?? 8;
    const T = HEAVY_TUNING;

    let grabLocal = null;   // grab point, mesh-local
    let relRot = null;      // bodyRot in hand space at grab time
    let halfHeight = 0;     // world half-height at grab (force application offset)
    let savedDamping = 0;

    let heldFilter;
    const it = new Interactable(mesh, {
        grabTypes: [GrabType.GRIP],
        curlToContact: opts.curlToContact ?? true,
        ...opts,
        parentToHand: false,
        kinematic: false, // never kinematic (spec)
        // The item legitimately lags the ghost (force caps) — the visible
        // hand welds to the item so the drift stays on the invisible link.
        pinHand: {},
        onGrab: (hand, info) => {
            heldFilter.onGrab();
            const handCtl = ctx.hands.hands[hand];
            grabLocal = closestLocalPoint(mesh, handCtl.worldPosition);
            relRot = BABYLON.Quaternion.Inverse(handCtl.worldRotation)
                .multiply(mesh.absoluteRotationQuaternion);
            const bb = mesh.getBoundingInfo().boundingBox;
            halfHeight = (bb.maximum.y - bb.minimum.y) / 2 * Math.abs(mesh.scaling.y);
            savedDamping = body.getAngularDamping();
            body.setAngularDamping(T.angularDamping * massMul);
            opts.onGrab?.(hand, info);
        },
        attachedUpdate: (dt, hand) => {
            const handCtl = ctx.hands.hands[hand];
            const grabWorld = BABYLON.Vector3.TransformCoordinates(grabLocal, mesh.getWorldMatrix());
            const center = mesh.absolutePosition;

            // Linear: acceleration PD, error measured hand→surface grab
            // point but force applied at the BOTTOM of the body. Applying
            // at the grab point (or even the centre) lever-arms the box
            // over its leading edge — it ends up wedged on an edge and the
            // drag stalls (verified in the ext2 demo, rest y 0.18 → 0.247 =
            // the half-diagonal). At the bottom, friction's lever vanishes
            // and the spring presses the box onto the ground instead.
            const err = handCtl.worldPosition.subtract(grabWorld);
            const vel = body.getLinearVelocity();
            const force = err.scale(T.linStiffness).subtract(vel.scale(T.linDamping))
                .scaleInPlace(mass * massMul);
            const maxF = T.maxForce * massMul;
            if (force.length() > maxF) force.scaleInPlace(maxF / force.length());
            body.applyForce(force, center.add(new BABYLON.Vector3(0, -halfHeight, 0)));

            // Angular: per-axis gains toward the grab-time relative
            // orientation; heavy angular damping does the stabilising.
            const targetRot = handCtl.worldRotation.multiply(relRot);
            const qErr = targetRot.multiply(
                BABYLON.Quaternion.Inverse(mesh.absoluteRotationQuaternion));
            if (qErr.w < 0) qErr.scaleInPlace(-1);
            const w = Math.min(1, Math.max(-1, qErr.w));
            const angle = 2 * Math.acos(w);
            if (angle > 1e-4) {
                const s = Math.sqrt(1 - w * w);
                const [gx, gy, gz] = T.angularGains;
                const torque = new BABYLON.Vector3(
                    qErr.x / s * angle * gx, qErr.y / s * angle * gy, qErr.z / s * angle * gz)
                    .scaleInPlace(mass * massMul);
                const maxT = T.maxTorque * massMul;
                if (torque.length() > maxT) torque.scaleInPlace(maxT / torque.length());
                body.applyAngularImpulse(torque.scale(dt));
            }

            // (Visual hand tracking the grab point is handled by the
            // pinHand weld — no ad-hoc rig snapping here.)
            opts.attachedUpdate?.(dt, hand);
        },
        onRelease: (hand, info) => {
            body.setAngularDamping(savedDamping);
            heldFilter.onRelease();
            opts.onRelease?.(hand, info);
        },
    });
    heldFilter = wireHeldFilter(ctx, it, agg.shape);
    it.body = body;
    it.aggregate = agg;
    ctx.interaction.register(it);
    ctx.updatables.push(() => heldFilter.update());
    wireCollisionHaptics(ctx, body, it);
    return it;
}

// ---------------------------------------------------------------------------

export function makeTwoHandedThrowable(ctx, mesh, opts = {}) {
    const agg = makeAggregate(ctx, mesh, { shapeType: BABYLON.PhysicsShapeType.BOX, ...opts });
    const body = agg.body;
    const T = TWOHAND_TUNING;
    const anchors = {}; // hand -> mesh-local attach point

    let heldFilter;
    const it = new Interactable(mesh, {
        curlToContact: opts.curlToContact ?? true,
        ...opts,
        parentToHand: false,
        kinematic: false,
        multiHold: true,
        // Both hands weld to their own grab points on the beam; the
        // spring-held beam chases the ghosts, drift stays invisible.
        pinHand: {},
        onHoverBegin: (hand) => {
            ctx.feedback.hapticUs(hand, T.hoverEnterUs);
            opts.onHoverBegin?.(hand);
        },
        onHoverEnd: (hand) => {
            ctx.feedback.hapticUs(hand, T.hoverExitUs);
            opts.onHoverEnd?.(hand);
        },
        onGrab: (hand, info) => {
            heldFilter.onGrab();
            anchors[hand] = closestLocalPoint(mesh, ctx.hands.hands[hand].worldPosition);
            opts.onGrab?.(hand, info);
        },
        attachedUpdate: (dt, hand) => {
            const anchor = anchors[hand];
            if (!anchor) return;
            const anchorWorld = BABYLON.Vector3.TransformCoordinates(anchor, mesh.getWorldMatrix());
            const err = ctx.hands.hands[hand].worldPosition.subtract(anchorWorld);
            const vel = velocityAtPoint(body, mesh.absolutePosition, anchorWorld);
            const force = err.scale(T.attach).subtract(vel.scale(T.damper));
            body.applyForce(force, anchorWorld);
            opts.attachedUpdate?.(dt, hand);
        },
        onRelease: (hand, info) => {
            delete anchors[hand];
            heldFilter.onRelease();
            opts.onRelease?.(hand, info);
        },
    });
    heldFilter = wireHeldFilter(ctx, it, agg.shape);
    it.body = body;
    it.aggregate = agg;
    ctx.interaction.register(it);
    ctx.updatables.push(() => heldFilter.update());
    wireCollisionHaptics(ctx, body, it);
    return it;
}
