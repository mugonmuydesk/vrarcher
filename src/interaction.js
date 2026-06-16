// Interactable registry, hover detection and the grab pipeline.
//
// Hover: three-tier proximity per spec, polled at 10 Hz — palm sphere
// (0.05 m, with a distance boost up to ×4 as the hand drops to waist level
// for floor/waist pickup forgiveness), controller-tip sphere (0.075) and
// index-fingertip sphere (0.025). Closest interactable across all tiers
// wins; begin/end events fire with a haptic blip. Items can restrict which
// tiers see them (opts.tiers).
// Hover can be LOCKED per hand by an interaction (e.g. while nocked) so
// hand-offs can't happen mid-action.
//
// Grab: Pinch (trigger) vs Grip (squeeze). Items declare which they accept.
// Attach flags per item: parentToHand, kinematic, snapToPose, gravityOff —
// the physics-facing flags are consumed by the Throwable component once
// Havok lands (Phase 3); this module owns the lifecycle.

import { HandPin } from "./handpin.js";

export const GrabType = { PINCH: "pinch", GRIP: "grip" };

// Hover tiers (spec quick table: hand 0.05 / tip 0.075 / finger 0.025).
const HOVER_TIERS = [
    { name: "palm", radius: 0.05, boost: true },
    { name: "tip", radius: 0.075 },
    { name: "fingertip", radius: 0.025 },
];
// Waist-level pickup forgiveness: the palm radius scales 1→4 as the hand
// drops from BOOST_TOP_Y to BOOST_BOTTOM_Y.
const HOVER_BOOST_MAX = 4.0;
const BOOST_TOP_Y = 0.9;    // m — no boost above this hand height
const BOOST_BOTTOM_Y = 0.5; // m — full boost at/below this hand height
const HOVER_POLL_INTERVAL = 0.1; // s (10 Hz)
const HOVER_HAPTIC_AMPLITUDE = 0.5;
// Hand collision pauses for grabbables this close to a hand whose grab
// button is part-squeezed (reach-without-punting; see _updateGrabIntent).
const GRAB_INTENT_RADIUS = 0.25; // m
// Which input drives which grab type.
const GRAB_BUTTON = { [GrabType.PINCH]: "trigger", [GrabType.GRIP]: "grip" };
// Frames after a grab before the curl-to-contact clamp is recomputed (the
// visual hand rides the physics palm, which lags the grip at the grab
// instant — wait for it to settle).
const CURL_SETTLE_FRAMES = 10;

export class Interactable {
    /**
     * @param mesh root mesh (bounding sphere used for hover distance)
     * @param opts {
     *   grabTypes: [GrabType...] (default both),
     *   parentToHand: bool (default true),
     *   kinematic: bool (default true)   — while held, body is kinematic
     *   gravityOff: bool (default false) — gravity disabled on release
     *   snapToPose: { position: Vector3, rotation: Quaternion } | null
     *       local offset under the hand grip to snap to on attach
     *   multiHold: bool (default false) — both hands may hold simultaneously
     *       (complex/two-handed throwables); requires parentToHand: false
     *   holdPose: string | null — authored hand clip while held (e.g. "Hold")
     *   curlToContact: bool (default false) — on grab, each finger group
     *       curls until its sampled joints touch the held mesh, then stops
     *       (overrides holdPose when the clamp can be computed)
     *   hoverRadius: extra radius added to palm sphere (default bounding sphere)
     *   tiers: ["palm"|"tip"|"fingertip"...] — hover tiers that can see
     *       this item (default: all)
     *   pinHand: { rollAxis?: Vector3, freeRotation?: bool } | null —
     *       while held, the visual hand is pinned to this mesh's frame
     *       (HandPin): frozen grab offset, optional single roll axis
     *       (frame-local) or position-only ball grip. For constrained
     *       mechanisms whose mesh can't follow the controller.
     *   onHoverBegin/onHoverEnd: (hand) => {}
     *   onGrab/onRelease: (hand, info) => {}
     *   attachedUpdate: (dt, hand) => {} — every frame while held
     * }
     */
    constructor(mesh, opts = {}) {
        this.mesh = mesh;
        this.grabTypes = opts.grabTypes ?? [GrabType.PINCH, GrabType.GRIP];
        this.parentToHand = opts.parentToHand ?? true;
        this.kinematic = opts.kinematic ?? true;
        this.gravityOff = opts.gravityOff ?? false;
        this.snapToPose = opts.snapToPose ?? null;
        this.holdPose = opts.holdPose ?? null;
        this.curlToContact = opts.curlToContact ?? false;
        this.hoverRadius = opts.hoverRadius ?? null;
        this.tiers = opts.tiers ?? null; // null = visible to every tier
        this.multiHold = opts.multiHold ?? false;
        this.forcePull = opts.forcePull ?? false; // eligible for remote grab
        this.pinHand = opts.pinHand ?? null;
        this.onHoverBegin = opts.onHoverBegin ?? null;
        this.onHoverEnd = opts.onHoverEnd ?? null;
        this.onGrab = opts.onGrab ?? null;
        this.onRelease = opts.onRelease ?? null;
        this.attachedUpdate = opts.attachedUpdate ?? null;

        this.hoveredBy = null; // hand name
        this.heldBy = null;    // hand name (first holder for multiHold)
        this.holders = new Set(); // all holding hands
        this.grabType = null;  // active grab type while held (last grab)
        this._savedParent = null;
    }

    // Distance from a world point to this interactable's surface (bounding
    // sphere approximation). The root may be a bare TransformNode (e.g. the
    // bow), which has no bounding info — fall back to its origin + an
    // explicit hoverRadius. NB: an exception here kills the emulator's XR
    // frame pump silently, so be conservative.
    distanceTo(point) {
        let center, radius;
        if (typeof this.mesh.getBoundingInfo === "function") {
            const bs = this.mesh.getBoundingInfo().boundingSphere;
            center = bs.centerWorld;
            radius = this.hoverRadius ?? bs.radiusWorld;
        } else {
            center = this.mesh.getAbsolutePosition();
            radius = this.hoverRadius ?? 0.1;
        }
        return Math.max(0, BABYLON.Vector3.Distance(center, point) - radius);
    }
}

export class InteractionSystem {
    constructor(ctx) {
        this.ctx = ctx;
        this.interactables = new Set();
        this.hover = { left: null, right: null };
        this.hoverTier = { left: null, right: null }; // tier that produced the hover
        this.hoverLocks = { left: 0, right: 0 }; // counted locks
        this.held = { left: null, right: null };
        this._heldType = { left: null, right: null }; // per-hand grab type
        this._pollAccum = 0;
        this._collisionSuspended = new Set(); // grab-intent (see _updateGrabIntent)
        this._curlRecompute = { left: null, right: null }; // pending settle recomputes
        this._pins = { left: null, right: null }; // active HandPins (ctx.handPins)
    }

    // While a hand approaches an item WITH grab intent (button part-
    // squeezed), suspend that item's hand collision so reaching for it
    // doesn't punch it away. Proximity-based, NOT hover-based: the hover
    // poll is 10 Hz and the finger collider can cross into the item within
    // one poll period (verified — punted the ball mid-approach). Open-palm
    // contact (no buttons) still blocks and shoves.
    _updateGrabIntent() {
        const want = new Set();
        for (const hand of ["left", "right"]) {
            const h = this.ctx.hands.hands[hand];
            if (h.grip <= 0.3 && h.trigger <= 0.3) continue;
            const palm = this.palmPoint(hand);
            if (!palm) continue;
            for (const it of this.interactables) {
                if (it.suspendHandCollision && it.distanceTo(palm) < GRAB_INTENT_RADIUS) {
                    want.add(it);
                }
            }
        }
        for (const it of this._collisionSuspended) {
            if (!want.has(it)) {
                this._collisionSuspended.delete(it);
                it.resumeHandCollision();
            }
        }
        for (const it of want) {
            if (!this._collisionSuspended.has(it)) {
                this._collisionSuspended.add(it);
                it.suspendHandCollision();
            }
        }
    }

    register(interactable) {
        this.interactables.add(interactable);
        return interactable;
    }

    unregister(interactable) {
        while (interactable.heldBy) this.release(interactable.heldBy);
        if (interactable.hoveredBy) this._setHover(interactable.hoveredBy, null);
        this.interactables.delete(interactable);
    }

    // --- hover lock API ------------------------------------------------
    lockHover(hand) { this.hoverLocks[hand]++; }
    unlockHover(hand) { this.hoverLocks[hand] = Math.max(0, this.hoverLocks[hand] - 1); }

    // --- probe points ----------------------------------------------------
    palmPoint(hand) {
        const h = this.ctx.hands.hands[hand];
        return h.tracking ? h.worldPosition : null;
    }

    // One probe per tier: { tier, point, radius }. The palm tier carries the
    // waist-level distance boost; tip/fingertip stay precise.
    _probes(hand) {
        const h = this.ctx.hands.hands[hand];
        if (!h.tracking) return [];
        const points = {
            palm: h.worldPosition,
            tip: h.tipPoint,
            fingertip: h.fingertipPoint,
        };
        const probes = [];
        for (const tier of HOVER_TIERS) {
            const point = points[tier.name];
            if (!point) continue;
            let radius = tier.radius;
            if (tier.boost) {
                const t = Math.min(1, Math.max(0,
                    (BOOST_TOP_Y - point.y) / (BOOST_TOP_Y - BOOST_BOTTOM_Y)));
                radius *= 1 + (HOVER_BOOST_MAX - 1) * t;
            }
            probes.push({ tier: tier.name, point, radius });
        }
        return probes;
    }

    _setHover(hand, interactable, tier = null) {
        this.hoverTier[hand] = interactable ? tier : null;
        const prev = this.hover[hand];
        if (prev === interactable) return;
        if (prev) {
            prev.hoveredBy = null;
            prev.onHoverEnd?.(hand);
        }
        this.hover[hand] = interactable;
        if (interactable) {
            interactable.hoveredBy = hand;
            this.ctx.feedback.haptic(hand, HOVER_HAPTIC_AMPLITUDE, 0.01);
            this.ctx.feedback.sound("hover", { volume: 0.2 });
            interactable.onHoverBegin?.(hand);
        }
    }

    _pollHover() {
        for (const hand of ["left", "right"]) {
            if (this.held[hand] || this.hoverLocks[hand] > 0) continue;
            const probes = this._probes(hand);
            if (!probes.length) { this._setHover(hand, null); continue; }

            let best = null, bestDist = Infinity, bestTier = null;
            for (const it of this.interactables) {
                // No hand-offs of held items — but multiHold items stay
                // hoverable so the second hand can join.
                if (it.heldBy && !it.multiHold) continue;
                for (const pr of probes) {
                    if (it.tiers && !it.tiers.includes(pr.tier)) continue;
                    const d = it.distanceTo(pr.point);
                    if (d < pr.radius && d < bestDist) {
                        best = it; bestDist = d; bestTier = pr.tier;
                    }
                }
            }
            this._setHover(hand, best, bestTier);
        }
    }

    // --- grab / release ------------------------------------------------
    grab(hand, interactable, grabType) {
        const handCtl = this.ctx.hands.hands[hand];
        const gripNode = handCtl.gripNode;
        if (!gripNode) return false;
        if (interactable.heldBy && !interactable.multiHold) return false;
        if (interactable.holders.has(hand)) return false;

        this._setHover(hand, null);
        interactable.holders.add(hand);
        if (!interactable.heldBy) interactable.heldBy = hand;
        interactable.grabType = grabType;
        this._heldType[hand] = grabType;
        this.held[hand] = interactable;
        this.lockHover(hand);

        const mesh = interactable.mesh;
        interactable._savedParent = mesh.parent;
        if (interactable.parentToHand) {
            // Parent to the VISUAL hand (the physics palm node), not the
            // raw grip: when the hand stops on a surface, the held item
            // stops with it instead of shearing away. The palm frame
            // tracks the grip pose (spring servo), so grip-space snap
            // poses transfer unchanged.
            const palmNode = this.ctx.physicsHands.hands[hand].palmNode;
            if (interactable.snapToPose) {
                mesh.parent = palmNode;
                mesh.position.copyFrom(interactable.snapToPose.position);
                if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new BABYLON.Quaternion();
                mesh.rotationQuaternion.copyFrom(interactable.snapToPose.rotation);
            } else {
                mesh.setParent(palmNode); // preserves world transform
            }
        }

        // Constrained mechanisms: pin the visual hand to the grab frame
        // (handpin.js) — the tracked controller becomes ghost input.
        if (interactable.pinHand) {
            this._pins[hand] = new HandPin(this.ctx, hand, mesh, interactable.pinHand);
            this.ctx.handPins[hand] = this._pins[hand];
        }

        // Curl-to-contact: clamp the visual fingers to the largest curl that
        // doesn't penetrate the held mesh. Falls back to the authored hold
        // pose if the clamp can't be computed (rig not loaded yet, etc.).
        let curled = false;
        if (interactable.curlToContact) {
            const clamp = handCtl.computeCurlClamp(mesh);
            if (clamp) {
                handCtl.curlClamp = clamp;
                curled = true;
                // Recompute once the palm has settled (see _settleCurlClamps).
                this._curlRecompute[hand] = { interactable, frames: 0 };
            }
        }
        if (interactable.holdPose && !curled) handCtl.setAuthoredPose(interactable.holdPose);
        this.ctx.feedback.haptic(hand, 0.6, 0.02);
        this.ctx.feedback.sound("grab");
        interactable.onGrab?.(hand, { grabType });
        return true;
    }

    release(hand) {
        const interactable = this.held[hand];
        if (!interactable) return null;
        const handCtl = this.ctx.hands.hands[hand];

        const mesh = interactable.mesh;
        if (interactable.parentToHand) {
            mesh.setParent(interactable._savedParent); // preserves world transform
        }
        if (this._pins[hand]) {
            if (this.ctx.handPins[hand] === this._pins[hand]) this.ctx.handPins[hand] = null;
            this._pins[hand] = null;
        }
        interactable.holders.delete(hand);
        if (interactable.heldBy === hand) {
            interactable.heldBy = interactable.holders.values().next().value ?? null;
        }
        const grabType = this._heldType[hand];
        this._heldType[hand] = null;
        if (!interactable.heldBy) interactable.grabType = null;
        this.held[hand] = null;
        this.unlockHover(hand);

        handCtl.curlClamp = null;
        if (interactable.holdPose) handCtl.clearAuthoredPose();
        this.ctx.feedback.haptic(hand, 0.3, 0.015);
        this.ctx.feedback.sound("release", { volume: 0.3 });
        interactable.onRelease?.(hand, {
            grabType,
            linearVelocity: handCtl.releaseLinearVelocity,
            angularVelocity: handCtl.releaseAngularVelocity,
        });
        return interactable;
    }

    // CURL_SETTLE_FRAMES after a curl-to-contact grab, recompute the clamp
    // against the settled palm position (still held, clamp still active).
    _settleCurlClamps() {
        for (const hand of ["left", "right"]) {
            const r = this._curlRecompute[hand];
            if (!r) continue;
            if (this.held[hand] !== r.interactable) { this._curlRecompute[hand] = null; continue; }
            if (++r.frames < CURL_SETTLE_FRAMES) continue;
            this._curlRecompute[hand] = null;
            const handCtl = this.ctx.hands.hands[hand];
            if (handCtl.curlClamp) {
                handCtl.curlClamp = handCtl.computeCurlClamp(r.interactable.mesh) ?? handCtl.curlClamp;
            }
        }
    }

    update(dt) {
        this._pollAccum += dt;
        if (this._pollAccum >= HOVER_POLL_INTERVAL) {
            this._pollAccum = 0;
            this._pollHover();
        }
        this._updateGrabIntent();
        this._settleCurlClamps();

        for (const hand of ["left", "right"]) {
            const handCtl = this.ctx.hands.hands[hand];
            const held = this.held[hand];

            if (!held) {
                const hovered = this.hover[hand];
                if (hovered) {
                    for (const type of hovered.grabTypes) {
                        if (handCtl.justPressed(GRAB_BUTTON[type])) {
                            this.grab(hand, hovered, type);
                            break;
                        }
                    }
                }
            } else {
                held.attachedUpdate?.(dt, hand);
                if (handCtl.justReleased(GRAB_BUTTON[this._heldType[hand]])) {
                    this.release(hand);
                }
            }
        }

        const d = this.ctx.debug;
        const hov = (hand) => this.hover[hand]
            ? `${this.hover[hand].mesh.name}(${this.hoverTier[hand]})` : "-";
        d.set("hover", `L:${hov("left")} R:${hov("right")}`);
        d.set("held", `L:${this.held.left?.mesh.name ?? "-"} R:${this.held.right?.mesh.name ?? "-"}`);
    }
}
