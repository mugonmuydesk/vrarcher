// Phase 6 demo: full scripted shot — grab bow, nock, full draw, release.
// Arrow flies (swept-cast CCD), sticks in the target board downrange;
// assert stick state, parent and hit position. Then verify the next
// arrow respawns and a second (half-draw) shot also lands.

const TARGET_Z = 6; // board front face at z = 5.94 (depth 0.12)

export async function run(rig, ctx) {
    const bow = ctx.bow;
    const arrows = ctx.arrows;
    const xr = (v) => [v.x, v.y, -v.z];

    const back = (k) => {
        const seat = bow.nockRest.getAbsolutePosition();
        const f = bow.flightDirection;
        return xr(seat.subtract(f.scale(k)));
    };

    // Draw-hand position that aims the shot AT the board: put the hand k
    // metres behind the pivot along the pivot->board-centre line (the aim
    // pivot then points the flight dir through the hand at the board).
    const aimAt = (k) => {
        const pivot = bow.aimPivot.getAbsolutePosition();
        const dir = new BABYLON.Vector3(0, 1.45, TARGET_Z).subtract(pivot).normalize();
        return xr(pivot.subtract(dir.scale(k + 0.15)));
    };

    // Poll an arrow until it leaves "flying" (markers, not wall-clock).
    const awaitLanding = async (r, arrow, timeout = 3) => {
        const t0 = performance.now();
        while (arrow.state === "flying" && performance.now() - t0 < timeout * 1000) {
            await r.wait(0.1);
        }
        return arrow.state;
    };

    const shoot = async (r, drawK, label) => {
        await r.moveHand("right", back(0.02), { over: 0.6 });
        await r.wait(0.4);
        await r.rampButton("right", "trigger", 0, 1, 0.2);
        await r.wait(0.3);
        r.mark(`assert nocked (${label})`, arrows.nocked ? "PASS" : "FAIL");
        const fired = arrows.held;
        await r.moveHand("right", aimAt(drawK), { over: 0.7 });
        await r.wait(0.4); // let the aim blend settle on the new hand pose

        // Converge the aim like a player would: the aim pivot's eye-drop
        // offset tilts the shot a few degrees down, so nudge the draw hand
        // until the flight line FROM THE ARROW (nock) through the
        // drop-compensated aim point matches flightDirection. Drop is
        // recomputed from the live pull every iteration.
        for (let i = 0; i < 6; i++) {
            const start = bow.nock.getAbsolutePosition(); // arrow launch point
            const speed = 3 + (arrows.pull - 0.05) / 0.45 * 27;
            const range = TARGET_Z - start.z;
            const drop = 0.5 * 9.81 * (range / speed) ** 2;
            const aimPoint = new BABYLON.Vector3(0, 1.45 + drop, TARGET_Z);
            const want = aimPoint.subtract(start).normalize();
            const err = want.subtract(bow.flightDirection);
            if (err.length() < 0.004) break;
            const corr = err.scale(-0.55); // hand sits ~0.55 m behind the pivot
            const cur = r.state.right.position;
            await r.moveHand("right",
                [cur[0] + corr.x, cur[1] + corr.y, cur[2] - corr.z], { over: 0.25 });
            await r.wait(0.35); // let the 0.15 s aim blend settle
        }
        const fd = bow.flightDirection;
        r.mark(`aim (${label})`, `dir (${fd.x.toFixed(3)}, ${fd.y.toFixed(3)}, ${fd.z.toFixed(3)})`);
        r.mark(`pull (${label})`, `${arrows.pull.toFixed(3)} m`);
        await r.rampButton("right", "trigger", 1, 0, 0.1);
        await r.wait(0.2);
        r.mark(`assert fired (${label})`,
            fired.state === "flying" || fired.state === "stuck" ? "PASS" : `FAIL (${fired.state})`);
        const final = await awaitLanding(r, fired);
        return { fired, final };
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- arm ----------------------------------------------------------
        await r.moveHand("left", [-0.5, 1.2, -0.2], { over: 0.8 });
        await r.wait(0.4);
        await r.rampButton("left", "grip", 0, 1, 0.25);
        await r.wait(0.3);
        r.mark("assert bow held", bow.bowHand === "left" ? "PASS" : `FAIL (${bow.bowHand})`);
        await r.moveHand("left", [-0.15, 1.4, -0.45], { over: 0.6 });
        await r.wait(0.7);
        r.mark("assert arrow spawned", arrows.held ? "PASS" : "FAIL");

        // --- shot 1: full draw ---------------------------------------------
        const s1 = await shoot(r, 0.55, "full");
        r.mark("assert stuck (full)", s1.final === "stuck" ? "PASS" : `FAIL (${s1.final})`);
        const p1 = s1.fired.root.absolutePosition;
        const tipZ = p1.z; // nock end; tip is ~0.7 further but parented under board
        r.mark("stick pos (full)", `(${p1.x.toFixed(2)}, ${p1.y.toFixed(2)}, ${p1.z.toFixed(2)})`);
        r.mark("assert hit near board centre (full)",
            Math.abs(p1.x) < 0.45 && Math.abs(p1.y - 1.45) < 0.4
                && tipZ > TARGET_Z - 0.85 && tipZ < TARGET_Z
                ? "PASS" : "FAIL");
        r.mark("assert parented to target face",
            s1.fired.root.parent === ctx.target.face ? "PASS"
                : `FAIL (${s1.fired.root.parent?.name})`);
        r.mark("screenshot:stuck-full");

        // --- respawn + shot 2: ~3/4 draw (flatter arc still reaches) --------
        await r.wait(0.8); // > 0.5 s cooldown
        r.mark("assert respawn", arrows.held && arrows.held !== s1.fired ? "PASS" : "FAIL");
        const s2 = await shoot(r, 0.4, "mid");
        r.mark("assert stuck (mid)", s2.final === "stuck" ? "PASS" : `FAIL (${s2.final})`);
        const stuckCount = arrows.live.filter(a => a.state === "stuck").length;
        r.mark("assert two arrows stuck", stuckCount === 2 ? "PASS" : `FAIL (${stuckCount})`);
        r.mark("screenshot:two-arrows");
        await r.wait(1.0);

        await r.rampButton("left", "grip", 1, 0, 0.15);
    });
}
