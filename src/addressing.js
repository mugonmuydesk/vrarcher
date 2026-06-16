// Gaze + proximity addressing — decides WHICH companion/NPC the player is
// talking to, replacing push-to-talk's "who". Each frame it ranks NPCs within
// range by how close they are to the player's gaze (primary) and how near they
// are (tiebreaker), then applies two timers so a glance doesn't flip the target:
//   • dwell-to-acquire  — must look at a candidate ~250 ms before it locks in
//   • linger-to-release — keep the current target ~1.5 s after the gaze leaves
// so looking around mid-sentence (or briefly at another NPC) doesn't drop who
// you're addressing. The locked target is the speech intent signal: the mic/VAD
// routes the utterance (and the spoken reply pans) to ctx.addressing.target.
//
// ENGINE-CLEAN scoring (scoreNpc / pickBest are pure, portable); the Babylon
// adapter only supplies head pose + NPC positions. PORT: feed the native head
// transform + NPC list to the same scorer; the state machine is identical.

export const ADDRESS_TUNING = {
    rangeM: 5.0,            // only NPCs within this many metres are candidates
    maxAngleDeg: 55,        // gaze cone half-angle; beyond this you're not looking at them
    headOffsetY: 1.1,       // m — aim at the NPC's head/torso, not its feet
    acquireMs: 250,         // sustained gaze on a new candidate before it becomes target
    lingerMs: 1500,         // keep target this long after gaze leaves / looks at nothing
    wAngle: 0.7,            // gaze-proximity weight (primary)
    wDist: 0.3,             // distance weight (tiebreaker)
};

// Pure: score one NPC for "is the player looking at it". Returns a number in
// [0,1] (higher = more addressed) or -1 if out of range / outside the gaze cone.
// headPos/headFwd are Vector3-likes ({x,y,z}); npcPos is the NPC's aim point.
export function scoreNpc(headPos, headFwd, npcPos, T = ADDRESS_TUNING) {
    const dx = npcPos.x - headPos.x, dy = npcPos.y - headPos.y, dz = npcPos.z - headPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > T.rangeM || dist < 1e-3) return -1;
    const fl = Math.hypot(headFwd.x, headFwd.y, headFwd.z) || 1;
    const cos = (dx * headFwd.x + dy * headFwd.y + dz * headFwd.z) / (dist * fl);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (angle > T.maxAngleDeg) return -1;
    return T.wAngle * (1 - angle / T.maxAngleDeg) + T.wDist * (1 - dist / T.rangeM);
}

export class Addressing {
    // npcsOf(ctx) → array of NPCs each exposing a world position (default reads
    // ctx.npcs.npcs[].mover.position); posOf(npc) → its aim point.
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.T = { ...ADDRESS_TUNING, ...opts };
        this._npcsOf = opts.npcsOf ?? ((c) => c.npcs?.npcs ?? []);
        this._posOf = opts.posOf ?? ((n) => n.mover?.position ?? n.position);
        this.target = null;        // the addressed NPC (or null)
        this.candidate = null;     // best NPC this frame (pre-dwell)
        this._pending = null;      // candidate accumulating dwell time
        this._dwell = 0;           // ms the pending candidate has been best
        this._linger = 0;          // ms since the target stopped being looked at
        ctx.updatables.push((dt) => this.update(dt));
    }

    update(dt) {
        const ms = dt * 1000;
        const cam = this.ctx.scene?.activeCamera;
        const npcs = this._npcsOf(this.ctx);
        let best = null, bestScore = -1;
        if (cam) {
            const headPos = cam.globalPosition;
            const headFwd = cam.getDirection(BABYLON.Axis.Z);
            for (const n of npcs) {
                const p = this._posOf(n); if (!p) continue;
                const aim = { x: p.x, y: p.y + this.T.headOffsetY, z: p.z };
                const s = scoreNpc(headPos, headFwd, aim, this.T);
                if (s > bestScore) { bestScore = s; best = n; }
            }
        }
        this.candidate = best;

        if (best && best === this.target) {
            this._linger = 0; this._pending = null; this._dwell = 0;   // firmly on target
            return;
        }
        if (best) {
            // Accumulate dwell on a (new) best candidate; lock it once sustained.
            if (best === this._pending) this._dwell += ms; else { this._pending = best; this._dwell = 0; }
            if (this._dwell >= this.T.acquireMs) {
                this.target = best; this._linger = 0; this._pending = null; this._dwell = 0;
                this._onTarget?.(this.target);
            }
        } else {
            this._pending = null; this._dwell = 0;
        }
        // Not looking at the current target → start releasing it.
        if (this.target && best !== this.target) {
            this._linger += ms;
            if (this._linger >= this.T.lingerMs) { this.target = null; this._linger = 0; this._onTarget?.(null); }
        }
    }

    // Optional callback fired when the locked target changes (incl. → null).
    onTargetChange(fn) { this._onTarget = fn; }
}
