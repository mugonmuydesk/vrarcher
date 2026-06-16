// Grab-the-ball check: touch-grab lifecycle on the scene ball (makeThrowable,
// auto-catch). Hand -> hover -> grip-grab -> parented -> carry -> release.
// The ball was moved to +5 X with the other non-archery props, so this also
// exercises a long hand reach. Babylon (x,y,z) -> XR (x,y,-z).

export async function run(rig, ctx) {
    const find = (name) => [...ctx.interaction.interactables].find(i => i.mesh.name === name);
    const ball = find("ball");
    if (!ball) { rig.mark("FAIL: ball interactable not found"); return; }

    await rig.run(async (r) => {
        r.reset();
        await r.wait(0.8);

        const spawn = ball.mesh.absolutePosition.clone();       // Babylon world
        r.mark("ball spawn", `(${spawn.x.toFixed(2)},${spawn.y.toFixed(2)},${spawn.z.toFixed(2)})`);

        // Where the palm should land (ball centre). Babylon (x,y,z) maps to
        // the rig's XR command as (x,y,-z), but XR entry bakes a position
        // offset, so open-loop aiming lands ~0.9 m off. Closed-loop instead:
        // command, measure the Babylon-space palm error, fold it back into
        // the command (Jacobian ≈ diag(1,1,-1)) and re-command until on-ball.
        const bp = () => ball.mesh.getBoundingInfo().boundingSphere.centerWorld;
        const h = ctx.hands.hands.right;
        // Pre-squeeze the grip to 0.4: above the grab-intent threshold (0.3)
        // so hand collision suspends and the approach can't punt the ball,
        // but below the grab commit (justPressed at 0.5).
        r.setGrip("right", 0.4);
        let cmd = [bp().x, bp().y, -bp().z];
        let err = Infinity;
        for (let i = 0; i < 7; i++) {
            await r.moveHand("right", cmd, { over: i === 0 ? 1.0 : 0.4 });
            await r.wait(0.3);
            const palm = h.worldPosition, tgt = bp();
            const e = tgt.subtract(palm);
            err = e.length();
            if (err < 0.04) break;
            cmd = [cmd[0] + e.x, cmd[1] + e.y, cmd[2] - e.z];
        }
        await r.wait(0.3);
        ctx.interaction._pollHover();
        const palm = h.worldPosition;
        r.mark("hand at ball", `track=${h.tracking} reachErr=${err.toFixed(3)} d2surf=${ball.distanceTo(palm).toFixed(3)} palm=(${palm.x.toFixed(2)},${palm.y.toFixed(2)},${palm.z.toFixed(2)})`);
        r.mark("assert hover", ball.hoveredBy === "right" ? "PASS" : `FAIL (${ball.hoveredBy})`);

        // Commit the grab: 0.4 -> 1.0 crosses justPressed.
        await r.rampButton("right", "grip", 0.4, 1, 0.25);
        await r.wait(0.3);
        r.mark("assert held", ball.heldBy === "right" ? "PASS" : `FAIL (${ball.heldBy})`);
        r.mark("assert parented", ball.mesh.parent ? "PASS" : "FAIL");
        r.mark("screenshot:ball-held");

        // Carry it slowly up and back toward the player (-X), then let the
        // palm servo settle. The ball is parented to the palm node (visual
        // hand), so assert against THAT, not the grip (which the palm lags
        // during motion).
        await r.moveHand("right", [cmd[0] - 0.4, cmd[1] + 0.35, cmd[2] + 0.15], { over: 1.3 });
        await r.wait(1.0);
        const palmNode = ctx.physicsHands.hands.right.palmNode.absolutePosition;
        const carried = BABYLON.Vector3.Distance(ball.mesh.absolutePosition, palmNode);
        const moved = BABYLON.Vector3.Distance(ball.mesh.absolutePosition, spawn);
        r.mark("assert carried", (carried < 0.2 && ball.heldBy === "right")
            ? `PASS (moved ${moved.toFixed(2)}m, ball-palm ${carried.toFixed(3)})`
            : `FAIL d=${carried.toFixed(3)} held=${ball.heldBy}`);

        // Release.
        await r.rampButton("right", "grip", 1, 0, 0.2);
        await r.wait(0.4);
        r.mark("assert released", ball.heldBy === null ? "PASS" : `FAIL (${ball.heldBy})`);
        r.mark("DONE grab-ball");
    });
}
