// Bug-fix verification suite (2026-06-12 session):
//  1. tilted-head smooth turn keeps the horizon level (locomotion premultiply)
//  2. curl-to-contact: grabbing the ball clamps the finger curl to its surface
//  3. grab-intent: reaching WITH the button part-squeezed must not punch the
//     item away; an OPEN palm push (no buttons) must shove it (hand vs movables)
//  4. fingers-first crate contact blocks the physics hand (full-hand collider)
//  5. door momentum: a shove keeps the unlatched door swinging after the
//     hand leaves; hinge friction stops it; it never blows past the stop
//
// Run with ?demo=bugfix-suite&autorun=1 (enterXR calibrates the rig offset).

export async function run(rig, ctx) {
    const right = ctx.hands.hands.right;

    // IWE right-stick x axis: probe 0 then 2 (varies by session).
    async function findTurnAxis(r) {
        for (const ax of [0, 2]) {
            r.setAxis("right", ax, 0.6);
            await r.wait(0.25);
            const got = Math.abs(right.thumbstick.x - 0.6) < 0.2;
            r.setAxis("right", ax, 0);
            await r.wait(0.1);
            if (got) return ax;
        }
        return null;
    }

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. tilted-head smooth turn -----------------------------------
        const cam = ctx.xr.baseExperience.camera;
        const ax = await findTurnAxis(r);
        r.mark("turn axis", ax ?? "NOT FOUND");
        const p = Math.PI / 180 * 25;
        const qx = [Math.sin(-p / 2), 0, 0, Math.cos(p / 2)];
        const qz = [0, 0, Math.sin(p / 2), Math.cos(p / 2)];
        const mul = (a, b) => [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
        r.poseHead([0, 1.7, 0], mul(qx, qz)); // pitch 25° + roll 25°
        await r.wait(0.5);
        const upY0 = cam.getDirection(BABYLON.Vector3.Up()).y;
        const yawOf = () => {
            const d = cam.getDirection(BABYLON.Vector3.Forward());
            return Math.atan2(d.x, d.z) * 180 / Math.PI;
        };
        const yaw0 = yawOf();
        const rigRot = cam.rotationQuaternion.clone(); // restore after the turn
        const rigPos = cam.position.clone();
        let minU = upY0, maxU = upY0;
        const obs = ctx.scene.onBeforeRenderObservable.add(() => {
            const y = cam.getDirection(BABYLON.Vector3.Up()).y;
            minU = Math.min(minU, y); maxU = Math.max(maxU, y);
        });
        r.setAxis("right", ax ?? 0, 1);
        await r.wait(2.0);
        r.setAxis("right", ax ?? 0, 0);
        ctx.scene.onBeforeRenderObservable.remove(obs);
        const yawD = ((yawOf() - yaw0 + 540) % 360) - 180;
        r.mark("tilted turn", `yaw ${yawD.toFixed(0)}° upY drift ${(maxU - minU).toFixed(4)}`);
        r.mark("assert turn keeps horizon",
            Math.abs(yawD) > 60 && (maxU - minU) < 0.02 ? "PASS" : "FAIL");
        // Un-turn the rig: the yaw persists in the camera (by design) and
        // would mirror every commanded pose for the rest of the script.
        cam.rotationQuaternion.copyFrom(rigRot);
        cam.position.copyFrom(rigPos);
        r.poseHead([0, 1.7, 0], [0, 0, 0, 1]);
        await r.wait(0.4);
        await r.calibrate(); // re-zero the position mapping post-turn

        // --- 2. curl-to-contact on the ball --------------------------------
        // Approach from the SIDE so the fingers wrap around the equator
        // (a top grab leaves the open fingers already on the surface).
        const ball = ctx.scene.getMeshByName("ball");
        const bp = ball.getAbsolutePosition().clone();
        r.setGrip("right", 0.4); // grab intent: no punch-away
        await r.moveHand("right", [bp.x, bp.y + 0.06, -bp.z], { over: 0.6 });
        await r.wait(0.4);
        // Close in until the grip is truly AT the ball (hover-boost would
        // otherwise let the grab fire from ~14 cm out and the ball would
        // ride at that offset): nudge down toward the surface.
        for (let i = 0; i < 8; i++) {
            const gap = BABYLON.Vector3.Distance(right.worldPosition, ball.getAbsolutePosition());
            if (gap < 0.06) break;
            const s = r.state.right.position;
            await r.moveHand("right", [s[0], s[1] - 0.03, s[2]], { over: 0.15 });
            await r.wait(0.2);
        }
        const ballMoved1 = BABYLON.Vector3.Distance(bp, ball.getAbsolutePosition());
        r.mark("assert intent approach leaves ball", ballMoved1 < 0.03
            ? "PASS" : `FAIL moved=${ballMoved1.toFixed(3)}`);
        r.mark("hover", `${ctx.interaction.hover.right?.mesh.name ?? "-"} gripGap=`
            + BABYLON.Vector3.Distance(right.worldPosition, ball.getAbsolutePosition()).toFixed(3));
        await r.rampButton("right", "grip", 0.4, 1, 0.15);
        await r.wait(0.6); // includes the 10-frame clamp recompute
        const held = ctx.interaction.held.right?.mesh.name ?? null;
        const clamp = right.curlClamp;
        r.mark("ball grab", `held=${held} clamp=${clamp
            ? `${clamp.lower.toFixed(2)}/${clamp.index.toFixed(2)}/${clamp.thumb.toFixed(2)}` : "-"}`);
        r.mark("assert ball held", held === "ball" ? "PASS" : "FAIL");
        r.mark("assert curl clamped", clamp && (clamp.lower < 0.95 || clamp.index < 0.95)
            ? "PASS" : "FAIL");
        await r.moveHand("right", [0.3, 1.25, -0.4], { over: 0.6 });
        await r.wait(0.3);
        const inHand = BABYLON.Vector3.Distance(
            ball.getAbsolutePosition(), right.worldPosition);
        r.mark("assert ball rides hand", inHand < 0.15 ? "PASS" : `FAIL d=${inHand.toFixed(2)}`);
        r.mark("screenshot:ball-curl-grip");
        // put it gently back down on the crate
        await r.moveHand("right", [bp.x, bp.y + 0.06, -bp.z], { over: 0.5 });
        await r.rampButton("right", "grip", 1, 0, 0.15);
        await r.wait(0.6);
        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.4 });
        r.setGrip("right", 0);
        await r.wait(0.5);

        // --- 3. open-palm push DOES move it --------------------------------
        const bp2 = ball.getAbsolutePosition().clone();
        const bs = ball.physicsBody.shape;
        r.mark("ball masks pre-push", `mem=${bs.filterMembershipMask} col=${bs.filterCollideMask}`);
        // Sweep HIGH enough that the finger box (13 cm below the grip)
        // clears the crate top and only the ball is in the path — lower
        // sweeps pin the palm against the crate's side wall instead.
        await r.moveHand("right", [bp2.x - 0.3, bp2.y + 0.10, -bp2.z], { over: 0.5 });
        await r.wait(0.3);
        await r.moveHand("right", [bp2.x + 0.05, bp2.y + 0.10, -bp2.z], { over: 0.5, ease: false });
        await r.wait(1.0);
        const pushDist = BABYLON.Vector3.Distance(bp2, ball.getAbsolutePosition());
        r.mark("open palm push", `ball moved ${pushDist.toFixed(3)} m `
            + `palmDisp=${ctx.physicsHands.hands.right.displacement.toFixed(3)}`);
        r.mark("assert open palm shoves ball", pushDist > 0.05 ? "PASS" : "FAIL");
        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.5 });
        await r.wait(0.4);

        // --- 4. fingers-first block on the crate ---------------------------
        // Hand over the crate's free corner; fingers hang ~13 cm below the
        // grip, so the palm body must stop while the grip keeps descending.
        // Assert on PEAK displacement during the descent: the palm can
        // slide off the crate edge afterwards, so an end-sample is flaky.
        await r.moveHand("right", [0.45, 1.15, -0.55], { over: 0.5 });
        await r.wait(0.4);
        let peakDisp = 0;
        const dObs = ctx.scene.onBeforeRenderObservable.add(() => {
            peakDisp = Math.max(peakDisp, ctx.physicsHands.hands.right.displacement);
        });
        await r.moveHand("right", [0.45, 0.87, -0.55], { over: 0.6 });
        await r.wait(0.6);
        ctx.scene.onBeforeRenderObservable.remove(dObs);
        r.mark("fingers-first peak displacement", peakDisp.toFixed(3));
        r.mark("assert fingers block on crate", peakDisp > 0.03 ? "PASS" : "FAIL");
        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.5 });
        await r.wait(0.4);

        // --- 5. door momentum ----------------------------------------------
        const door = ctx.door;
        // Test seam: hold the bolt retracted against the lever spring-return
        // (the lever-turn interaction itself is ext6-door's job).
        const bolt = ctx.scene.onBeforeRenderObservable.add(() => {
            door.handleAngle = 0.9;
            door._applyHandle();
        });
        await r.wait(0.2);
        r.mark("door unlatched", String(!door.latched));
        // Shove the panel near its FREE edge: the panel extends +X from the
        // hinge post (width 0.7), so sweep through the slab at x ≈ +0.55.
        const hinge = door.root.position;
        await r.moveHand("left", [hinge.x + 0.55, 1.15, -(hinge.z - 0.25)], { over: 0.5 });
        await r.wait(0.2);
        await r.moveHand("left", [hinge.x + 0.55, 1.15, -(hinge.z + 0.15)], { over: 0.25, ease: false });
        await r.moveHand("left", [-0.3, 1.4, -0.6], { over: 0.3 }); // hand AWAY
        ctx.scene.onBeforeRenderObservable.remove(bolt); // ajar > 0.06 keeps it free
        const a0 = door.doorAngle;
        await r.wait(0.6);
        const a1 = door.doorAngle;
        await r.wait(1.6);
        const a2 = door.doorAngle;
        await r.wait(1.0);
        const a3 = door.doorAngle;
        r.mark("door coast", `shove-end ${a0.toFixed(2)} +0.6s ${a1.toFixed(2)} `
            + `+2.2s ${a2.toFixed(2)} +3.2s ${a3.toFixed(2)} rad`);
        r.mark("assert door coasts after shove", Math.abs(a1) > Math.abs(a0) + 0.05
            ? "PASS" : "FAIL");
        r.mark("assert door friction stops it", Math.abs(a3 - a2) < 0.02
            ? "PASS" : "FAIL");
        r.mark("assert door inside stops", Math.abs(a3) <= 1.9 ? "PASS" : "FAIL");
    });
}
