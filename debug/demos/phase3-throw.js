// Phase 3 demo (XR): physics hand presence + throwing.
//  1. Pick up the ball from the crate (squeeze-while-reaching: hands
//     collide with free grabbables, so an open-handed reach would shove it),
//     scripted throw, ball flies with a believable arc; assert release
//     velocity and downrange travel.
//  2. Press the right palm down into the (now empty) crate top: the
//     physical palm must stop on the surface while the tracked grip keeps
//     going (displacement grows), and press haptics fire.
//  3. Push far past the snap distance: palm snaps back to the grip.
//
// Throw runs FIRST: any other hand motion near the crate can graze the
// ball now that hand↔grabbable collision is on.

export async function run(rig, ctx) {
    const palm = () => ctx.physicsHands.hands.right;
    const ballIt = [...ctx.interaction.interactables].find(i => i.mesh.name === "ball");
    if (!ballIt) { rig.mark("FAIL: ball not found"); return; }

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- 1. throw the ball ------------------------------------------
        r.setGrip("right", 0.4); // grab intent suppresses reach-shove
        const bp = ballIt.mesh.getAbsolutePosition();
        await r.moveHand("right", [bp.x, bp.y + 0.05, -bp.z], { over: 0.7 });
        await r.wait(0.4);
        // settle in until the hover catches (mapping residual is a few cm)
        for (let i = 0; i < 4 && ballIt.hoveredBy !== "right"; i++) {
            const s = r.state.right.position;
            await r.moveHand("right", [s[0], s[1] - 0.03, s[2]], { over: 0.15 });
            await r.wait(0.25);
        }
        r.mark("hover ball", ballIt.hoveredBy === "right" ? "PASS" : `FAIL (${ballIt.hoveredBy})`);
        await r.rampButton("right", "grip", 0.4, 1, 0.2);
        await r.wait(0.25);
        r.mark("assert ball held", ballIt.heldBy === "right" ? "PASS" : "FAIL");

        // wind up behind the shoulder, then sweep forward and release mid-throw
        await r.moveHand("right", [0.35, 1.5, -0.1], { over: 0.5 });
        await r.wait(0.2);
        const sweep = r.moveHand("right", [0.1, 1.7, -0.9], { over: 0.28, ease: false });
        await r.wait(0.2);                       // ~70% through the sweep
        r.setGrip("right", 0);                   // instant release mid-motion
        await sweep;
        await r.wait(0.1);
        const v = ballIt.body.getLinearVelocity();
        r.mark("release velocity", `${v.length().toFixed(2)} m/s (x=${v.x.toFixed(1)} y=${v.y.toFixed(1)} z=${v.z.toFixed(1)})`);
        r.mark("assert thrown", (v.length() > 1.2 && v.z > 0.5) ? "PASS" : "FAIL");

        // let it fly
        await r.wait(1.4);
        const p = ballIt.mesh.absolutePosition;
        r.mark("ball landed at", `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
        r.mark("assert flew downrange", (p.z > 1.2 && p.y < 0.5) ? "PASS" : "FAIL");
        r.mark("screenshot:landed");
        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.5 });
        await r.wait(0.3);

        // --- 2. press into the (now empty) crate top --------------------
        const crateBB = ctx.scene.getMeshByName("crate").getBoundingInfo().boundingBox;
        const cx = (crateBB.minimumWorld.x + crateBB.maximumWorld.x) / 2;
        const cz = (crateBB.minimumWorld.z + crateBB.maximumWorld.z) / 2;
        await r.moveHand("right", [cx, 1.1, -cz], { over: 0.6 });
        await r.wait(0.3);
        const dispBefore = palm().displacement;
        // push grip 12 cm below the crate top surface
        await r.moveHand("right", [cx, 0.72, -cz], { over: 0.8 });
        await r.wait(0.4);
        const dispPressed = palm().displacement;
        const palmY = palm().palmNode.absolutePosition.y;
        r.mark("press: disp", `${dispBefore.toFixed(3)} -> ${dispPressed.toFixed(3)}, palmY=${palmY.toFixed(3)} (crate top 0.8)`);
        r.mark("assert palm stops on crate",
            (dispPressed > 0.05 && palmY > 0.78) ? "PASS" : "FAIL");
        r.mark("screenshot:pressing");
        await r.wait(1.0);

        // --- 3. snap-back beyond 0.3 m ----------------------------------
        // Simulate a tracking jump: teleport the grip 1 m away in one
        // frame. Displacement crosses the 0.3 m threshold and the palm must
        // snap to the grip instead of springing across the scene.
        r.poseHand("right", [-0.6, 1.6, -0.6]);
        await r.wait(0.4);
        const dispAfterSnap = palm().displacement;
        r.mark("assert snap-back", dispAfterSnap < 0.1 ? "PASS" : `FAIL disp=${dispAfterSnap.toFixed(3)}`);
    });
}
