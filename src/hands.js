// Hand state + pose system (Phase 1).
//
// One HandController per XR input source:
//   - per-frame grip / trigger / thumbstick values + press edges
//   - world grip pose
//   - velocity ring buffer recorded at END of frame (onAfterRender), with
//     linear = 5-frame average, angular = 11-frame quaternion-delta average
//     (per spec); release velocity = linear × 1.1
//   - pose layering on the skinned hand rig
//
// Pose rules (learned the hard way): animate ONLY by scrubbing paused clips
// with goToFrame. Never loop the ~0.25 s transition clips and never
// weight-blend paused groups (paused animatables hold their last output and
// ignore weight changes).
//
// Layering: three per-finger-group scrub layers built from bone SUBSETS of
// the Fist clip — grip drives the lower three fingers, trigger drives the
// index, thumb-touch drives the thumb. An optional authored full-hand pose
// (e.g. "Hold" while gripping an item) sits on top: while active it is
// scrubbed AFTER the finger groups each frame, so its write wins. "Blend"
// in/out is a timed scrub of the authored clip itself (0.1 s in / 0.2 s
// out), entered at a frame matching the current curl so the hand doesn't
// pop open first.

const HAND_FILES = { left: "leftHandLow.glb", right: "rightHandLow.glb" };

// Hand-mesh attach transform under the XR grip node (Babylon grip-local).
// Derived by least-squares fitting the GLB rig's rest bones (wrist + four
// knuckles + thumb metacarpal) onto the IWE emulator's hand-tracking joint
// poses, which are authored directly in grip space (IWE webxr-polyfill.js
// relaxedHandPose: out = gripMatrix * jointMatrix). Ground truth therefore
// matches what the emulator (and Quest runtime) render in hand mode:
// fingers run along grip -Y, palm faces the grip axis (left +X / right -X),
// thumb toward controller-forward. The values REPLACE the glTF loader's
// baked 180° Y root rotation (scaling (1,1,-1) is kept — it's the RH->LH
// geometry conversion). Left is the exact X-mirror of right.
// PORT: in Unity, parent the hand model under the XRController grip pose
// with this same local pose (mirror z-handedness).
const HAND_ATTACH = {
    right: {
        position: new BABYLON.Vector3(0.0185, -0.0211, -0.0120),
        rotation: new BABYLON.Quaternion(0.6577, 0.3871, -0.4323, 0.4804).normalize(),
    },
    left: {
        position: new BABYLON.Vector3(-0.0185, -0.0211, -0.0120),
        rotation: new BABYLON.Quaternion(0.6577, -0.3871, 0.4323, 0.4804).normalize(),
    },
};

// Pitch trim applied on top of HAND_ATTACH, about grip +X (user-tuned).
// +75° tilts the fingers from the forward (-Y) direction toward the
// thumb/+Z axis — "anticlockwise" in a side view with forward to the
// right; negate HAND_PITCH to tilt the other way. About-X rotations
// commute with the right-hand X-mirror, so one value serves both hands.
// Exported: handphysics.js authors its collider boxes in the unpitched
// frame and rotates them back, keeping the AABB fit tight.
const HAND_PITCH = 75 * Math.PI / 180; // rad
export const HAND_PITCH_Q = new BABYLON.Quaternion(
    -Math.sin(HAND_PITCH / 2), 0, 0, Math.cos(HAND_PITCH / 2));

// Bone name prefixes per scrub group. Rig bones: F1..F4 (a/b/c joints),
// T (thumb), Palm. F1 = index … F4 = pinky (verified visually: scrubbing
// the F1 subset curls the index finger).
const FINGER_GROUPS = {
    lower: ["F2", "F3", "F4", "Palm"],
    index: ["F1"],
    thumb: ["T"],
};

// Curl-to-contact LUT: per finger group, joint + fingertip sample points
// recorded at CURL_LUT_SAMPLES scrub fractions of the Fist clip, in hand-
// root local space. At grab time the largest contact-free curl per group
// becomes a clamp, so fingers wrap a held object and stop on its surface.
const CURL_LUT_SAMPLES = 11;
const CURL_TIP_EXTEND = 0.8;  // fingertip pad = last joint + 0.8 × last bone segment
const CURL_BLEND_RATE = 15;   // 1/s — visual ease into/out of the clamp

const RELEASE_VELOCITY_SCALE = 1.1;
const MAX_ANGULAR_VELOCITY = 50; // rad/s (spec)
const LINEAR_AVG_FRAMES = 5;
const ANGULAR_AVG_FRAMES = 11;
const POSE_BLEND_IN = 0.1;   // s
const POSE_BLEND_OUT = 0.2;  // s
const INPUT_SMOOTH_RATE = 20; // 1/s exponential smoothing for visuals

// ---------------------------------------------------------------------------

class VelocityEstimator {
    constructor(capacity = ANGULAR_AVG_FRAMES + 2) {
        this.capacity = capacity;
        this.samples = []; // { p: Vector3, q: Quaternion, dt }
    }

    record(position, rotation, dt) {
        if (dt <= 0) return;
        this.samples.push({ p: position.clone(), q: rotation.clone(), dt });
        if (this.samples.length > this.capacity) this.samples.shift();
    }

    reset() { this.samples.length = 0; }

    linearVelocity(frames = LINEAR_AVG_FRAMES) {
        const s = this.samples;
        const k = Math.min(frames, s.length - 1);
        if (k < 1) return BABYLON.Vector3.Zero();
        const a = s[s.length - 1 - k], b = s[s.length - 1];
        let time = 0;
        for (let i = s.length - k; i < s.length; i++) time += s[i].dt;
        return b.p.subtract(a.p).scaleInPlace(1 / time);
    }

    angularVelocity(frames = ANGULAR_AVG_FRAMES) {
        const s = this.samples;
        const k = Math.min(frames, s.length - 1);
        if (k < 1) return BABYLON.Vector3.Zero();
        const sum = BABYLON.Vector3.Zero();
        for (let i = s.length - k; i < s.length; i++) {
            const q0 = s[i - 1].q, q1 = s[i].q;
            let dq = q1.multiply(BABYLON.Quaternion.Inverse(q0));
            if (dq.w < 0) dq.scaleInPlace(-1); // shortest path
            const w = Math.min(1, Math.max(-1, dq.w));
            const angle = 2 * Math.acos(w);
            if (angle > 1e-6) {
                const sinHalf = Math.sqrt(1 - w * w);
                const scale = angle / sinHalf / s[i].dt;
                sum.addInPlaceFromFloats(dq.x * scale, dq.y * scale, dq.z * scale);
            }
        }
        sum.scaleInPlace(1 / k);
        const len = sum.length();
        if (len > MAX_ANGULAR_VELOCITY) sum.scaleInPlace(MAX_ANGULAR_VELOCITY / len);
        return sum;
    }
}

// ---------------------------------------------------------------------------

// Owns the skinned mesh + scrub layers for one hand.
class PoseRig {
    constructor(scene, root, animationGroups) {
        this.scene = scene;
        this.root = root;
        this.clips = {};
        for (const g of animationGroups) {
            g.stop();
            this.clips[g.name] = g;
        }

        // Per-finger-group subset layers from the Fist clip.
        this.fingerLayers = {};
        const fist = this.clips["Fist"];
        if (fist) {
            for (const [group, prefixes] of Object.entries(FINGER_GROUPS)) {
                this.fingerLayers[group] = this._makeSubset(`${root.name}-${group}`, fist, prefixes);
            }
        }

        // Authored full-hand pose layer (lazy per clip). t chases target at
        // the blend-in/out rates; the layer is removed once target 0 is
        // reached (handing off to the finger layers without a pop).
        this.authored = null; // { name, group, t (0..1), target (0..1) }
        this._authoredStarted = {};
    }

    _makeSubset(name, sourceGroup, prefixes) {
        const g = new BABYLON.AnimationGroup(name, this.scene);
        for (const ta of sourceGroup.targetedAnimations) {
            if (prefixes.some(p => ta.target.name.startsWith(p))) {
                g.addTargetedAnimation(ta.animation, ta.target);
            }
        }
        g.start(false);
        g.pause();
        return g;
    }

    _scrub(group, t) {
        group.goToFrame(group.from + Math.min(1, Math.max(0, t)) * (group.to - group.from));
    }

    // values: { lower, index, thumb } each 0..1
    applyFingers(values) {
        for (const [name, layer] of Object.entries(this.fingerLayers)) {
            this._scrub(layer, values[name] ?? 0);
        }
    }

    // Authored pose API (grab/nock poses).
    // entry: starting scrub fraction so the hand doesn't pop open first.
    setAuthoredPose(clipName, entry = 0) {
        return this._setAuthored(clipName, 1, entry);
    }

    // Factor-driven variant (e.g. nock pinch blends by approach proximity):
    // t eases toward `target` each frame instead of all the way to 1.
    setAuthoredTarget(clipName, target) {
        if (target <= 0 && this.authored?.name !== clipName) return false;
        return this._setAuthored(clipName, target, 0);
    }

    _setAuthored(clipName, target, entry) {
        const clip = this.clips[clipName];
        if (!clip) return false;
        if (!this._authoredStarted[clipName]) {
            clip.start(false);
            clip.pause();
            this._authoredStarted[clipName] = true;
        }
        if (this.authored?.name === clipName) {
            this.authored.target = target;
        } else {
            this.authored = { name: clipName, group: clip, t: Math.max(entry, this.authored?.t ?? 0), target };
        }
        return true;
    }

    clearAuthoredPose() {
        if (this.authored) this.authored.target = 0;
    }

    // Sample finger-joint + fingertip positions across the Fist clip's curl
    // range, in skinned-mesh LOCAL space (stable under any grip/palm
    // motion). The same mesh's world matrix maps them back at query time.
    // NB the glTF skeleton drives its bones through LINKED TRANSFORM NODES
    // which only sync into Bone matrices during render — so sample the
    // animation TARGET nodes directly (force-computing their world
    // matrices), never skeleton.bones (stale until the next frame; cost a
    // debugging round in-emulator). ~33 scrubs at load, no rendering needed.
    buildCurlLUT(skinned) {
        const byName = {};
        for (const layer of Object.values(this.fingerLayers)) {
            for (const ta of layer.targetedAnimations) byName[ta.target.name] = ta.target;
        }
        // [base, last] node of each chain; tip = last + CURL_TIP_EXTEND × segment.
        const chains = {
            lower: [["F2b", "F2c"], ["F3b", "F3c"], ["F4b", "F4c"]],
            index: [["F1b", "F1c"]],
            thumb: [["Tb", "Tc"]],
        };
        skinned.computeWorldMatrix(true);
        const invRoot = BABYLON.Matrix.Invert(skinned.getWorldMatrix());
        this._lutMesh = skinned;
        const nodePos = (name) => {
            const n = byName[name];
            if (!n) return null;
            n.computeWorldMatrix(true);
            return n.getAbsolutePosition().clone();
        };
        const lut = { lower: [], index: [], thumb: [] };
        for (let i = 0; i < CURL_LUT_SAMPLES; i++) {
            const t = i / (CURL_LUT_SAMPLES - 1);
            for (const layer of Object.values(this.fingerLayers)) this._scrub(layer, t);
            for (const [group, pairs] of Object.entries(chains)) {
                const points = [];
                for (const [bName, cName] of pairs) {
                    const b = nodePos(bName), c = nodePos(cName);
                    if (!b || !c) continue;
                    const tip = c.add(c.subtract(b).scaleInPlace(CURL_TIP_EXTEND));
                    for (const p of [b, c, tip]) {
                        points.push(BABYLON.Vector3.TransformCoordinates(p, invRoot));
                    }
                }
                lut[group].push({ t, points });
            }
        }
        for (const layer of Object.values(this.fingerLayers)) this._scrub(layer, 0);
        this.curlLUT = lut;
    }

    // Called every frame AFTER applyFingers so an active authored pose wins.
    updateAuthored(dt, exitCurl = 0) {
        const a = this.authored;
        if (!a) return;
        if (a.t < a.target) a.t = Math.min(a.target, a.t + dt / POSE_BLEND_IN);
        else if (a.t > a.target) a.t = Math.max(a.target, a.t - dt / POSE_BLEND_OUT);
        if (a.target <= 0 && a.t <= Math.max(exitCurl, 0)) {
            // Blended back down to the live curl level — hand off to the
            // finger layers without a pop.
            this.authored = null;
            return;
        }
        this._scrub(a.group, a.t);
    }
}

// ---------------------------------------------------------------------------

export class HandController {
    constructor(ctx, handedness) {
        this.ctx = ctx;
        this.handedness = handedness;
        this.rig = null;            // PoseRig once the GLB lands
        this.controller = null;     // refreshed every frame (poll, don't cache)

        // Raw per-frame input values.
        this.grip = 0;
        this.trigger = 0;
        this.thumbstick = { x: 0, y: 0 };
        this.thumbTouched = false;
        this._prev = { grip: 0, trigger: 0 };
        this._smooth = { grip: 0, trigger: 0, thumb: 0 };

        this.velocity = new VelocityEstimator();
        this.tracking = false;

        // Curl-to-contact: while set ({lower,index,thumb} 0..1), the visual
        // fingers ease to these values instead of following the buttons.
        this.curlClamp = null;
        this._fingers = { lower: 0, index: 0, thumb: 0 };
    }

    // Per finger group, the largest LUT curl whose sample points all stay
    // outside `targetMesh` (bounding sphere + OBB test). null until the
    // rig + LUT are ready or if the mesh has no bounding info.
    computeCurlClamp(targetMesh) {
        const lut = this.rig?.curlLUT;
        if (!lut || typeof targetMesh.getBoundingInfo !== "function") return null;
        const lutMesh = this.rig._lutMesh;
        lutMesh.computeWorldMatrix(true);
        const rootM = lutMesh.getWorldMatrix();
        targetMesh.computeWorldMatrix(true);
        const bi = targetMesh.getBoundingInfo();
        const clamp = {};
        for (const [group, rows] of Object.entries(lut)) {
            let free = 0;
            for (const row of rows) {
                const hit = row.points.some(p =>
                    bi.intersectsPoint(BABYLON.Vector3.TransformCoordinates(p, rootM)));
                if (hit) break;
                free = row.t;
            }
            clamp[group] = free;
        }
        return clamp;
    }

    // --- input edges (Phase 2 grab logic uses these) ---
    justPressed(button, threshold = 0.7) {
        return this[button] >= threshold && this._prev[button] < threshold;
    }
    justReleased(button, threshold = 0.3) {
        return this[button] <= threshold && this._prev[button] > threshold;
    }

    get gripNode() {
        return this.controller?.grip || this.controller?.pointer || null;
    }

    get worldPosition() {
        return this.gripNode ? this.gripNode.absolutePosition : BABYLON.Vector3.Zero();
    }

    get worldRotation() {
        const n = this.gripNode;
        return n?.absoluteRotationQuaternion ?? BABYLON.Quaternion.Identity();
    }

    // Controller-tip probe (hover tier 2): the pointer/aim pose origin sits
    // at the controller's front; fall back to the grip.
    get tipPoint() {
        const n = this.controller?.pointer || this.gripNode;
        return n ? n.absolutePosition : null;
    }

    // Index-fingertip probe (hover tier 3 + fingertip buttons): the last
    // index bone of the skinned rig, extended half a joint length so the
    // point sits at the pad rather than the last knuckle. Tracks the live
    // trigger curl. Fallback before the GLB lands: a fixed offset ahead of
    // the grip.
    get fingertipPoint() {
        const tip = this._indexTip;
        if (tip) {
            const p = tip.bone.getAbsolutePosition(tip.mesh);
            const prev = tip.bone.getParent()?.getAbsolutePosition(tip.mesh);
            if (prev) p.addInPlace(p.subtract(prev).scaleInPlace(0.5));
            return p;
        }
        const n = this.gripNode;
        if (!n) return null;
        return n.absolutePosition.add(n.forward.scale(0.08));
    }

    get linearVelocity() { return this.velocity.linearVelocity(); }
    get angularVelocity() { return this.velocity.angularVelocity(); }
    // Velocity to hand to a released object (spec: hand velocity × 1.1).
    get releaseLinearVelocity() { return this.linearVelocity.scale(RELEASE_VELOCITY_SCALE); }
    get releaseAngularVelocity() { return this.angularVelocity; }

    setAuthoredPose(name) {
        // Enter at the current dominant curl so fingers don't pop open.
        const entry = Math.max(this._smooth.grip, this._smooth.trigger);
        return this.rig?.setAuthoredPose(name, entry) ?? false;
    }
    setAuthoredPoseTarget(name, target) {
        return this.rig?.setAuthoredTarget(name, target) ?? false;
    }
    clearAuthoredPose() { this.rig?.clearAuthoredPose(); }

    _readInputs(motionController) {
        this._prev.grip = this.grip;
        this._prev.trigger = this.trigger;

        const squeeze = motionController.getComponent("xr-standard-squeeze")
            || motionController.getComponentOfType("squeeze");
        const trigger = motionController.getComponent("xr-standard-trigger")
            || motionController.getComponentOfType("trigger");
        const stick = motionController.getComponent("xr-standard-thumbstick")
            || motionController.getComponentOfType("thumbstick");

        this.grip = squeeze?.value ?? 0;
        this.trigger = trigger?.value ?? 0;
        if (stick?.axes) this.thumbstick = { x: stick.axes.x, y: stick.axes.y };

        // Thumb rests on any touched top-face control.
        this.thumbTouched = ["xr-standard-thumbstick", "xr-standard-touchpad",
            "a-button", "b-button", "x-button", "y-button"]
            .some(id => motionController.getComponent(id)?.touched);
    }

    update(dt) {
        const mc = this.controller?.motionController;
        this.tracking = !!(this.controller && this.gripNode);
        if (!mc || !this.tracking) return;

        this._readInputs(mc);

        // Exponentially smoothed values drive the visuals only; raw values
        // stay available for game logic.
        const alpha = 1 - Math.exp(-INPUT_SMOOTH_RATE * dt);
        this._smooth.grip += (this.grip - this._smooth.grip) * alpha;
        this._smooth.trigger += (this.trigger - this._smooth.trigger) * alpha;
        this._smooth.thumb += ((this.thumbTouched ? 1 : 0) - this._smooth.thumb) * alpha;

        if (this.rig) {
            // Curl clamp (curl-to-contact) overrides the button-driven curl
            // while an object is held; ease between the two so neither the
            // grab nor the release pops.
            const want = this.curlClamp ?? {
                lower: this._smooth.grip,
                index: this._smooth.trigger,
                thumb: this._smooth.thumb,
            };
            const blend = 1 - Math.exp(-CURL_BLEND_RATE * dt);
            for (const k of ["lower", "index", "thumb"]) {
                this._fingers[k] += (want[k] - this._fingers[k]) * blend;
            }
            this.rig.applyFingers(this._fingers);
            this.rig.updateAuthored(dt, Math.max(this._smooth.grip, this._smooth.trigger));
        }
    }

    // Ring buffer records at end of frame (after XR poses + render).
    recordFrame(dt) {
        if (this.tracking) {
            this.velocity.record(this.worldPosition, this.worldRotation, dt);
        } else {
            this.velocity.reset();
        }
    }
}

// ---------------------------------------------------------------------------

export class HandSystem {
    constructor(ctx) {
        this.ctx = ctx;
        this.hands = {
            left: new HandController(ctx, "left"),
            right: new HandController(ctx, "right"),
        };
        this._loading = {};

        // Mesh loading reacts to controller-added (fires once per device);
        // everything per-frame polls xr.input.controllers instead — the
        // emulator's add/remove observables have race conditions
        // (BabylonHands lessons_learned.md).
        ctx.xr.input.onControllerAddedObservable.add((controller) => {
            controller.onMotionControllerInitObservable.add((mc) => {
                if (HAND_FILES[mc.handedness]) this._loadHand(mc.handedness, controller);
            });
        });

    }

    // End-of-frame velocity sampling — main.js calls this AFTER
    // scene.render() so the ring buffer sees the final frame transforms.
    recordFrame(dt) {
        this.hands.left.recordFrame(dt);
        this.hands.right.recordFrame(dt);
    }

    async _loadHand(handedness, controller) {
        if (this._loading[handedness]) return;
        this._loading[handedness] = true;

        const result = await BABYLON.SceneLoader.ImportMeshAsync(
            null, "hands/", HAND_FILES[handedness], this.ctx.scene);
        const root = result.meshes[0];
        root.name = handedness + "-hand";
        root.parent = controller.grip || controller.pointer;
        // Replace the loader's baked 180° Y root rotation with the grip-
        // space attach pose derived from the IWE hand-tracking joint data
        // (see HAND_ATTACH above). Keep the loader's (1,1,-1) scaling.
        const attach = HAND_ATTACH[handedness];
        root.position.copyFrom(attach.position);
        // Pitch trim premultiplied: applied in grip space after the attach
        // pose, pivoting at the attach point (position stays unrotated).
        root.rotationQuaternion = HAND_PITCH_Q.multiply(attach.rotation);

        // The cuff vertices in these GLBs have zero skin weights; three.js
        // tolerates that but Babylon's shader collapses them to NDC origin.
        // Reassign them to bone 0.
        result.meshes.forEach(m => { if (m.skeleton) m.cleanMatrixWeights(); });

        const rig = new PoseRig(this.ctx.scene, root, result.animationGroups);
        this.hands[handedness].rig = rig;

        // Index fingertip = deepest F1 bone (F1a→F1b→F1c; name-sorted last)
        // — drives the fingertip hover/press probe.
        const skinned = result.meshes.find(m => m.skeleton);
        if (skinned) {
            const indexBones = skinned.skeleton.bones
                .filter(b => b.name.startsWith("F1"))
                .sort((a, b) => a.name.localeCompare(b.name));
            const bone = indexBones.at(-1);
            if (bone) this.hands[handedness]._indexTip = { bone, mesh: skinned };
            this.hands[handedness]._skinned = skinned;
            rig.buildCurlLUT(skinned); // curl-to-contact samples
        }
        console.log(`${handedness} hand ready; clips: ${result.animationGroups.map(g => g.name).join(", ")}`
            + `; indexTip: ${this.hands[handedness]._indexTip?.bone.name ?? "fallback"}`);
    }

    update(dt) {
        // Poll fresh every frame; controller references can go stale.
        this.hands.left.controller = null;
        this.hands.right.controller = null;
        for (const c of this.ctx.xr.input.controllers) {
            const h = c.inputSource?.handedness;
            if (this.hands[h]) this.hands[h].controller = c;
        }
        this.hands.left.update(dt);
        this.hands.right.update(dt);

        const d = this.ctx.debug;
        for (const hand of ["left", "right"]) {
            const h = this.hands[hand];
            if (!h.tracking) continue;
            d.set(`${hand} grip/trig`, `${h.grip.toFixed(2)} / ${h.trigger.toFixed(2)}`);
            d.set(`${hand} vel`, `${h.linearVelocity.length().toFixed(2)} m/s, ${h.angularVelocity.length().toFixed(1)} rad/s`);
        }
    }
}
