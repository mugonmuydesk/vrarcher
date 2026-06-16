// Drives demo: circular crank (raises/lowers the target) + linear slider.
//  1. Crank direct mode: 1.5-turn counter-crank lowers the target part-way;
//     continuing past the min clamps at 0 (target fully lowered).
//  2. Freeze-at-limit: a 0.1 rad back-off does nothing (inside the 0.15
//     tolerance); a further 0.5 rad unfreezes and raises the angle.
//  3. Physics mode: spin and release -> momentum carries the angle on, then
//     friction bleeds it off.
//  4. Slider: grab, value tracks the projected hand (0.75), clamps at 1.0
//     past the rail end; fast release carries momentum that dampens out.
//
// Crank centre Babylon (-0.85, 1.05, 0.7), arm 0.12; angle starts at max
// 2.5π (arm up, value 1, target y 1.4). Slider rail x 0.1->0.6 at y 1.02,
// z 0.85 (Babylon).

export async function run(rig, ctx) {
    const crank = ctx.crank, slider = ctx.slider;
    if (!crank || !slider) { rig.mark("FAIL: drives missing"); return; }
    const MAXA = crank.limits[1];

    // XR pose for a hand on the crank circle at plane angle theta.
    const C = [-0.85, 1.05, -0.645]; // XR; z at the handle's grab plane
    const onCrank = (theta) => [
        C[0] + crank.armLength * Math.cos(theta),
        C[1] + crank.armLength * Math.sin(theta),
        C[2]];

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. direct crank lowers the target ---------------------------
        r.mark("target y start", ctx.target.root.position.y.toFixed(2));
        r.mark("assert target raised", Math.abs(ctx.target.root.position.y - 1.4) < 0.01
            ? "PASS" : "FAIL");

        // Grab the handle (arm points up at max angle).
        const hp = crank.handle.getAbsolutePosition();
        await r.moveHand("right", [hp.x, hp.y, -hp.z], { over: 0.7 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("assert crank held", crank.interactable.heldBy === "right" ? "PASS" : "FAIL");

        // Counter-crank 1.5 turns: angle 2.5π -> π, value 0.4, y 0.92.
        let theta = Math.PI / 2;
        await r.tween(2.0, t => r.poseHand("right", onCrank(theta - 1.5 * Math.PI * t)));
        await r.wait(0.3);
        r.mark("crank angle", `${crank.angle.toFixed(2)} value=${crank.value.toFixed(2)} y=${ctx.target.root.position.y.toFixed(2)}`);
        r.mark("assert crank tracked", (Math.abs(crank.angle - Math.PI) < 0.2
            && Math.abs(ctx.target.root.position.y - 0.92) < 0.08) ? "PASS" : "FAIL");
        r.mark("screenshot:crank-mid");

        // Keep cranking past the min: clamps at 0, target fully lowered.
        theta -= 1.5 * Math.PI;
        await r.tween(1.6, t => r.poseHand("right", onCrank(theta - 1.5 * Math.PI * t)));
        await r.wait(0.3);
        r.mark("assert clamped at min", (crank.angle === 0
            && Math.abs(ctx.target.root.position.y - 0.6) < 0.02)
            ? "PASS" : `FAIL a=${crank.angle.toFixed(2)} y=${ctx.target.root.position.y.toFixed(2)}`);

        // --- 2. freeze-at-limit back-off ----------------------------------
        theta -= 1.5 * Math.PI;
        await r.tween(0.4, t => r.poseHand("right", onCrank(theta + 0.1 * t)));
        await r.wait(0.2);
        r.mark("assert frozen inside tolerance", crank.angle === 0
            ? "PASS" : `FAIL a=${crank.angle.toFixed(3)}`);
        await r.tween(0.6, t => r.poseHand("right", onCrank(theta + 0.1 + 0.5 * t)));
        await r.wait(0.2);
        r.mark("assert unfroze past tolerance", crank.angle > 0.2
            ? "PASS" : `FAIL a=${crank.angle.toFixed(3)}`);
        await r.rampButton("right", "grip", 1, 0, 0.15);
        await r.wait(0.3);

        // --- 3. physics mode momentum --------------------------------------
        crank.mode = "physics";
        const hp2 = crank.handle.getAbsolutePosition();
        await r.moveHand("right", [hp2.x, hp2.y, -hp2.z], { over: 0.6 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        theta = Math.atan2(hp2.y - 1.05, hp2.x + 0.85);
        // Fast half-turn spin, release mid-motion.
        const spin = r.tween(0.45, t => r.poseHand("right", onCrank(theta + Math.PI * t)), false);
        await r.wait(0.32);
        r.setGrip("right", 0);
        await spin;
        const aRelease = crank.angle;
        await r.wait(0.5);
        const aCoast = crank.angle;
        await r.wait(1.5);
        const aSettle = crank.angle;
        r.mark("physics coast", `release=${aRelease.toFixed(2)} +0.5s=${aCoast.toFixed(2)} +2s=${aSettle.toFixed(2)}`);
        r.mark("assert momentum carried", (aCoast - aRelease) > 0.1 ? "PASS" : "FAIL");
        r.mark("assert friction bleeds", (aSettle - aCoast) < (aCoast - aRelease) * 1.5
            ? "PASS" : "FAIL");

        // Restore the range: direct mode, target raised.
        crank.mode = "direct";
        crank.omega = 0;
        crank.setAngle(MAXA);

        // --- 4. linear slider ----------------------------------------------
        const kp = slider.knob.getAbsolutePosition();
        await r.moveHand("right", [kp.x, kp.y, -kp.z], { over: 0.7 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("assert slider held", slider.interactable.heldBy === "right" ? "PASS" : "FAIL");

        await r.moveHand("right", [0.475, 1.02, -0.85], { over: 0.7 });
        await r.wait(0.2);
        r.mark("slider value", slider.value.toFixed(3));
        r.mark("assert slider tracks", Math.abs(slider.value - 0.75) < 0.05 ? "PASS" : "FAIL");

        await r.moveHand("right", [0.85, 1.02, -0.85], { over: 0.5 });
        await r.wait(0.2);
        r.mark("assert slider clamps", slider.value === 1 ? "PASS" : `FAIL v=${slider.value.toFixed(2)}`);
        r.mark("screenshot:slider-max");

        // Momentum: re-enter the rail (value unpins from the clamp), then
        // sweep back fast and release mid-sweep while the value is moving.
        await r.moveHand("right", [0.6, 1.02, -0.85], { over: 0.3 });
        await r.wait(0.15);
        const sweep = r.moveHand("right", [0.25, 1.02, -0.85], { over: 0.5, ease: false });
        await r.wait(0.3);
        r.setGrip("right", 0);
        await sweep;
        const vRelease = slider.value;
        await r.wait(0.4);
        const vCoast = slider.value;
        await r.wait(0.8);
        const vSettle = slider.value;
        r.mark("slider coast", `release=${vRelease.toFixed(2)} +0.4s=${vCoast.toFixed(2)} +1.2s=${vSettle.toFixed(2)}`);
        r.mark("assert slider momentum", (vRelease - vCoast) > 0.03 ? "PASS" : "FAIL");
        r.mark("assert slider dampens", Math.abs(vSettle - vCoast) < 0.05 && vSettle > 0.02
            ? "PASS" : "FAIL");
    });
}
