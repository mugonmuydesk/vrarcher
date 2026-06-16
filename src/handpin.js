// HandPin — slaves the visual hand to the grab point of whatever it holds.
//
// While something constrained is held, the tracked controller becomes a
// "ghost": pure input that mechanisms project onto their DOF (they keep
// reading ctx.hands.hands[hand].worldPosition as before). The VISIBLE
// hand is the output: pinned to the mechanism's grab frame with the
// hand→frame offset frozen at grab time, so it moves only as the
// mechanism allows and never drifts off the handle.
//
// The pin produces a target pose; handphysics.js feeds it to the palm
// servo in place of the tracked grip pose (ctx.handPins registry), so
// surface contact and press haptics keep working through the same spring.
//
// Rotation modes:
//   default            — hand rotation locked to the frame (frozen offset)
//   rollAxis: Vector3  — plus the ghost's twist about this ONE frame-local
//                        axis (e.g. a handle bar: wrist may roll around
//                        the bar but nothing else)
//   freeRotation: true — position pinned only; rotation follows the ghost
//                        (ball-style grips, e.g. the lamp head)
//
// The frame node's world matrix is read live each frame, so multi-DOF
// chains (door swing × handle twist) come for free from the node
// hierarchy. PORT: this is plain frame math — no engine physics involved.

export class HandPin {
    constructor(ctx, hand, frameNode, { rollAxis = null, freeRotation = false } = {}) {
        this.ctx = ctx;
        this.hand = hand;
        this.frame = frameNode;
        this.rollAxis = rollAxis ? rollAxis.clone().normalize() : null;
        this.freeRotation = freeRotation;

        const h = ctx.hands.hands[hand];
        frameNode.computeWorldMatrix(true);
        const inv = BABYLON.Matrix.Invert(frameNode.getWorldMatrix());
        this._offsetPos = BABYLON.Vector3.TransformCoordinates(h.worldPosition, inv);
        this._offsetRot = BABYLON.Quaternion.Inverse(
            frameNode.absoluteRotationQuaternion).multiply(h.worldRotation);
    }

    // World-space target pose for the visual hand this frame.
    pose() {
        this.frame.computeWorldMatrix(true);
        const wm = this.frame.getWorldMatrix();
        const position = BABYLON.Vector3.TransformCoordinates(this._offsetPos, wm);

        const ghost = this.ctx.hands.hands[this.hand].worldRotation;
        if (this.freeRotation) return { position, rotation: ghost.clone() };

        let rotation = this.frame.absoluteRotationQuaternion.multiply(this._offsetRot);
        if (this.rollAxis) {
            // Graft the ghost's twist about the (frame-local) roll axis
            // onto the frame-locked rotation: swing from the mechanism,
            // twist from the wrist. Twist extraction: project the relative
            // quaternion's vector part onto the axis, renormalise.
            const frameRot = this.frame.absoluteRotationQuaternion;
            const axisWorld = this.rollAxis.applyRotationQuaternion(frameRot);
            const aL = axisWorld.applyRotationQuaternion(BABYLON.Quaternion.Inverse(rotation));
            const rel = BABYLON.Quaternion.Inverse(rotation).multiply(ghost);
            const proj = rel.x * aL.x + rel.y * aL.y + rel.z * aL.z;
            const twist = new BABYLON.Quaternion(aL.x * proj, aL.y * proj, aL.z * proj, rel.w);
            const len = Math.sqrt(twist.x ** 2 + twist.y ** 2 + twist.z ** 2 + twist.w ** 2);
            if (len > 1e-4) {
                twist.scaleInPlace(1 / len);
                rotation = rotation.multiply(twist);
            }
        }
        return { position, rotation };
    }
}
