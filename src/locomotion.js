// Phase 9 — smooth joystick locomotion + smooth turning.
//
// Left thumbstick: head-relative smooth movement. Forward follows the
// gaze yaw (camera forward flattened to the horizontal), x strafes.
// Velocity eases toward the stick target (accel/decel ramp) and the
// horizontal position clamps to the ground mesh's bounding box (inset)
// so the player can't drift off the range.
//
// Right thumbstick x: continuous smooth yaw at TURN_SPEED deg/s. Babylon's
// WebXRCamera composes per-frame headset DELTAS into camera.position /
// rotationQuaternion, so mutating them moves/turns the rig — same
// mechanism the (disabled) teleportation feature uses. Yawing the
// quaternion in place turns the player about their own head.
//
// Gated while an arrow is nocked (ctx.arrows.nocked): the draw hand must
// never steer mid-shot; both sticks are ignored and velocity bleeds off.
// Teleportation stays disabled (scene.js) — this replaces it.

export const LOCO_TUNING = {
    maxSpeed: 2.5,        // m/s at full stick
    accelRate: 8,         // 1/s — velocity ease toward target
    decelRate: 12,        // 1/s — ease when stick released / gated
    deadZone: 0.15,
    turnSpeed: 90,        // deg/s at full deflection (smooth, no snap)
    turnDeadZone: 0.15,
    boundsInset: 0.3,     // m inside the ground's bounding box
};

export class Locomotion {
    constructor(ctx) {
        this.ctx = ctx;
        this.velocity = new BABYLON.Vector3();
        this.enabled = true;

        // Horizontal play-area bounds from the ground mesh.
        const bb = ctx.ground.getBoundingInfo().boundingBox;
        const inset = LOCO_TUNING.boundsInset;
        this.bounds = {
            minX: bb.minimumWorld.x + inset, maxX: bb.maximumWorld.x - inset,
            minZ: bb.minimumWorld.z + inset, maxZ: bb.maximumWorld.z - inset,
        };
    }

    get _camera() {
        return this.ctx.xr.baseExperience?.camera ?? null;
    }

    _gated() {
        return !this.enabled || !!this.ctx.arrows?.nocked;
    }

    update(dt) {
        if (this.ctx.xr.baseExperience?.state !== 2) return; // IN_XR only
        const camera = this._camera;
        if (!camera || dt <= 0) return;
        const T = LOCO_TUNING;
        const gated = this._gated();

        const dz = (v, zone) => Math.abs(v) < zone ? 0
            : Math.sign(v) * (Math.abs(v) - zone) / (1 - zone);

        // --- smooth yaw (right stick x) --------------------------------
        // The yaw must compose in the WORLD frame (premultiply): appending
        // it in the camera's local frame spins about the tilted head axis,
        // so a pitched/rolled head corkscrews the player upside down.
        // World-up yaws can never accumulate roll — the horizon stays put.
        const turn = gated ? 0 : dz(this.ctx.hands.hands.right.thumbstick.x, T.turnDeadZone);
        if (turn !== 0) {
            const yaw = turn * T.turnSpeed * Math.PI / 180 * dt;
            BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), yaw)
                .multiplyToRef(camera.rotationQuaternion, camera.rotationQuaternion);
        }

        // --- smooth move (left stick) -----------------------------------
        // XR stick convention: pushing forward reads y = -1.
        const stick = this.ctx.hands.hands.left.thumbstick;
        const sx = gated ? 0 : dz(stick.x, T.deadZone);
        const sy = gated ? 0 : dz(-stick.y, T.deadZone);

        // Gaze-yaw frame: camera forward/right flattened to horizontal.
        const fwd = camera.getDirection(BABYLON.Vector3.Forward());
        fwd.y = 0;
        if (fwd.lengthSquared() < 1e-4) fwd.set(0, 0, 1); // looking straight down
        fwd.normalize();
        const right = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), fwd);

        const target = fwd.scale(sy).addInPlace(right.scale(sx));
        if (target.lengthSquared() > 1) target.normalize();
        target.scaleInPlace(T.maxSpeed);

        const rate = target.lengthSquared() > this.velocity.lengthSquared()
            ? T.accelRate : T.decelRate;
        const k = Math.min(1, rate * dt);
        this.velocity.addInPlace(target.subtract(this.velocity).scaleInPlace(k));
        if (this.velocity.lengthSquared() < 1e-6) this.velocity.setAll(0);

        if (this.velocity.lengthSquared() > 0) {
            camera.position.x = Math.min(this.bounds.maxX, Math.max(this.bounds.minX,
                camera.position.x + this.velocity.x * dt));
            camera.position.z = Math.min(this.bounds.maxZ, Math.max(this.bounds.minZ,
                camera.position.z + this.velocity.z * dt));
        }

        if (turn !== 0 || this.velocity.lengthSquared() > 0) {
            this.ctx.debug.set("loco",
                `v=${this.velocity.length().toFixed(2)} m/s turn=${turn.toFixed(2)}${gated ? " GATED" : ""}`);
        }
    }
}
