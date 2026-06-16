// Engine-clean node unit test for the commanded-movement layer in NpcBrain.
// Drives update(dt, world) with a synthetic player/heading over a small free
// navmesh region and asserts each voice-FSM command produces the right motion.
// Run: node debug/npc-command-test.mjs   (no Babylon — pure math).

import { NpcBrain, NPC_TUNING as T } from "../src/npc.js";
import { NavGrid } from "../src/navmesh.js";

const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return { x: x / l, z: z / l }; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const yawErr = (a, b) => Math.abs(((a - b + Math.PI) % (2 * Math.PI)) - Math.PI);

let pass = 0, fail = 0;
const ok = (name, cond, info = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };

// Big open free region (no obstacles) so pathing is unconstrained.
const nav = new NavGrid({ bounds: { x0: -12, x1: 12, z0: -12, z1: 12 }, cell: 0.3, obstacles: [], clearance: T.clearance });
const mk = (x, z) => new NpcBrain({ x, z, navigator: nav });
const step = (b, world, n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) b.update(dt, world); };

// --- 1. command=null => wanders (autonomous) ------------------------------
{
    const b = mk(0, 0);
    const start = { x: b.pos.x, z: b.pos.z };
    for (let i = 0; i < 1200; i++) b.update(1 / 60, { player: { x: 30, z: 30 }, gaze: { x: 0, z: 1 } });
    const moved = dist(b.pos, start);
    ok("command=null wanders", b.command === null && moved > 0.5, `state=${b.state} moved=${moved.toFixed(2)}m`);
}

// --- 2. FOLLOW: far player => moves TOWARD, stops within the follow band ---
{
    const b = mk(0, 0);
    const player = { x: 8, z: 0 };
    const heading = norm(1, 0); // player moving +x
    b.setCommand("FOLLOW");
    const d0 = dist(b.pos, player);
    for (let i = 0; i < 1200; i++) b.update(1 / 60, { player, gaze: heading, heading });
    const d1 = dist(b.pos, player);
    ok("FOLLOW closes the gap", d1 < d0 - 1, `d0=${d0.toFixed(2)} -> d1=${d1.toFixed(2)}`);
    ok("FOLLOW stops within follow band", d1 <= T.followMax + 0.6 && d1 >= T.followMin - 0.6, `d=${d1.toFixed(2)} band[${T.followMin},${T.followMax}]`);
    ok("FOLLOW state reported", b.state === "FOLLOW");
}

// --- 3. WAIT: position holds ----------------------------------------------
{
    const b = mk(2, 2);
    b.setCommand("WAIT");
    const player = { x: 5, z: 5 };
    const at = { x: b.pos.x, z: b.pos.z };
    for (let i = 0; i < 600; i++) b.update(1 / 60, { player, gaze: norm(1, 1), heading: null });
    const drift = dist(b.pos, at);
    const fy = Math.atan2(player.x - b.pos.x, player.z - b.pos.z);
    ok("WAIT holds position", drift < 0.02 && b.moving === false, `drift=${drift.toFixed(4)} moving=${b.moving}`);
    ok("WAIT faces player", yawErr(b.yaw, fy) < 0.05, `yawErr=${(yawErr(b.yaw, fy) * 180 / Math.PI).toFixed(1)}deg`);
}

// --- 4. SCOUT: moves AHEAD of the player along heading --------------------
{
    const b = mk(0, 0);
    const player = { x: 0, z: 0 };
    const heading = norm(0, 1); // player facing/moving +z
    b.setCommand("SCOUT");
    for (let i = 0; i < 1200; i++) b.update(1 / 60, { player, gaze: heading, heading });
    // Ahead of the player along +z means a clearly positive z and near the leash.
    const aheadZ = b.pos.z;
    const along = (b.pos.z - player.z); // projection onto heading (+z)
    ok("SCOUT ranges ahead along heading", along > 1.5, `pos.z=${aheadZ.toFixed(2)} leash=${T.scoutLeash}`);
    ok("SCOUT state reported", b.state === "SCOUT");
}

// --- 5. GUARD: faces AWAY from the player ---------------------------------
{
    const b = mk(0, 0);
    const player = { x: 3, z: 0 }; // player to +x; outward face = -x
    b.setCommand("GUARD");
    for (let i = 0; i < 300; i++) b.update(1 / 60, { player, gaze: norm(-1, 0), heading: null });
    const outYaw = Math.atan2(b.pos.x - player.x, b.pos.z - player.z); // away from player
    ok("GUARD holds", b.moving === false);
    ok("GUARD faces away from player", yawErr(b.yaw, outYaw) < 0.1, `yawErr=${(yawErr(b.yaw, outYaw) * 180 / Math.PI).toFixed(1)}deg`);
}

// --- 6. CLOSE: tighter band than FOLLOW -----------------------------------
{
    const b = mk(0, 0);
    const player = { x: 8, z: 0 };
    const heading = norm(1, 0);
    b.setCommand("CLOSE");
    for (let i = 0; i < 1200; i++) b.update(1 / 60, { player, gaze: heading, heading });
    const d = dist(b.pos, player);
    ok("CLOSE sits in the close band", d <= T.closeMax + 0.5 && d < T.followMin, `d=${d.toFixed(2)} closeBand~${T.closeBand}`);
}

// --- 7. release: setCommand(null) resumes wander --------------------------
{
    const b = mk(0, 0);
    b.setCommand("WAIT");
    step(b, { player: { x: 4, z: 0 }, gaze: norm(1, 0) }, 120);
    b.setCommand(null);
    const start = { x: b.pos.x, z: b.pos.z };
    for (let i = 0; i < 1200; i++) b.update(1 / 60, { player: { x: 30, z: 30 }, gaze: { x: 0, z: 1 } });
    ok("release resumes wander", b.command === null && (b.state === "wander" || b.state === "attend") && dist(b.pos, start) > 0.5,
        `state=${b.state} moved=${dist(b.pos, start).toFixed(2)}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
