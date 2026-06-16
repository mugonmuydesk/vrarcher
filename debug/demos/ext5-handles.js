// Constrained-handle demo: joystick + IK desk lamp.
//  1. Joystick: deflect 0.07 m -> axes ~0.7; 0.15 m -> clamped 1.0;
//     release -> recenters within ~0.1 s; stray >0.3 m -> auto-detach
//     WITHOUT releasing the grip button.
//  2. IK arm: grab the lamp head, drag -> effector settles on the hand
//     (goal smoothing 4.0), segment lengths stay rigid (FABRIK); yank the
//     hand 0.5 m fast -> effector lags >0.3 m -> auto-detach.
//
// Joystick knob rest: Babylon (0, 1.11, 1.15). Lamp base (-0.45,0.75,0.95).

export async function run(rig, ctx) {
    const joy = ctx.joystick, arm = ctx.ikarm;
    if (!joy || !arm) { rig.mark("FAIL: handles missing"); return; }
    const right = ctx.hands.hands.right;
    const toXR = (v) => [v.x, v.y, -v.z];

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. joystick ---------------------------------------------------
        const rest = joy.knob.getAbsolutePosition().clone();
        await r.moveHand("right", toXR(rest), { over: 0.7 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("assert joystick held", joy.interactable.heldBy === "right" ? "PASS" : "FAIL");

        await r.moveHand("right", [rest.x + 0.07, rest.y, -rest.z], { over: 0.4 });
        await r.wait(0.15);
        r.mark("joystick axes", `x=${joy.axes.x.toFixed(2)} z=${joy.axes.z.toFixed(2)}`);
        r.mark("assert deflection", (Math.abs(joy.axes.x - 0.7) < 0.12 && Math.abs(joy.axes.z) < 0.15)
            ? "PASS" : "FAIL");
        r.mark("screenshot:joystick-deflected");

        await r.moveHand("right", [rest.x + 0.15, rest.y, -rest.z], { over: 0.3 });
        await r.wait(0.15);
        r.mark("assert clamps at 1", joy.axes.x === 1 ? "PASS" : `FAIL x=${joy.axes.x.toFixed(2)}`);

        await r.rampButton("right", "grip", 1, 0, 0.1);
        await r.wait(0.35);
        r.mark("assert recentered", (Math.abs(joy.axes.x) < 0.05 && Math.abs(joy.axes.z) < 0.05)
            ? "PASS" : `FAIL x=${joy.axes.x.toFixed(2)}`);

        // Auto-detach: regrab, stray 0.45 m with the grip still held.
        await r.moveHand("right", toXR(rest), { over: 0.4 });
        await r.wait(0.35);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("regrab", joy.interactable.heldBy === "right" ? "ok" : "MISSED");
        await r.moveHand("right", [rest.x + 0.45, rest.y, -rest.z], { over: 0.15, ease: false });
        await r.wait(0.25);
        r.mark("assert joystick auto-detach",
            (joy.interactable.heldBy === null && right.grip > 0.9)
                ? "PASS" : `FAIL held=${joy.interactable.heldBy} grip=${right.grip}`);
        r.setGrip("right", 0);
        await r.wait(0.3);

        // --- 2. IK arm -------------------------------------------------------
        const head = arm.head.getAbsolutePosition().clone();
        await r.moveHand("right", toXR(head), { over: 0.7 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("assert lamp held", arm.interactable.heldBy === "right" ? "PASS" : "FAIL");

        await r.moveHand("right", [-0.25, 1.05, -0.75], { over: 1.0 });
        await r.wait(0.8); // goal smoothing settle
        const handPos = right.worldPosition;
        const gap = BABYLON.Vector3.Distance(arm.effector, handPos);
        r.mark("effector gap", gap.toFixed(3));
        r.mark("assert effector follows", gap < 0.08 ? "PASS" : "FAIL");
        const lens = [0, 1, 2].map(i =>
            BABYLON.Vector3.Distance(arm.joints[i + 1], arm.joints[i]));
        const rigid = lens.every((l, i) => Math.abs(l - [0.22, 0.22, 0.12][i]) < 0.005);
        r.mark("assert chain rigid", rigid ? "PASS" : `FAIL [${lens.map(l => l.toFixed(3))}]`);
        r.mark("screenshot:lamp-posed");

        // Yank: goal smoothing lags, gap exceeds 0.3 -> auto-detach.
        await r.moveHand("right", [0.25, 1.4, -0.75], { over: 0.12, ease: false });
        await r.wait(0.3);
        r.mark("assert lamp auto-detach", arm.interactable.heldBy === null
            ? "PASS" : "FAIL");
        r.setGrip("right", 0);
    });
}
