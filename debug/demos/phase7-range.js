// Phase 7 demo: three scored shots at the ring target — assert each hit's
// score increment matches the ring under the actual stick point and the
// scoreboard total adds up — then a ground shot to verify spent-arrow
// cleanup (despawn after the TTL).

const TARGET_Z = 6;

export async function run(rig, ctx) {
    const bow = ctx.bow;
    const arrows = ctx.arrows;
    const target = ctx.target;
    const xr = (v) => [v.x, v.y, -v.z];

    const nockArrow = async (r) => {
        const seat = bow.nockRest.getAbsolutePosition();
        const near = seat.subtract(bow.flightDirection.scale(0.02));
        await r.moveHand("right", xr(near), { over: 0.6 });
        await r.wait(0.3);
        await r.rampButton("right", "trigger", 0, 1, 0.2);
        await r.wait(0.2);
    };

    // Aim-converged shot at a world point on the face; returns the fired arrow.
    const shoot = async (r, aimX, aimY, drawK) => {
        await r.wait(0.8); // respawn cooldown
        await nockArrow(r);
        const pivot0 = bow.aimPivot.getAbsolutePosition();
        const d0 = new BABYLON.Vector3(aimX, aimY, TARGET_Z).subtract(pivot0).normalize();
        const hd = pivot0.subtract(d0.scale(drawK + 0.15));
        await r.moveHand("right", xr(hd), { over: 0.6 });
        await r.wait(0.4);
        for (let i = 0; i < 6; i++) {
            const start = bow.nock.getAbsolutePosition();
            const speed = 3 + (arrows.pull - 0.05) / 0.45 * 27;
            const drop = 0.5 * 9.81 * ((TARGET_Z - start.z) / speed) ** 2;
            const want = new BABYLON.Vector3(aimX, aimY + drop, TARGET_Z)
                .subtract(start).normalize();
            const err = want.subtract(bow.flightDirection);
            if (err.length() < 0.004) break;
            const corr = err.scale(-0.55);
            const cur = r.state.right.position;
            await r.moveHand("right",
                [cur[0] + corr.x, cur[1] + corr.y, cur[2] - corr.z], { over: 0.25 });
            await r.wait(0.35);
        }
        const fired = arrows.held;
        await r.rampButton("right", "trigger", 1, 0, 0.1);
        await r.wait(1.0);
        return fired;
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);
        await r.moveHand("left", [-0.5, 1.2, -0.2], { over: 0.8 });
        await r.wait(0.4);
        await r.rampButton("left", "grip", 0, 1, 0.25);
        await r.wait(0.3);
        r.mark("assert bow held", bow.bowHand === "left" ? "PASS" : "FAIL");
        await r.moveHand("left", [-0.15, 1.4, -0.45], { over: 0.6 });
        await r.wait(0.7);

        // --- three scored shots: centre, mid ring, outer ring ------------
        const aims = [[0, 1.45], [0.26, 1.4], [0, 1.85]];
        let expected = 0;
        for (let i = 0; i < aims.length; i++) {
            const before = target.score;
            const fired = await shoot(r, aims[i][0], aims[i][1], 0.45);
            r.mark(`assert stuck (shot ${i + 1})`,
                fired.state === "stuck" ? "PASS" : `FAIL (${fired.state})`);
            const delta = target.score - before;
            const ringScore = target.lastHit ? target.ringScoreFor(target.lastHit.point) : -1;
            expected += ringScore;
            r.mark(`score (shot ${i + 1})`,
                `+${delta} (ring says ${ringScore}) ${delta === ringScore && delta > 0 ? "PASS" : "FAIL"}`);
        }
        r.mark("assert total", `${target.score} ${target.score === expected ? "PASS" : "FAIL"}`);
        r.mark("assert hits", target.hits === 3 ? "PASS" : `FAIL (${target.hits})`);
        r.mark("screenshot:scored-target");
        await r.wait(1.5);

        // --- spent-arrow cleanup: shoot the ground, wait out the TTL -------
        const liveBefore = arrows.live.length;
        await r.wait(0.8);
        await nockArrow(r);
        // weak shot pitched down at open ground in front of the target
        const pivot = bow.aimPivot.getAbsolutePosition();
        const d = new BABYLON.Vector3(1.5, 0, 3.5).subtract(pivot).normalize();
        const hd = pivot.subtract(d.scale(0.35));
        await r.moveHand("right", xr(hd), { over: 0.6 });
        await r.wait(0.5);
        const groundArrow = arrows.held;
        await r.rampButton("right", "trigger", 1, 0, 0.1);
        await r.wait(2.0);
        r.mark("assert ground shot spent",
            groundArrow.state === "spent" ? "PASS" : `FAIL (${groundArrow.state})`);
        r.mark("waiting out spent TTL (8 s)...");
        await r.wait(8.0);
        r.mark("assert spent arrow cleaned up",
            groundArrow.root.isDisposed() ? "PASS" : "FAIL");
        r.mark("assert stuck arrows persist",
            arrows.live.filter(a => a.state === "stuck").length === 3 ? "PASS" : "FAIL");

        await r.rampButton("left", "grip", 1, 0, 0.15);
    });
}
