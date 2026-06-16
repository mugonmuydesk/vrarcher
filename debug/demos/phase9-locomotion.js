// Phase 9 demo: smooth joystick locomotion + smooth turning, and the
// locomotion→world-space hand interaction:
//  1. axis-mapping probe (IWE analog indices), forward walk ≈2.2 m with
//     accel ramp, hands ride the rig (world hand z tracks camera z).
//  2. release -> decel to rest; strafe right; smooth yaw 45° and back.
//  3. gate: with an arrow nocked the sticks do nothing.
//  4. bounds: strafing into the range edge clamps at the ground border.
//  5. THE POINT (user-specified): a hand held still on its tracker but
//     carried through the world by locomotion must push physical things —
//     walking into a LATCHED door does nothing, but the same walk with the
//     door ajar shoves it further open, exactly like an arm push.

export async function run(rig, ctx) {
    const loco = ctx.locomotion, door = ctx.door;
    if (!loco || !door) { rig.mark("FAIL: systems missing"); return; }
    const camera = () => ctx.xr.baseExperience.camera;
    const left = ctx.hands.hands.left;
    const camYaw = () => {
        const d = camera().getDirection(BABYLON.Vector3.Forward());
        return Math.atan2(d.x, d.z) * 180 / Math.PI;
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. axis mapping probe + forward walk --------------------------
        r.setAxis("left", 3, -1);
        await r.wait(0.25);
        let AX = { x: 2, y: 3 };
        if (Math.abs(left.thumbstick.y + 1) > 0.2) {
            r.setAxis("left", 3, 0);
            r.setAxis("left", 1, -1);
            await r.wait(0.25);
            if (Math.abs(left.thumbstick.y + 1) < 0.2) AX = { x: 0, y: 1 };
        }
        r.mark("axis map", `x=${AX.x} y=${AX.y} (stick y=${left.thumbstick.y.toFixed(2)})`);

        const cam0 = camera().position.clone();
        const hand0 = left.worldPosition.clone();
        await r.wait(1.0); // stick already held forward
        r.setAxis("left", AX.y, 0);
        const cam1 = camera().position.clone();
        const hand1 = left.worldPosition.clone();
        const dz = cam1.z - cam0.z;
        r.mark("walk fwd", `dz=${dz.toFixed(2)} dx=${(cam1.x - cam0.x).toFixed(2)}`);
        r.mark("assert walk forward", (dz > 1.3 && dz < 3.0 && Math.abs(cam1.x - cam0.x) < 0.3)
            ? "PASS" : "FAIL");
        const handDz = hand1.z - hand0.z;
        r.mark("assert hands ride the rig", Math.abs(handDz - dz) < 0.25
            ? "PASS" : `FAIL handDz=${handDz.toFixed(2)} vs ${dz.toFixed(2)}`);

        // --- 2. decel, strafe, smooth turn ----------------------------------
        await r.wait(0.5);
        const rest0 = camera().position.clone();
        await r.wait(0.3);
        r.mark("assert decel to rest",
            BABYLON.Vector3.Distance(rest0, camera().position) < 0.05 ? "PASS" : "FAIL");

        const sx0 = camera().position.x;
        r.setAxis("left", AX.x, 1);
        await r.wait(0.6);
        r.setAxis("left", AX.x, 0);
        await r.wait(0.4);
        const sdx = camera().position.x - sx0;
        r.mark("assert strafe right", sdx > 0.7 ? "PASS" : `FAIL dx=${sdx.toFixed(2)}`);

        const yaw0 = camYaw();
        r.setAxis("right", AX.x, 1);
        await r.wait(0.5);
        r.setAxis("right", AX.x, 0);
        await r.wait(0.2);
        const dyaw = ((camYaw() - yaw0 + 540) % 360) - 180;
        r.mark("smooth turn", `${dyaw.toFixed(0)}° in 0.5 s`);
        r.mark("assert smooth turn", (Math.abs(dyaw) > 30 && Math.abs(dyaw) < 60) ? "PASS" : "FAIL");
        // turn back to the original heading
        r.setAxis("right", AX.x, -Math.sign(dyaw));
        await r.wait(0.5 * Math.abs(dyaw) / 45);
        r.setAxis("right", AX.x, 0);
        await r.wait(0.2);

        // --- 3. gate while nocked -------------------------------------------
        ctx.arrows.nocked = true;
        const g0 = camera().position.clone();
        r.setAxis("left", AX.y, -1);
        await r.wait(0.5);
        r.setAxis("left", AX.y, 0);
        ctx.arrows.nocked = false;
        r.mark("assert gated while nocked",
            BABYLON.Vector3.Distance(g0, camera().position) < 0.05 ? "PASS" : "FAIL");

        // --- 4. ground-bounds clamp -----------------------------------------
        // Range ground: x in [-6, 6] minus inset. Strafe hard left 3.5 s.
        r.setAxis("left", AX.x, -1);
        await r.tween(3.5, () => {});
        r.setAxis("left", AX.x, 0);
        await r.wait(0.4);
        const bx = camera().position.x;
        r.mark("assert bounds clamp", (bx <= -5.0 && bx >= -6.0) ? "PASS" : `FAIL x=${bx.toFixed(2)}`);

        // --- 5. locomotion pushes the door ----------------------------------
        // Stage in front of the door, hand outstretched onto the panel line.
        camera().position.x = 1.25;
        camera().position.z = 0;
        await r.wait(0.3);

        // 5a. LATCHED: hand 10 cm before the shut panel, walk 0.6 s.
        r.poseHand("left", [1.3, 1.0, -1.15]);
        await r.wait(0.3);
        r.setAxis("left", AX.y, -1);
        await r.wait(0.6);
        r.setAxis("left", AX.y, 0);
        await r.wait(0.3);
        r.mark("assert latched door resists the walk", door.open < 0.01
            ? "PASS" : `FAIL open=${door.open.toFixed(2)}`);
        // walk back to the staging spot
        r.setAxis("left", AX.y, 1);
        await r.wait(0.6);
        r.setAxis("left", AX.y, 0);
        await r.wait(0.4);
        camera().position.x = 1.25;
        camera().position.z = 0;

        // 5b. AJAR: stage the door 26° open (unlatched), hand just before
        // the panel at lever ~0.45 from the hinge, then ONLY locomote —
        // the hand pose is never touched again.
        door.doorAngle = -0.45;
        door.root.rotation.y = door.doorAngle;
        await r.wait(0.2);
        r.mark("staged ajar", `open=${(door.open * 180 / Math.PI).toFixed(0)}° latched=${door.latched}`);
        const hp = BABYLON.Vector3.TransformCoordinates(
            new BABYLON.Vector3(0.45, 1.0, -0.12), door.root.getWorldMatrix());
        r.poseHand("left", [hp.x, hp.y, -hp.z]);
        await r.wait(0.3);
        const open0 = door.open;
        const handZ0 = left.worldPosition.z;
        r.setAxis("left", AX.y, -1);
        await r.wait(0.9);
        r.setAxis("left", AX.y, 0);
        await r.wait(0.4);
        const open1 = door.open;
        const handMoved = left.worldPosition.z - handZ0;
        r.mark("door push", `open ${(open0 * 180 / Math.PI).toFixed(0)}° -> ${(open1 * 180 / Math.PI).toFixed(0)}°, hand carried ${handMoved.toFixed(2)} m by locomotion alone`);
        r.mark("assert walk pushes ajar door open", (open1 > open0 + 0.25 && handMoved > 0.8)
            ? "PASS" : "FAIL");
        r.mark("assert stays unlatched", !door.latched ? "PASS" : "FAIL");
        r.mark("screenshot:door-pushed-by-walk");
    });
}
