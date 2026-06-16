// Engine-clean NPC behaviour brain. Pure 2D ground-plane math, NO engine
// imports — this transcribes 1:1 to a Unity MonoBehaviour. The adapter
// (npcsystem.js) feeds it world state each frame and applies the returned
// position / yaw / locomotion to a Babylon transform + animation.
//
// Behaviour: wander the ground keeping `clearance` away from every obstacle
// (and the player); when the player comes within attendRadius AND is looking
// at the NPC, stop and turn to face them (attend); resume wandering when they
// leave or look away. The state machine is frame-driven (update(dt, world))
// so it ports to Update() and is deterministic for demo asserts. This is also
// the seam the chat layer plugs into later: `attend` is where a dialogue turn
// would begin.

export const NPC_TUNING = {
    walkSpeed: 0.85,      // m/s wander speed
    turnRate: 3.0,        // rad/s max yaw slew (no snapping)
    arriveDist: 0.45,     // m — wander target considered reached
    pauseMin: 0.6,        // s idle between wander legs
    pauseMax: 2.2,
    // Berth kept from every prop (navmesh block radius) + the player. 2.0 m
    // (the original ask) seals this cluttered arena into disconnected pockets
    // (only ~22% walkable); 1.2 m keeps a clear gap yet leaves the walkable
    // area fully connected (~57%). The navmesh routes around props at any value.
    clearance: 1.2,       // m
    attendRadius: 2.0,    // m — player within this (and looking) triggers attend
    attendHyst: 0.6,      // m — must get this much further away to drop attend
    gazeCos: Math.cos(40 * Math.PI / 180), // player "looking at me" cone half-angle
    loseGaze: 0.8,        // s — keep attending this long after the gaze leaves
    region: { x0: -4.5, x1: 2.5, z0: -1.0, z1: 5.0 }, // wander bounds (flat arena)

    // --- Commanded movement (voice-FSM driven). Active only when setCommand()
    //     is given a state; null/"none" leaves the autonomous wander/attend. ---
    followSpeed: 2.4,     // m/s — base catch-up speed (player tops out at 2.5 m/s)
    followCatchup: 1.6,   // x — speed multiplier when far behind (dist > followMax*2)
    followMin: 1.4,       // m — stop closing once inside this of the player (hysteresis low)
    followMax: 2.2,       // m — resume closing once beyond this of the player (hysteresis high)
    followTarget: 2.0,    // m — desired standoff behind the player along their heading
    closeBand: 1.0,       // m — CLOSE target standoff (tight; overrides player clearance)
    closeMin: 0.85,       // m — CLOSE stop-closing radius (hysteresis low)
    closeMax: 1.25,       // m — CLOSE resume-closing radius (hysteresis high)
    scoutLeash: 3.5,      // m — how far AHEAD of the player SCOUT ranges along heading
    scoutReturn: 5.0,     // m — if player falls this far behind, SCOUT heads back to FOLLOW
    restDrift: 0.25,      // m — REST allowed idle drift radius around its hold spot
    rePathDist: 0.4,      // m — re-path only when player/goal moved this far
    rePathInterval: 0.3,  // s — or at least this often (whichever first)
};

// --- tiny 2D (x,z ground-plane) helpers -----------------------------------
const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const len = (v) => Math.hypot(v.x, v.z);
const norm = (v) => { const l = len(v) || 1; return { x: v.x / l, z: v.z / l }; };
const dot = (a, b) => a.x * b.x + a.z * b.z;
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export class NpcBrain {
    // opts: { x, z, yaw, obstacles: [{x,z,r}] }
    constructor({ x = 0, z = 0, yaw = 0, obstacles = [], navigator = null } = {}) {
        this.pos = { x, z };
        this.yaw = yaw;            // facing radians, 0 = +Z
        this.obstacles = obstacles; // kept for minClearance() / demos
        this.nav = navigator;     // NavGrid — engine-clean A* pathfinder
        this.state = "wander";    // "wander" | "attend" | <command name>
        this.moving = false;
        this._path = null;        // [{x,z}] world waypoints to the current goal
        this._wp = 0;
        this._pause = NPC_TUNING.pauseMin;
        this._loseTimer = 0;
        this._stuckT = 0;
        this._stuckRef = { x, z };
        // Commanded mode: null/"none" => autonomous wander/attend. A voice FSM
        // state ("FOLLOW"/"WAIT"/...) makes update() dispatch to per-command
        // movement instead. The companion roams until the player commands it.
        this.command = null;
        this._cmdGoal = null;     // current commanded goal {x,z}, for re-path throttle
        this._rePathT = 0;        // s since last re-path
        this._closing = false;    // FOLLOW/CLOSE hysteresis latch (are we closing in?)
        this._restAnchor = null;  // REST hold spot
        this._pickTarget();
    }

    setObstacles(obs) { this.obstacles = obs; }

    // Set the commanded movement state (a voice-FSM state string), or null /
    // "none" to release back to autonomous wander/attend. Idempotent re-issues
    // of the same command are harmless (they just keep the mode active).
    setCommand(state) {
        const next = (!state || state === "none") ? null : state;
        if (next === this.command) return;
        this.command = next;
        // Fresh command: drop any stale autonomous/commanded path + latches so the
        // new behaviour re-plans from the current pose.
        this._path = null; this._cmdGoal = null; this._rePathT = 0;
        this._closing = false; this._restAnchor = null;
        if (next === null) { this.state = "wander"; this._pickTarget(); }  // resume wander cleanly
    }

    // world: { player: {x,z} | null, gaze: {x,z} | null, heading: {x,z} | null }
    // — gaze is the player's normalized horizontal look direction; heading is
    // their normalized travel direction (falls back to gaze when not moving).
    update(dt, world) {
        const T = NPC_TUNING;
        const player = world && world.player;

        // Commanded mode short-circuits the autonomous wander/attend.
        if (this.command) { this._commanded(dt, world); return this._out(); }

        const toPlayer = player ? sub(player, this.pos) : null;
        const dPlayer = toPlayer ? len(toPlayer) : Infinity;
        const looking = (player && world.gaze)
            ? dot(norm(sub(this.pos, player)), world.gaze) > T.gazeCos
            : false;

        if (this.state === "attend") {
            this._loseTimer = looking ? 0 : this._loseTimer + dt;
            if (dPlayer > T.attendRadius + T.attendHyst || this._loseTimer > T.loseGaze) {
                this.state = "wander";
                this._pickTarget();
            } else {
                this.moving = false;
                this._slewYaw(Math.atan2(toPlayer.x, toPlayer.z), dt); // face the player
                return this._out();
            }
        }

        // wander (may flip to attend this frame)
        if (dPlayer <= T.attendRadius && looking) {
            this.state = "attend";
            this._loseTimer = 0;
            this.moving = false;
            return this._out();
        }
        this._wander(dt, player);
        return this._out();
    }

    _wander(dt, player) {
        const T = NPC_TUNING;
        // The navmesh path already routes around the static props; only the
        // (dynamic) player needs a live separation so the NPC keeps clear.
        if (player) {
            const d = sub(this.pos, player), l = len(d);
            if (l < T.clearance && l > 1e-3) { this.pos.x = player.x + d.x / l * T.clearance; this.pos.z = player.z + d.z / l * T.clearance; }
        }

        if (this._pause > 0) { this._pause -= dt; this.moving = false; return; }
        if (!this._path) {
            this._pickTarget();
            if (!this._path) { this._beginPause(); this.moving = false; return; }
        }

        // Follow waypoints; skip any we've already reached.
        let wp = this._path[this._wp];
        let to = sub(wp, this.pos), dist = len(to);
        while (dist < T.arriveDist && this._wp < this._path.length - 1) {
            this._wp++; wp = this._path[this._wp]; to = sub(wp, this.pos); dist = len(to);
        }
        if (dist < T.arriveDist) { this._path = null; this._beginPause(); this.moving = false; return; }

        const v = norm(to);
        this.pos.x += v.x * T.walkSpeed * dt;
        this.pos.z += v.z * T.walkSpeed * dt;
        this.moving = true;
        this._slewYaw(Math.atan2(v.x, v.z), dt); // face travel direction

        // Stuck (the player is standing on the path): abandon + pause so it
        // idles rather than moonwalking into them, then re-path next leg.
        this._stuckT += dt;
        if (this._stuckT >= 0.6) {
            const prog = Math.hypot(this.pos.x - this._stuckRef.x, this.pos.z - this._stuckRef.z);
            this._stuckT = 0; this._stuckRef = { x: this.pos.x, z: this.pos.z };
            if (prog < 0.12) { this._path = null; this._beginPause(); }
        }
    }

    // ===== Commanded movement (voice-FSM driven) ==========================
    // Dispatch on this.command. Sets this.state to the command name so the HUD
    // / walk-idle blend reflect it. Engine-clean: same pathfind + slewYaw
    // primitives as wander.
    _commanded(dt, world) {
        const player = world && world.player;
        const heading = this._heading(world);
        this.state = this.command;
        if (!player) { this.moving = false; return; }   // nothing to anchor to
        switch (this.command) {
            case "FOLLOW": this._cmdFollow(dt, player, heading, NPC_TUNING.followMin, NPC_TUNING.followMax, false); break;
            case "CLOSE":  this._cmdFollow(dt, player, heading, NPC_TUNING.closeMin, NPC_TUNING.closeMax, true); break;
            case "SCOUT":  this._cmdScout(dt, player, heading); break;
            case "GUARD":  this._cmdHold(dt, player, /*faceOut*/true); break;
            case "ENGAGE": this._cmdEngage(dt, player, heading); break;
            case "REST":   this._cmdRest(dt, player); break;
            case "WAIT":   // fallthrough — stop, face the player, hold
            default:       this._cmdHold(dt, player, /*faceOut*/false); break;
        }
    }

    // Player travel direction (normalized x,z) or gaze fallback or null.
    _heading(world) {
        const h = world && world.heading;
        if (h && (Math.abs(h.x) > 1e-3 || Math.abs(h.z) > 1e-3)) return norm(h);
        const g = world && world.gaze;
        return g ? norm(g) : null;
    }

    // Path to `goal` and step one frame toward it at `speed`. Re-paths only when
    // the goal moved > rePathDist or every rePathInterval (throttle), not every
    // frame. Returns { arrived, dist } where dist is the straight-line gap to the
    // goal. Faces travel direction while moving.
    _goTo(goal, dt, speed) {
        const T = NPC_TUNING;
        const gap = len(sub(goal, this.pos));
        this._rePathT += dt;
        const goalMoved = !this._cmdGoal || len(sub(goal, this._cmdGoal)) > T.rePathDist;
        if (!this._path || goalMoved || this._rePathT >= T.rePathInterval) {
            this._cmdGoal = { x: goal.x, z: goal.z };
            this._rePathT = 0;
            this._path = this.nav ? this.nav.findPath(this.pos, goal) : [{ x: goal.x, z: goal.z }];
            this._wp = 0;
        }
        if (!this._path || !this._path.length) { this.moving = false; return { arrived: gap < T.arriveDist, dist: gap }; }

        let wp = this._path[this._wp];
        let to = sub(wp, this.pos), dist = len(to);
        while (dist < T.arriveDist && this._wp < this._path.length - 1) {
            this._wp++; wp = this._path[this._wp]; to = sub(wp, this.pos); dist = len(to);
        }
        if (dist < T.arriveDist) { this.moving = false; return { arrived: gap < T.arriveDist, dist: gap }; }

        const v = norm(to);
        this.pos.x += v.x * speed * dt;
        this.pos.z += v.z * speed * dt;
        this.moving = true;
        this._slewYaw(Math.atan2(v.x, v.z), dt);
        return { arrived: false, dist: gap };
    }

    // FOLLOW / CLOSE: keep a standoff band behind the player. Hysteresis on the
    // distance so it doesn't jitter at the band edge. `tight` (CLOSE) ignores the
    // wander player-clearance so it may sit inside the close band.
    _cmdFollow(dt, player, heading, stopMin, resumeMax, tight) {
        const T = NPC_TUNING;
        const d = len(sub(player, this.pos));
        // Hysteresis: start closing when beyond resumeMax, stop when inside stopMin.
        if (d > resumeMax) this._closing = true;
        else if (d < stopMin) this._closing = false;

        if (!this._closing) {
            // Holding: stop, face the player.
            this.moving = false;
            this.faceYaw = Math.atan2(player.x - this.pos.x, player.z - this.pos.z);
            this._slewYaw(this.faceYaw, dt);
            return;
        }
        // Aim for a point a short standoff behind the player along their heading
        // (so it tucks in behind rather than crowding the camera). No heading =>
        // just the player position.
        const stand = tight ? T.closeBand : T.followTarget;
        const goal = heading
            ? { x: player.x - heading.x * stand, z: player.z - heading.z * stand }
            : { x: player.x, z: player.z };
        // Catch-up: sprint when a long way back.
        const speed = (d > resumeMax * 2) ? T.followSpeed * T.followCatchup : T.followSpeed;
        this._goTo(goal, dt, speed);
        if (!tight) this._separate(player, T.clearance);  // FOLLOW respects wander berth
        // Face travel dir while moving (set by _goTo); if it stalled, face player.
        if (!this.moving) this._slewYaw(Math.atan2(player.x - this.pos.x, player.z - this.pos.z), dt);
    }

    // SCOUT: range ahead of the player along their heading, clamped to a free
    // navmesh cell. Advances as the player moves forward; if the player falls too
    // far behind, fall back toward the FOLLOW band.
    _cmdScout(dt, player, heading) {
        const T = NPC_TUNING;
        const back = len(sub(this.pos, player));
        if (back > T.scoutReturn) { // player left behind — regroup like FOLLOW
            this._cmdFollow(dt, player, heading, T.followMin, T.followMax, false);
            return;
        }
        const dir = heading || { x: 0, z: 1 };
        let goal = { x: player.x + dir.x * T.scoutLeash, z: player.z + dir.z * T.scoutLeash };
        if (this.nav) goal = this._clampFree(goal);
        const r = this._goTo(goal, dt, T.followSpeed);
        if (r.arrived) { this.moving = false; this._slewYaw(Math.atan2(dir.x, dir.z), dt); }
    }

    // WAIT / GUARD: hold position. WAIT faces the player; GUARD faces OUTWARD
    // (away from the player) — posture stub, no enemy targeting yet.
    _cmdHold(dt, player, faceOut) {
        this.moving = false;
        const dx = faceOut ? (this.pos.x - player.x) : (player.x - this.pos.x);
        const dz = faceOut ? (this.pos.z - player.z) : (player.z - this.pos.z);
        if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) this._slewYaw(Math.atan2(dx, dz), dt);
    }

    // REST: relaxed hold near the player with a small idle drift; face the player.
    _cmdRest(dt, player) {
        const T = NPC_TUNING;
        if (!this._restAnchor) this._restAnchor = { x: this.pos.x, z: this.pos.z };
        // Allow small drift back toward the anchor if nudged out (mostly idle).
        const off = len(sub(this.pos, this._restAnchor));
        if (off > T.restDrift) {
            const r = this._goTo(this._restAnchor, dt, NPC_TUNING.walkSpeed);
            if (r.arrived) this.moving = false;
        } else {
            this.moving = false;
        }
        this._slewYaw(Math.atan2(player.x - this.pos.x, player.z - this.pos.z), dt);
    }

    // ENGAGE: posture stub — hold and face the player's forward/heading. No enemy
    // to chase yet. TODO(combat): drive to the target and strafe/cover here.
    _cmdEngage(dt, player, heading) {
        this.moving = false;
        const dir = heading || norm(sub(player, this.pos));
        if (dir && (Math.abs(dir.x) > 1e-4 || Math.abs(dir.z) > 1e-4)) this._slewYaw(Math.atan2(dir.x, dir.z), dt);
    }

    // Push out of the player so we keep `r` separation (dynamic obstacle).
    _separate(player, r) {
        const d = sub(this.pos, player), l = len(d);
        if (l < r && l > 1e-3) { this.pos.x = player.x + d.x / l * r; this.pos.z = player.z + d.z / l * r; }
    }

    // Clamp a world goal to the nearest free navmesh cell centre (and bounds).
    _clampFree(goal) {
        if (this.nav.isFree(goal.x, goal.z)) return goal;
        const c = this.nav._nearestFreeCell(goal.x, goal.z);
        if (!c) return goal;
        return { x: this.nav._wx(c.ix), z: this.nav._wz(c.iz) };
    }

    _beginPause() {
        const T = NPC_TUNING;
        this._pause = T.pauseMin + Math.random() * (T.pauseMax - T.pauseMin);
    }

    // Pick a random free goal in the region and A*-path to it (navmesh).
    _pickTarget() {
        const T = NPC_TUNING, R = T.region;
        this._stuckT = 0; this._stuckRef = { x: this.pos.x, z: this.pos.z };
        for (let i = 0; i < 30; i++) {
            const x = R.x0 + Math.random() * (R.x1 - R.x0);
            const z = R.z0 + Math.random() * (R.z1 - R.z0);
            if (Math.hypot(x - this.pos.x, z - this.pos.z) < 1.0) continue;
            if (this.nav && !this.nav.isFree(x, z)) continue;
            const path = this.nav ? this.nav.findPath(this.pos, { x, z }) : [{ x, z }];
            if (path && path.length) { this._path = path; this._wp = 0; return; }
        }
        this._path = null; // nothing reachable this try — caller will pause
    }

    _slewYaw(desired, dt) {
        const d = wrapPi(desired - this.yaw);
        this.yaw = wrapPi(this.yaw + Math.sign(d) * Math.min(Math.abs(d), NPC_TUNING.turnRate * dt));
    }

    // Smallest clearance to any obstacle (for demo asserts / debug).
    minClearance() {
        let m = Infinity;
        for (const o of this.obstacles) m = Math.min(m, Math.hypot(this.pos.x - o.x, this.pos.z - o.z) - (o.r || 0));
        return m;
    }

    _out() { return { x: this.pos.x, z: this.pos.z, yaw: this.yaw, moving: this.moving, state: this.state }; }
}
