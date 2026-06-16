// Phase 1 demo: velocity estimator validation + per-finger-group scrubbing
// + authored pose blend.
//
// Velocity checks use LINEAR tweens (constant speed) and sample the
// estimator mid-motion. Expected linear speed = distance / duration;
// expected angular speed = angle / duration.

import { quatAxisAngle, quatMul } from "../rigctl.js";

export async function run(rig, ctx) {
    const right = () => ctx.hands.hands.right;

    await rig.run(async (r) => {
        r.reset();
        await r.wait(0.8);

        // --- linear velocity: 0.4 m in 1.0 s => expect ~0.40 m/s ---
        const from = [0.25, 1.4, -0.55];
        const to = [0.25, 1.4, -0.95];
        r.poseHand("right", from);
        await r.wait(0.3);
        let sampled = 0;
        const sampler = setInterval(() => {
            const v = right()?.linearVelocity.length() ?? 0;
            sampled = Math.max(sampled, v);
        }, 100);
        await r.moveHand("right", to, { over: 1.0, ease: false });
        clearInterval(sampler);
        r.mark("linvel: expected≈0.40 m/s, peak measured=", sampled.toFixed(3));

        // --- angular velocity: 90° about Y in 1.0 s => expect ~1.57 rad/s ---
        await r.wait(0.5);
        const q0 = r.state.right.quaternion;
        const q1 = quatMul(quatAxisAngle([0, 1, 0], 90), q0);
        let sampledAng = 0;
        const angSampler = setInterval(() => {
            const w = right()?.angularVelocity.length() ?? 0;
            sampledAng = Math.max(sampledAng, w);
        }, 100);
        await r.moveHand("right", to, { over: 1.0, quat: q1, ease: false });
        clearInterval(angSampler);
        r.mark("angvel: expected≈1.57 rad/s, peak measured=", sampledAng.toFixed(3));

        // --- release velocity scale ×1.1 ---
        const lv = right().linearVelocity.length();
        const rv = right().releaseLinearVelocity.length();
        r.mark("release scale: ", (rv / (lv || 1)).toFixed(3));

        // --- per-finger-group scrubbing ---
        r.reset();
        await r.wait(0.5);
        r.mark("fingers:trigger-only (index should curl)");
        await r.rampButton("right", "trigger", 0, 1, 0.4);
        await r.wait(0.6);
        r.mark("screenshot:index-curl");
        await r.wait(1.5);

        r.mark("fingers:grip-only (lower three should curl)");
        await r.rampButton("right", "trigger", 1, 0, 0.3);
        await r.rampButton("right", "grip", 0, 1, 0.4);
        await r.wait(0.6);
        r.mark("screenshot:lower-curl");
        await r.wait(1.5);

        // --- thumb scrub via direct rig API (emulator has no touch inject).
        // Detach the rig first or the per-frame input update stomps the call.
        r.mark("fingers:thumb via rig API");
        const rig = right().rig;
        right().rig = null;
        rig.applyFingers({ lower: 0, index: 0, thumb: 1 });
        await r.wait(0.1);
        r.mark("screenshot:thumb-curl");
        await r.wait(1.5);
        right().rig = rig;

        // --- authored pose blend in/out ---
        await r.rampButton("right", "grip", 1, 0, 0.3);
        await r.wait(0.3);
        r.mark("authored:set Hold");
        right().setAuthoredPose("Hold");
        await r.wait(0.5);
        r.mark("screenshot:hold-pose");
        await r.wait(1.5);
        right().clearAuthoredPose();
        await r.wait(0.5);
        r.mark("authored:cleared");
    });
}
