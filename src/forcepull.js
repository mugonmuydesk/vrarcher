// Force-pull / remote grab (Half-Life: Alyx "gravity gloves" style). Lives in
// the adapter layer: engine-clean targeting + a controlled flight that hands
// off to the existing grab path. Spec: hand-interactions.md §Remote grab.
//
// Per hand, each frame:
//   1. AIM     — while the grab button is armed (held past gripArm), cast the
//                hand's pointer ray and highlight the best forcePull-flagged
//                Interactable inside a cone (beyond touch-grab range). Gating
//                on grip stops an idle/resting hand from lighting things up as
//                you look around; releasing grip clears the highlight.
//   2. FLICK   — with the grab button (grip) held, a quick pull-back of the
//                hand (speed past a threshold, moving toward the player)
//                launches the locked target. Holding grip through the catch
//                means a plain grip release drops it.
//   3. FLIGHT  — the body flies gravity-free, its velocity steered toward the
//                (moving) hand each frame so the catch is reliable.
//   4. CATCH   — within catch radius, hand off to InteractionSystem.grab; the
//                held-follow path carries it from there.
//
// PORT: trajectory is a per-frame velocity steer (set-velocity), not a force
// joint — maps to a scripted homing toss in any engine.

import { GrabType } from "./interaction.js";

export const FORCE_PULL_TUNING = {
    maxRange: 9.0,        // m  — farthest pullable
    minRange: 0.55,       // m  — nearer than this is normal touch-grab
    coneDeg: 30,          // °  — aim cone half-angle
    lockGrace: 0.25,      // s  — keep the lock this long after aim wanders
    gripArm: 0.15,        // grip past this arms targeting/highlight (light squeeze)
    gripHold: 0.5,        // grab button (grip) must be held this much to fire
    flickSpeed: 1.4,      // m/s — hand speed that fires the launch
    flickTowardDot: 0.2,  // velocity must point this much back toward the head
    launchPop: 0.9,       // m/s — upward kick at launch for an arc
    pullGain: 6.0,        // 1/s — flight steer toward the hand (higher = snappier)
    pullSpeedMin: 2.0,    // m/s — floor on flight speed
    pullSpeedK: 5.0,      // 1/s — flight speed ramps with distance (×dist)
    pullSpeedMax: 9.0,    // m/s — cap on flight speed
    catchRadius: 0.20,    // m  — hand-off to grab inside this
    maxFlight: 1.6,       // s  — give up (restore gravity) after this
    relaunchCooldown: 0.4,// s  — per hand, after a launch
};

export class ForcePull {
    constructor(ctx) {
        this.ctx = ctx;
        this.target = { left: null, right: null };   // currently-highlighted
        this._grace = { left: 0, right: 0 };
        this._cooldown = { left: 0, right: 0 };
        this.pulling = new Map();   // interactable -> { hand, t, savedGravity }
        this._ray = new BABYLON.Ray(BABYLON.Vector3.Zero(), BABYLON.Vector3.Forward(), 100);
        this._coneCos = Math.cos(FORCE_PULL_TUNING.coneDeg * Math.PI / 180);
        ctx.updatables.push((dt) => this.update(dt));
    }

    // Aim ray for a hand: prefer the WebXR pointer (aim) ray, fall back to the
    // grip's forward axis. Returns { origin, dir } or null.
    _aim(hand) {
        const h = this.ctx.hands.hands[hand];
        if (!h.tracking) return null;
        const c = h.controller;
        if (c?.getWorldPointerRayToRef) {
            c.getWorldPointerRayToRef(this._ray);
            return { origin: this._ray.origin, dir: this._ray.direction };
        }
        const n = h.gripNode;
        if (!n) return null;
        return { origin: n.absolutePosition, dir: n.forward };
    }

    // Best forcePull candidate the hand points at, or null.
    _pick(hand) {
        const aim = this._aim(hand);
        if (!aim) return null;
        const T = FORCE_PULL_TUNING;
        let best = null, bestCos = this._coneCos;
        for (const it of this.ctx.interaction.interactables) {
            if (!it.forcePull || it.heldBy || this.pulling.has(it)) continue;
            const c = it.mesh.getBoundingInfo().boundingSphere.centerWorld;
            const to = c.subtract(aim.origin);
            const dist = to.length();
            if (dist < T.minRange || dist > T.maxRange) continue;
            const cos = BABYLON.Vector3.Dot(aim.dir, to.scale(1 / dist));
            if (cos > bestCos) { best = it; bestCos = cos; }
        }
        return best;
    }

    _setTarget(hand, it) {
        const prev = this.target[hand];
        if (prev === it) return;
        // Only clear the outline if the OTHER hand isn't also targeting it.
        if (prev && this.target[hand === "left" ? "right" : "left"] !== prev) {
            prev.mesh.renderOutline = false;
        }
        this.target[hand] = it;
        if (it) {
            it.mesh.renderOutline = true;
            it.mesh.outlineColor = new BABYLON.Color3(0.4, 0.8, 1.0);
            it.mesh.outlineWidth = 0.02;
        }
    }

    _launch(it, hand) {
        const T = FORCE_PULL_TUNING;
        const h = this.ctx.hands.hands[hand];
        const body = it.body;
        if (!body) return;
        const objPos = it.mesh.getBoundingInfo().boundingSphere.centerWorld.clone();
        const handPos = h.worldPosition;
        const to = handPos.subtract(objPos);
        const dist = to.length();
        const saved = body.getGravityFactor();
        body.setGravityFactor(0);
        if (body.getMotionType() !== BABYLON.PhysicsMotionType.DYNAMIC) {
            body.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
        }
        // Initial toss: straight at the hand + an upward pop for an arc.
        const speed = Math.min(T.pullSpeedMax, Math.max(T.pullSpeedMin, dist * T.pullSpeedK));
        const v0 = to.scale(speed / Math.max(dist, 1e-3));
        v0.y += T.launchPop;
        body.setLinearVelocity(v0);
        body.setAngularVelocity(BABYLON.Vector3.Zero());
        // Suppress the throwable's own auto-catch (larger radius) so the
        // snap-into-palm catch below wins and the ball lands in the hand.
        it._forcePulling = true;
        this.pulling.set(it, { hand, t: 0, savedGravity: saved });
        this._cooldown[hand] = T.relaunchCooldown;
        this.ctx.feedback?.haptic?.(hand, 0.7, 0.04);
        this.ctx.feedback?.sound?.("grab", { pitch: 0.8 });
    }

    _updateFlight(dt) {
        const T = FORCE_PULL_TUNING;
        for (const [it, st] of this.pulling) {
            st.t += dt;
            if (it.heldBy) { it._forcePulling = false; this.pulling.delete(it); continue; }
            const h = this.ctx.hands.hands[st.hand];
            const body = it.body;
            const objPos = it.mesh.getBoundingInfo().boundingSphere.centerWorld;
            const to = h.worldPosition.subtract(objPos);
            const dist = to.length();
            if (dist < T.catchRadius && h.tracking) {
                // Snap into the palm for a clean "lands in hand" catch, then
                // hand off to the grab path (held-follow keeps it there). The
                // snap zeroes the grab offset so it sits in the hand, not at
                // the catch-radius arm's length.
                const palm = this.ctx.physicsHands.hands[st.hand].palmNode;
                palm.computeWorldMatrix(true);
                body.setGravityFactor(st.savedGravity);
                body.disablePreStep = false;
                it.mesh.setParent(null);
                it.mesh.position.copyFrom(palm.absolutePosition);
                if (!it.mesh.rotationQuaternion) it.mesh.rotationQuaternion = new BABYLON.Quaternion();
                it.mesh.rotationQuaternion.copyFrom(palm.absoluteRotationQuaternion);
                it.mesh.computeWorldMatrix(true);
                body.setTargetTransform(palm.absolutePosition, palm.absoluteRotationQuaternion);
                it._forcePulling = false;
                this.pulling.delete(it);
                if (!this.ctx.interaction.grab(st.hand, it, GrabType.GRIP)) {
                    body.setLinearVelocity(BABYLON.Vector3.Zero());
                }
                continue;
            }
            if (st.t > T.maxFlight || !h.tracking) {
                body.setGravityFactor(st.savedGravity);
                it._forcePulling = false;
                this.pulling.delete(it);
                continue;
            }
            // Steer velocity toward the hand (homing), speed ramped by distance.
            const speed = Math.min(T.pullSpeedMax, Math.max(T.pullSpeedMin, dist * T.pullSpeedK));
            const desired = to.scale(speed / Math.max(dist, 1e-3));
            const cur = body.getLinearVelocity();
            const blended = BABYLON.Vector3.Lerp(cur, desired, Math.min(1, T.pullGain * dt));
            body.setLinearVelocity(blended);
        }
    }

    update(dt) {
        this._updateFlight(dt);

        const T = FORCE_PULL_TUNING;
        const head = this.ctx.scene.activeCamera?.globalPosition;
        for (const hand of ["left", "right"]) {
            if (this._cooldown[hand] > 0) this._cooldown[hand] -= dt;
            const h = this.ctx.hands.hands[hand];

            // Only target while the grab button is armed (held past gripArm)
            // and the hand is free — an idle/resting hand must not light things
            // up as you look around (release clears the highlight at once).
            if (!h.tracking || this.ctx.interaction.held[hand] || h.grip < T.gripArm) {
                this._setTarget(hand, null);
                this._grace[hand] = 0;
                continue;
            }

            const pick = this._pick(hand);
            if (pick) {
                this._setTarget(hand, pick);
                this._grace[hand] = T.lockGrace;
            } else if (this._grace[hand] > 0) {
                this._grace[hand] -= dt;
                if (this._grace[hand] <= 0) this._setTarget(hand, null);
            }

            // Flick (with grip held) to launch the locked target.
            const tgt = this.target[hand];
            if (tgt && this._cooldown[hand] <= 0 && head && !this.pulling.has(tgt)
                && h.grip > T.gripHold) {
                const v = h.linearVelocity;
                const speed = v.length();
                const toHead = head.subtract(h.worldPosition);
                const tlen = toHead.length();
                if (speed > T.flickSpeed && tlen > 1e-3
                    && BABYLON.Vector3.Dot(v, toHead) / (speed * tlen) > T.flickTowardDot) {
                    this._launch(tgt, hand);
                    this._setTarget(hand, null);
                    this._grace[hand] = 0;
                }
            }
        }
    }
}
