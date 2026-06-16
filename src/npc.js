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
        this.state = "wander";    // "wander" | "attend"
        this.moving = false;
        this._path = null;        // [{x,z}] world waypoints to the current goal
        this._wp = 0;
        this._pause = NPC_TUNING.pauseMin;
        this._loseTimer = 0;
        this._stuckT = 0;
        this._stuckRef = { x, z };
        this._pickTarget();
    }

    setObstacles(obs) { this.obstacles = obs; }

    // world: { player: {x,z} | null, gaze: {x,z} | null } — gaze is the
    // player's normalized horizontal look direction.
    update(dt, world) {
        const T = NPC_TUNING;
        const player = world && world.player;
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
