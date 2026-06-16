// Force-pull / remote grab check (forcepull.js). Verifies the three mechanics:
//   A. TARGET — pointing at the ball locks + highlights it.
//   B. FLICK  — a quick pull-back of the hand launches the locked target.
//   C. CATCH  — the ball flies to the hand and hands off to a real grab.
//
// Aiming the emulated pointer ray precisely at a prop is fiddly (XR<->Babylon
// orientation mapping), so for determinism we drive _aim() from the hand
// toward the ball and separately log what the REAL pointer ray reports.
// Babylon (x,y,z) -> XR (x,y,-z).

export async function run(rig, ctx) {
    const find = (n) => [...ctx.interaction.interactables].find(i => i.mesh.name === n);
    const ball = find("ball");
    const fp = ctx.forcePull;
    if (!ball || !fp) { rig.mark("FAIL: ball or forcePull system missing"); return; }

    await rig.run(async (r) => {
        r.reset();
        await r.wait(0.8);
        const spawn = ball.mesh.absolutePosition.clone();
        r.mark("ball spawn", `(${spawn.x.toFixed(2)},${spawn.y.toFixed(2)},${spawn.z.toFixed(2)})`);

        // Park the right hand in front of the player, raised, pointing roughly
        // downrange/right toward the ball.
        await r.moveHand("right", [0.2, 1.4, -0.3], { over: 0.8 });
        await r.wait(0.4);

        // Log what the REAL pointer ray reports (sanity check on aim axis).
        const realAim = fp._aim("right");
        if (realAim) {
            const toBall = ball.mesh.getBoundingInfo().boundingSphere.centerWorld
                .subtract(realAim.origin).normalize();
            const cos = BABYLON.Vector3.Dot(realAim.dir, toBall);
            r.mark("real aim", `dir=(${realAim.dir.x.toFixed(2)},${realAim.dir.y.toFixed(2)},${realAim.dir.z.toFixed(2)}) cos-to-ball=${cos.toFixed(2)}`);
        }

        // --- A. TARGET requires the grab button armed ----------------------
        const c = () => ball.mesh.getBoundingInfo().boundingSphere.centerWorld;
        fp._aim = (hand) => {
            const o = ctx.hands.hands[hand].worldPosition;
            return { origin: o, dir: c().subtract(o).normalize() };
        };
        // A0: aimed at the ball but grip released — an idle hand must NOT light it up.
        r.setGrip("right", 0);
        await r.wait(0.35);
        r.mark("assert idle no-highlight", (fp.target.right === null && !ball.mesh.renderOutline)
            ? "PASS" : `FAIL target=${fp.target.right?.mesh.name ?? null} outline=${ball.mesh.renderOutline}`);
        // A1: a light squeeze arms targeting — lock + highlight.
        r.setGrip("right", 0.3);
        await r.wait(0.35);
        r.mark("assert target locked", fp.target.right === ball ? "PASS" : `FAIL (${fp.target.right?.mesh.name ?? null})`);
        r.mark("assert highlighted", ball.mesh.renderOutline ? "PASS" : "FAIL");
        // A2: release — highlight clears (the reported stuck-highlight bug).
        r.setGrip("right", 0);
        await r.wait(0.35);
        r.mark("assert highlight clears on release", (fp.target.right === null && !ball.mesh.renderOutline)
            ? "PASS" : `FAIL target=${fp.target.right?.mesh.name ?? null} outline=${ball.mesh.renderOutline}`);

        // --- B. FLICK now requires the grab button (grip) held -------------
        // B0: a flick WITHOUT grip must NOT launch.
        r.setGrip("right", 0);
        await r.moveHand("right", [0.03, 1.5, -0.03], { over: 0.16, ease: false });
        await r.wait(0.15);
        const noLaunch = !fp.pulling.has(ball) && ball.body.getGravityFactor() !== 0 && ball.heldBy !== "right";
        r.mark("assert no launch without grip", noLaunch ? "PASS" : "FAIL (launched with no grip)");

        // Re-arm: hand back out so the target re-locks.
        await r.moveHand("right", [0.2, 1.4, -0.3], { over: 0.5 });
        await r.wait(0.3);

        // B1: grip held + flick → launch (and keep grip held through the catch).
        r.setGrip("right", 1);
        await r.wait(0.1);
        await r.moveHand("right", [0.03, 1.5, -0.03], { over: 0.16, ease: false });
        await r.wait(0.1);
        const launched = fp.pulling.has(ball) || ball.body.getGravityFactor() === 0 || ball.heldBy === "right";
        r.mark("assert flick+grip launched", launched ? "PASS" : "FAIL");

        if (!launched) {
            // Isolate flight/catch even if the flick didn't trigger.
            r.mark("note", "flick did not fire; launching directly to test flight/catch");
            fp._launch(ball, "right");
        }

        // --- C. CATCH: ball flies to the hand and is grabbed ---------------
        let caught = false, minDist = Infinity;
        for (let i = 0; i < 28; i++) {
            await r.wait(0.1);
            const d = BABYLON.Vector3.Distance(
                ball.mesh.getBoundingInfo().boundingSphere.centerWorld,
                ctx.hands.hands.right.worldPosition);
            minDist = Math.min(minDist, d);
            if (ball.heldBy === "right") { caught = true; break; }
        }
        r.mark("assert pulled to hand", caught ? `PASS held=${ball.heldBy}` : `FAIL held=${ball.heldBy} minDist=${minDist.toFixed(2)}`);
        r.mark("screenshot:fp-caught");

        // Carry it a little to confirm the held-follow handoff, then drop.
        if (caught) {
            await r.moveHand("right", [0.3, 1.6, -0.2], { over: 0.8 });
            await r.wait(0.4);
            const d = BABYLON.Vector3.Distance(ball.mesh.absolutePosition,
                ctx.physicsHands.hands.right.palmNode.absolutePosition);
            r.mark("assert held after pull", (ball.heldBy === "right" && d < 0.2) ? `PASS (d=${d.toFixed(3)})` : `FAIL d=${d.toFixed(3)} held=${ball.heldBy}`);
            // Grip has been held since the flick: a plain release drops it.
            await r.rampButton("right", "grip", 1, 0, 0.15);
            await r.wait(0.5);
            r.mark("assert dropped on grip release", ball.heldBy === null ? "PASS" : `FAIL (${ball.heldBy})`);
        }
        r.mark("DONE force-pull");
    });
}
