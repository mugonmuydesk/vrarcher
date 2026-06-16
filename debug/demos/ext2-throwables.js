// Throwable-variant demo: auto-catch, heavy force-drag, two-handed springs.
//  1. Auto-catch: scene ball (gravity off for a straight flight) launched at
//     the parked right hand at 4 m/s — attaches without a button press;
//     grip-cycle drops it (gravity restores on release).
//  2. Heavy box: grip-grab, never kinematic / never parented; drag moves it
//     across the floor; visual hand snaps to the surface point.
//  3. Beam: both hands hold simultaneously (multiHold), lifting raises it,
//     asymmetric lift tilts it, releasing drops it.

export async function run(rig, ctx) {
    const find = (name) => [...ctx.interaction.interactables].find(i => i.mesh.name === name);
    const ballIt = find("ball");
    const heavyIt = find("heavyBox");
    const beamIt = find("beam");
    if (!ballIt || !heavyIt || !beamIt) { rig.mark("FAIL: props missing"); return; }

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. auto-catch ------------------------------------------------
        // Right hand parked at XR (0.25,1.4,-0.55) = Babylon (0.25,1.4,0.55).
        // Launch the ball from the crate straight at it.
        const handB = ctx.hands.hands.right.worldPosition.clone();
        const ballPos = ballIt.mesh.absolutePosition;
        const dir = handB.subtract(ballPos).normalize();
        ballIt.body.setGravityFactor(0);
        ballIt.body.setLinearVelocity(dir.scale(4));
        await r.wait(0.6);
        r.mark("assert auto-catch", ballIt.heldBy === "right" ? "PASS" : `FAIL (${ballIt.heldBy})`);
        r.mark("screenshot:caught");
        // Drop it: grip cycle (release restores gravity factor 1).
        await r.rampButton("right", "grip", 0, 1, 0.15);
        await r.rampButton("right", "grip", 1, 0, 0.15);
        await r.wait(0.3);
        const gravBack = ballIt.body.getGravityFactor();
        r.mark("assert catch released", (ballIt.heldBy === null && gravBack === 1)
            ? "PASS" : `FAIL held=${ballIt.heldBy} g=${gravBack}`);

        // --- 2. heavy throwable --------------------------------------------
        // Box at (1.0, 0.18, 0.5), top y = 0.355.
        await r.moveHand("right", [1.0, 0.42, -0.5], { over: 0.7 });
        await r.wait(0.35);
        r.mark("hover heavy", heavyIt.hoveredBy === "right" ? "PASS" : `FAIL (${heavyIt.hoveredBy})`);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.25);
        const motion = heavyIt.body.getMotionType();
        r.mark("assert heavy held", heavyIt.heldBy === "right" ? "PASS" : "FAIL");
        r.mark("assert never kinematic",
            (motion === BABYLON.PhysicsMotionType.DYNAMIC && heavyIt.mesh.parent === null)
                ? "PASS" : `FAIL motion=${motion} parent=${heavyIt.mesh.parent?.name}`);

        // Quick yank: tracked grip outruns the box; visual hand must stay
        // snapped to the box surface, not the grip.
        const sweep = r.moveHand("right", [0.55, 0.5, -0.85], { over: 0.3, ease: false });
        await r.wait(0.2);
        const rigRoot = ctx.hands.hands.right.rig.root;
        const grip = ctx.hands.hands.right.worldPosition;
        const dRootGrip = BABYLON.Vector3.Distance(rigRoot.absolutePosition, grip);
        const dRootBox = BABYLON.Vector3.Distance(rigRoot.absolutePosition, heavyIt.mesh.absolutePosition);
        r.mark("hand snap", `root-grip=${dRootGrip.toFixed(3)} root-box=${dRootBox.toFixed(3)}`);
        r.mark("assert hand snapped to surface", (dRootGrip > 0.04 && dRootBox < 0.45) ? "PASS" : "FAIL");
        await sweep;
        await r.wait(1.2);
        const boxP = heavyIt.mesh.absolutePosition;
        r.mark("heavy dragged to", `(${boxP.x.toFixed(2)}, ${boxP.y.toFixed(2)}, ${boxP.z.toFixed(2)})`);
        r.mark("assert heavy dragged", (boxP.x < 0.85 && boxP.z > 0.6 && boxP.y < 0.6) ? "PASS" : "FAIL");
        r.mark("screenshot:heavy-drag");
        await r.rampButton("right", "grip", 1, 0, 0.15);
        await r.wait(0.3);
        r.mark("assert heavy released", heavyIt.heldBy === null ? "PASS" : "FAIL");

        // --- 3. two-handed beam --------------------------------------------
        // Beam spans x [-1.4,-0.4] at y 0.07, z 0.7.
        await Promise.all([
            r.moveHand("left", [-1.25, 0.16, -0.7], { over: 0.7 }),
            r.moveHand("right", [-0.55, 0.16, -0.7], { over: 0.7 }),
        ]);
        await r.wait(0.4);
        await r.rampButton("left", "grip", 0, 1, 0.2);
        await r.rampButton("right", "grip", 0, 1, 0.2);
        await r.wait(0.3);
        r.mark("assert both hands hold", beamIt.holders.size === 2
            ? "PASS" : `FAIL holders=${beamIt.holders.size}`);

        // Lift level.
        await Promise.all([
            r.moveHand("left", [-1.25, 0.6, -0.7], { over: 0.8 }),
            r.moveHand("right", [-0.55, 0.6, -0.7], { over: 0.8 }),
        ]);
        await r.wait(0.6);
        const beamY = beamIt.mesh.absolutePosition.y;
        r.mark("assert beam lifted", beamY > 0.3 ? "PASS" : `FAIL y=${beamY.toFixed(3)}`);
        r.mark("screenshot:beam-lifted");

        // Tilt: right end up.
        await r.moveHand("right", [-0.55, 1.0, -0.7], { over: 0.5 });
        await r.wait(0.5);
        const m = beamIt.mesh.getWorldMatrix();
        const endR = BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(0.5, 0, 0), m);
        const endL = BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(-0.5, 0, 0), m);
        r.mark("beam ends y", `L=${endL.y.toFixed(2)} R=${endR.y.toFixed(2)}`);
        r.mark("assert beam tilted", endR.y > endL.y + 0.12 ? "PASS" : "FAIL");

        // Drop.
        r.setGrip("left", 0);
        r.setGrip("right", 0);
        await r.wait(1.0);
        const downY = beamIt.mesh.absolutePosition.y;
        r.mark("assert beam dropped", (beamIt.holders.size === 0 && downY < 0.25)
            ? "PASS" : `FAIL holders=${beamIt.holders.size} y=${downY.toFixed(2)}`);
    });
}
