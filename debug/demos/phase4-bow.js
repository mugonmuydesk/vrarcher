// Phase 4 demo: grab the bow -> draw-hand controller auto-attaches to the
// other hand -> (test-forced) aim mode: YAW stays slaved to the bow wrist,
// ELEVATION conforms to the draw-hand lineup, stave upright (zero roll) —
// spec §4. Also checks right-handed mirroring.
//
// Bow floats at Babylon (-0.5, 1.2, 0.2) = XR (-0.5, 1.2, -0.2).

export async function run(rig, ctx) {
    const bow = ctx.bow;

    const aimErrors = () => {
        const clamp1 = (v) => Math.max(-1, Math.min(1, v));
        const from = bow.nockOrigin.getAbsolutePosition();
        const pivot = bow.aimPivot.getAbsolutePosition();
        const lineup = pivot.subtract(from).normalize();
        const actual = bow.flightDirection;
        // Hand-slaved forward: root world +Z, aim pivot excluded.
        const handFwd = BABYLON.Vector3.TransformNormal(
            new BABYLON.Vector3(0, 0, 1), bow.root.getWorldMatrix()).normalize();
        const yawOf = (v) => Math.atan2(v.x, v.z);
        const yawErr = Math.abs((((yawOf(actual) - yawOf(handFwd))
            * 180 / Math.PI + 540) % 360) - 180);
        const elevOf = (v) => Math.asin(clamp1(v.y)) * 180 / Math.PI;
        const elevErr = Math.abs(elevOf(actual) - elevOf(lineup));
        // Roll: the stave (tip-to-tip axis) must have no lean along the
        // horizontal right axis of the aim direction.
        const bowUp = bow.tipTop.getAbsolutePosition()
            .subtract(bow.tipBottom.getAbsolutePosition()).normalize();
        const right = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), actual).normalize();
        const rollErr = Math.abs(Math.asin(clamp1(
            BABYLON.Vector3.Dot(bowUp, right)))) * 180 / Math.PI;
        return { yawErr, elevErr, rollErr };
    };
    const markAim = (r, label) => {
        const { yawErr, elevErr, rollErr } = aimErrors();
        const ok = yawErr < 10 && elevErr < 10 && rollErr < 10;
        r.mark(`aim ${label}`, `yaw ${yawErr.toFixed(1)} elev ${elevErr.toFixed(1)} `
            + `roll ${rollErr.toFixed(1)} deg ${ok ? "PASS" : "FAIL"}`);
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- grab with the left hand ------------------------------------
        await r.moveHand("left", [-0.5, 1.2, -0.2], { over: 0.8 });
        await r.wait(0.4);
        await r.rampButton("left", "grip", 0, 1, 0.25);
        await r.wait(0.4);
        r.mark("assert bow held left", bow.bowHand === "left" ? "PASS" : `FAIL (${bow.bowHand})`);
        r.mark("assert draw hand attached", bow.drawHand === "right" && bow.nockOrigin ? "PASS" : "FAIL");
        const nockParentOk = bow.nockOrigin?.parent === ctx.hands.hands.right.gripNode;
        r.mark("assert nockOrigin on right grip", nockParentOk ? "PASS" : "FAIL");
        r.mark("screenshot:bow-held");
        await r.wait(1.5);

        // --- aim tracking (force-enable; Phase 5 gates this on nocked) ---
        bow.aimActive = true;
        await r.moveHand("left", [-0.1, 1.4, -0.5], { over: 0.6 });

        await r.moveHand("right", [0.15, 1.3, -0.15], { over: 0.6 });
        await r.wait(0.5);
        markAim(r, "@pos1");

        await r.moveHand("right", [0.25, 1.55, -0.2], { over: 0.6 });
        await r.wait(0.5);
        markAim(r, "@pos2");
        r.mark("screenshot:aiming");
        await r.wait(1.5);

        // --- release, then right-handed mirror ---------------------------
        bow.aimActive = false;
        await r.rampButton("left", "grip", 1, 0, 0.2);
        await r.wait(0.4);
        r.mark("assert released", bow.bowHand === null ? "PASS" : "FAIL");

        const bowPos = bow.root.absolutePosition;
        await r.moveHand("right", [bowPos.x, bowPos.y, -bowPos.z], { over: 0.8 });
        await r.wait(0.5);
        await r.rampButton("right", "grip", 0, 1, 0.25);
        await r.wait(0.4);
        r.mark("assert bow held right", bow.bowHand === "right" ? "PASS" : `FAIL (${bow.bowHand})`);
        r.mark("assert mirrored", bow.root.scaling.x === -1 ? "PASS" : `FAIL (${bow.root.scaling.x})`);
        r.mark("assert draw hand left", bow.drawHand === "left" ? "PASS" : "FAIL");
        r.mark("screenshot:mirrored");
        await r.wait(1.5);

        // Aim under the x-scale -1 mirror (the mirrored matrix path is
        // where the local-rotation construction could silently break).
        bow.aimActive = true;
        await r.moveHand("left", [-0.2, 1.5, -0.1], { over: 0.6 });
        await r.wait(0.5);
        markAim(r, "@mirrored");
        bow.aimActive = false;
        await r.wait(0.4);
        await r.rampButton("right", "grip", 1, 0, 0.2);
    });
}
