// Phase 5 demo: arrow auto-spawns on the draw hand, magnetic nock,
// scripted two-hand draw cycle with tension asserts and screenshots at
// 0 / half / full draw, then an under-handler release (cancels back to
// the hand — fire is Phase 6) and bow drop (arrow despawns).

export async function run(rig, ctx) {
    const bow = ctx.bow;
    const arrows = ctx.arrows;
    const xr = (v) => [v.x, v.y, -v.z]; // Babylon -> XR coords

    // Hand target k metres straight back from the current nock rest along
    // the current flight direction (recomputed live — the bow aims while
    // nocked, so the seat moves).
    const back = (k) => {
        const seat = bow.nockRest.getAbsolutePosition();
        const f = bow.flightDirection;
        return xr(seat.subtract(f.scale(k)));
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        // --- grab bow with the left hand, hold it out front --------------
        await r.moveHand("left", [-0.5, 1.2, -0.2], { over: 0.8 });
        await r.wait(0.4);
        await r.rampButton("left", "grip", 0, 1, 0.25);
        await r.wait(0.3);
        r.mark("assert bow held", bow.bowHand === "left" ? "PASS" : `FAIL (${bow.bowHand})`);
        await r.moveHand("left", [-0.15, 1.4, -0.45], { over: 0.6 });
        await r.wait(0.7); // past the 0.5 s spawn cooldown
        r.mark("assert arrow spawned", arrows.held ? "PASS" : "FAIL");
        r.mark("assert arrow on hand", arrows.held && !arrows.nocked ? "PASS" : "FAIL");

        // --- magnetic nock ------------------------------------------------
        await r.moveHand("right", back(0.02), { over: 0.8 });
        await r.wait(0.5);
        const seatDist = BABYLON.Vector3.Distance(
            bow.nockOrigin.getAbsolutePosition(), bow.nockRest.getAbsolutePosition());
        r.mark("nock distance", `${seatDist.toFixed(3)} m ${seatDist < 0.10 ? "PASS" : "FAIL"}`);
        await r.rampButton("right", "trigger", 0, 1, 0.2);
        await r.wait(0.3);
        r.mark("assert nocked", arrows.nocked ? "PASS" : "FAIL");
        r.mark("assert arrow parented to nock",
            arrows.held?.root.parent === bow.nock ? "PASS" : "FAIL");
        r.mark("assert aim active", bow.aimActive ? "PASS" : "FAIL");
        r.mark("screenshot:draw-0");
        await r.wait(1.5);

        // --- draw to half ---------------------------------------------------
        await r.moveHand("right", back(0.25), { over: 0.8 });
        await r.wait(0.5);
        r.mark("tension @half",
            `${bow.tension.toFixed(2)} ${Math.abs(bow.tension - 0.5) < 0.15 ? "PASS" : "FAIL"}`);
        r.mark("screenshot:draw-half");
        await r.wait(1.5);

        // --- full draw (overshoot; pull clamps at 0.5) ---------------------
        await r.moveHand("right", back(0.55), { over: 0.8 });
        await r.wait(0.6);
        r.mark("tension @full",
            `${bow.tension.toFixed(2)} ${bow.tension > 0.95 ? "PASS" : "FAIL"}`);
        r.mark("assert nock slid",
            bow.nock.position.z < bow.restZ - 0.4 ? "PASS" : `FAIL (${bow.nock.position.z.toFixed(3)})`);
        r.mark("screenshot:draw-full");
        await r.wait(1.5);

        // --- release: no fire handler in Phase 5 -> cancel back to hand ----
        await r.rampButton("right", "trigger", 1, 0, 0.15);
        await r.wait(0.4);
        r.mark("assert unnocked", !arrows.nocked ? "PASS" : "FAIL");
        r.mark("assert arrow back on hand",
            arrows.held && arrows.held.root.parent === null ? "PASS" : "FAIL");
        r.mark("assert tension reset", bow.tension === 0 ? "PASS" : `FAIL (${bow.tension})`);

        // --- drop the bow: held arrow despawns ------------------------------
        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.5 });
        await r.rampButton("left", "grip", 1, 0, 0.15);
        await r.wait(0.3);
        r.mark("assert arrow despawned",
            !arrows.held && arrows.live.length === 0 ? "PASS" : `FAIL (live ${arrows.live.length})`);
    });
}
