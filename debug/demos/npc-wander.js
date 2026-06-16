// NPC behaviour + navmesh check. Engine-clean NpcBrain + NavGrid tested
// deterministically (synthetic dt/world, immune to render-loop timing):
//   1. navmesh routes AROUND an obstacle (path detours, stays in free space)
//   2. wandering on the navmesh keeps clear and never moonwalks in place
//   3. attends (stop + face) when the player is close AND looking
//   4. ignores a close non-looker; resumes wandering when the player leaves
//   5. live adapter loaded the model + built the navmesh + drives the mover

export async function run(rig, ctx) {
    const v = Date.now();
    const { NpcBrain, NPC_TUNING } = await import('/src/npc.js?v=' + v);
    const { NavGrid } = await import('/src/navmesh.js?v=' + v);
    const T = NPC_TUNING;
    const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return { x: x / l, z: z / l }; };
    rig.mark("script:start");

    // --- 1. NAVMESH routes around an obstacle ------------------------------
    const nav1 = new NavGrid({ bounds: { x0: -4, x1: 4, z0: -3, z1: 3 }, cell: 0.3, obstacles: [{ x: 0, z: 0, r: 0.5 }], clearance: 1.2 });
    const A = { x: -3, z: 0 }, B = { x: 3, z: 0 };
    const path = nav1.findPath(A, B);
    let allClear = !!path, pathLen = 0;
    if (path) {
        let prev = A;
        for (const wp of path) {
            const d = Math.hypot(wp.x - prev.x, wp.z - prev.z); pathLen += d;
            const steps = Math.ceil(d / 0.1);
            for (let i = 0; i <= steps; i++) { const t = i / steps; if (!nav1.isFree(prev.x + (wp.x - prev.x) * t, prev.z + (wp.z - prev.z) * t)) allClear = false; }
            prev = wp;
        }
    }
    const straight = Math.hypot(B.x - A.x, B.z - A.z);
    rig.mark("navmesh", `path ${path ? path.length : 0} wpts, len=${pathLen.toFixed(1)} vs straight ${straight.toFixed(1)}`);
    rig.mark("assert path found", path ? "PASS" : "FAIL");
    rig.mark("assert path clear (routes around)", allClear ? "PASS" : "FAIL");
    rig.mark("assert path detours", pathLen > straight * 1.05 ? "PASS" : `FAIL (${pathLen.toFixed(2)} <= ${straight.toFixed(2)})`);

    // --- 2. WANDER on the navmesh: clear + never moonwalks -----------------
    const obs = [{ x: 0, z: 2, r: 0.4 }, { x: -2.5, z: 0, r: 0.5 }, { x: 2, z: 3.5, r: 0.3 }];
    const nav2 = new NavGrid({ bounds: { x0: -4, x1: 4, z0: -1.5, z1: 5 }, cell: 0.3, obstacles: obs, clearance: T.clearance });
    const b = new NpcBrain({ x: -3, z: 4, obstacles: obs, navigator: nav2 });
    let minClr = Infinity, moonRun = 0, maxMoonRun = 0; const start = { x: b.pos.x, z: b.pos.z };
    for (let i = 0; i < 1200; i++) { // 20 s @ 60 fps, player far
        const px = b.pos.x, pz = b.pos.z;
        b.update(1 / 60, { player: { x: 40, z: 40 }, gaze: { x: 0, z: 1 } });
        minClr = Math.min(minClr, b.minClearance());
        const step = Math.hypot(b.pos.x - px, b.pos.z - pz);
        if (b.moving && step < T.walkSpeed / 60 * 0.25) { moonRun++; maxMoonRun = Math.max(maxMoonRun, moonRun); } else { moonRun = 0; }
    }
    const moved = Math.hypot(b.pos.x - start.x, b.pos.z - start.z);
    rig.mark("wander", `minClearance=${minClr.toFixed(2)}m moved=${moved.toFixed(1)}m maxMoonwalk=${(maxMoonRun / 60).toFixed(2)}s`);
    rig.mark("assert stays clear of props", minClr >= T.clearance - 0.35 ? "PASS" : `FAIL (${minClr.toFixed(2)})`);
    rig.mark("assert wandered", moved > 0.5 ? "PASS" : `FAIL (${moved.toFixed(2)})`);
    rig.mark("assert no sustained moonwalk", maxMoonRun / 60 < 0.7 ? "PASS" : `FAIL (${(maxMoonRun / 60).toFixed(2)}s in place)`);

    // --- 3. ATTEND when the player is close AND looking --------------------
    const player = { x: b.pos.x + 1.5, z: b.pos.z };
    const gazeAt = norm(b.pos.x - player.x, b.pos.z - player.z);
    for (let i = 0; i < 90; i++) b.update(1 / 60, { player, gaze: gazeAt });
    const faceYaw = Math.atan2(player.x - b.pos.x, player.z - b.pos.z);
    const yawErr = Math.abs(((b.yaw - faceYaw + Math.PI) % (2 * Math.PI)) - Math.PI);
    rig.mark("attend", `state=${b.state} moving=${b.moving} yawErr=${(yawErr * 180 / Math.PI).toFixed(1)}deg`);
    rig.mark("assert attends on look", b.state === "attend" ? "PASS" : `FAIL (${b.state})`);
    rig.mark("assert stops moving", b.moving === false ? "PASS" : "FAIL");
    rig.mark("assert turns to face player", yawErr < 0.1 ? "PASS" : `FAIL (${(yawErr * 180 / Math.PI).toFixed(1)}deg)`);

    // --- 4. close but NOT looking -> ignore; then resume -------------------
    const b2 = new NpcBrain({ x: 0, z: 0, obstacles: [], navigator: nav2 });
    for (let i = 0; i < 60; i++) b2.update(1 / 60, { player: { x: 1.4, z: 0 }, gaze: { x: 1, z: 0 } });
    rig.mark("assert ignores close non-looker", b2.state === "wander" ? "PASS" : `FAIL (${b2.state})`);
    for (let i = 0; i < 120; i++) b.update(1 / 60, { player: { x: 40, z: 40 }, gaze: { x: 0, z: 1 } });
    rig.mark("assert resumes wander", b.state === "wander" ? "PASS" : `FAIL (${b.state})`);

    // --- 5. live adapter ---------------------------------------------------
    const live = ctx.npcs?.npcs?.[0];
    if (!live) { rig.mark("assert adapter loaded", "FAIL (no npc)"); }
    else {
        const dMover = Math.hypot(live.mover.position.x - live.brain.pos.x, live.mover.position.z - live.brain.pos.z);
        const free = ctx.npcs.nav ? ctx.npcs.nav.freeCount() : 0;
        rig.mark("adapter", `ready=${ctx.npcs.ready} navFree=${free} dMover=${dMover.toFixed(3)}`);
        rig.mark("assert adapter loaded", ctx.npcs.ready ? "PASS" : "FAIL");
        rig.mark("assert navmesh built", free > 50 ? "PASS" : `FAIL (free=${free})`);
        rig.mark("assert mover follows brain", dMover < 0.01 ? "PASS" : `FAIL (${dMover.toFixed(3)})`);
    }
    rig.mark("DONE npc-wander");
    rig.mark("script:done");
}
