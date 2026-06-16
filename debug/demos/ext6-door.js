// Door demo: latched until the handle turns, then push it open.
//  1. Grab the handle and shove (arc around the hinge) WITHOUT turning:
//     the door must not move (latched).
//  2. Twist the lever 0.8 rad -> bolt frees (latched=false).
//  3. Keep holding, arc the hand around the hinge -> door swings open,
//     free edge moves AWAY from the player (+Z).
//  4. Release: lever springs back to ~0; the ajar door stays unlatched.
//  5. Regrab WITHOUT turning (ajar = bolt can't engage), swing shut ->
//     re-latches at closed.
//
// Hinge (0.95, 0, 1.3) Babylon; knob ~(1.45, 1.0, 1.245); pivot
// (1.57, 1.0, 1.245); panel free edge x 1.65 (local (0.7, 1, 0)).

export async function run(rig, ctx) {
    const door = ctx.door;
    if (!door) { rig.mark("FAIL: door missing"); return; }
    const HINGE = { x: 0.95, z: 1.3 };

    // Arc the right hand around the hinge at radius r / height y (Babylon
    // angles, XR pose).
    const arc = (r, y, a0, a1, over) => rig.tween(over, t => {
        const a = a0 + (a1 - a0) * t;
        rig.poseHand("right",
            [HINGE.x + r * Math.cos(a), y, -(HINGE.z + r * Math.sin(a))]);
    });
    // Circle the hand around the handle boss in the door plane (twist).
    const PIVOT = { x: 1.57, y: 1.0, z: 1.245 };
    const twist = (a0, a1, over) => rig.tween(over, t => {
        const a = a0 + (a1 - a0) * t;
        rig.poseHand("right",
            [PIVOT.x + 0.12 * Math.cos(a), PIVOT.y + 0.12 * Math.sin(a), -PIVOT.z]);
    });
    const edgeZ = () => BABYLON.Vector3.TransformCoordinates(
        new BABYLON.Vector3(0.7, 1.0, 0), door.root.getWorldMatrix()).z;

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. shove while latched ---------------------------------------
        const knob = door.knob.getAbsolutePosition();
        await r.moveHand("right", [knob.x, knob.y, -knob.z], { over: 0.8 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("assert handle held", door.interactable.heldBy === "right" ? "PASS" : "FAIL");

        const yaw0 = Math.atan2(knob.z - HINGE.z, knob.x - HINGE.x);
        const rad0 = Math.hypot(knob.x - HINGE.x, knob.z - HINGE.z);
        await arc(rad0, knob.y, yaw0, yaw0 + 0.45, 0.8);
        await r.wait(0.2);
        r.mark("door state", `latched=${door.latched} open=${door.open.toFixed(3)}`);
        r.mark("assert latched door held fast", (door.latched && door.open < 0.05)
            ? "PASS" : "FAIL");
        await arc(rad0, knob.y, yaw0 + 0.45, yaw0, 0.5); // back to the start
        await r.wait(0.2);

        // --- 2. turn the lever --------------------------------------------
        await twist(Math.PI, Math.PI + 0.8, 0.7);
        await r.wait(0.2);
        r.mark("handle angle", (door.handleAngle * 180 / Math.PI).toFixed(0) + "°");
        r.mark("assert unlatched", (!door.latched && Math.abs(door.handleAngle) > 0.7)
            ? "PASS" : `FAIL latched=${door.latched} h=${door.handleAngle.toFixed(2)}`);
        r.mark("screenshot:handle-turned");

        // --- 3. push it open -----------------------------------------------
        const hp = ctx.hands.hands.right.worldPosition;
        const yaw1 = Math.atan2(hp.z - HINGE.z, hp.x - HINGE.x);
        const rad1 = Math.hypot(hp.x - HINGE.x, hp.z - HINGE.z);
        await arc(rad1, hp.y, yaw1, yaw1 + 0.55, 1.0);
        await r.wait(0.2);
        r.mark("door open", `${(door.open * 180 / Math.PI).toFixed(0)}° edgeZ=${edgeZ().toFixed(2)}`);
        r.mark("assert pushed open", door.open > 0.3 ? "PASS" : "FAIL");
        r.mark("assert opens away from player", edgeZ() > 1.45
            ? "PASS" : `FAIL edgeZ=${edgeZ().toFixed(2)}`);
        r.mark("screenshot:door-open");

        // --- 4. release: lever springs back, door stays ajar ---------------
        await r.rampButton("right", "grip", 1, 0, 0.15);
        await r.wait(0.5);
        r.mark("assert lever sprang back", Math.abs(door.handleAngle) < 0.1
            ? "PASS" : `FAIL h=${door.handleAngle.toFixed(2)}`);
        r.mark("assert stays ajar+free", (!door.latched && door.open > 0.3)
            ? "PASS" : "FAIL");

        // --- 5. regrab w/o turning, swing shut, re-latch --------------------
        const knob2 = door.knob.getAbsolutePosition();
        await r.moveHand("right", [knob2.x, knob2.y, -knob2.z], { over: 0.6 });
        await r.wait(0.4);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        r.mark("regrab", door.interactable.heldBy === "right" ? "ok" : "MISSED");
        const hp2 = ctx.hands.hands.right.worldPosition;
        const yaw2 = Math.atan2(hp2.z - HINGE.z, hp2.x - HINGE.x);
        const rad2 = Math.hypot(hp2.x - HINGE.x, hp2.z - HINGE.z);
        await arc(rad2, hp2.y, yaw2, yaw2 - (door.open - 0.02), 1.0);
        await r.wait(0.2);
        await r.rampButton("right", "grip", 1, 0, 0.15);
        await r.wait(0.3);
        r.mark("closed state", `latched=${door.latched} open=${(door.open * 180 / Math.PI).toFixed(0)}°`);
        r.mark("assert re-latched shut", (door.latched && door.open < 0.06)
            ? "PASS" : "FAIL");
    });
}
