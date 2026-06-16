// Grid navmesh + A* pathfinding for ground NPCs. Engine-clean (pure math, no
// engine imports): a rectangular ground region is rasterised into a cell grid,
// cells within (obstacle.r + clearance) of any obstacle are marked blocked,
// and findPath() A*-routes between free cells and string-pulls the result to a
// short list of world waypoints. The NPC brain follows those waypoints, so it
// routes AROUND props instead of pressing into them.
//
// PORT: in the native build this whole module is replaced by Unity's
// NavMesh + NavMeshAgent (bake the arena, SetDestination, let the agent
// follow). The brain only needs "give me a path to X" / "follow it", which
// maps directly onto NavMeshAgent.

const SQRT2 = Math.SQRT2;

export class NavGrid {
    // opts: { bounds:{x0,x1,z0,z1}, cell, obstacles:[{x,z,r}], clearance }
    constructor({ bounds, cell = 0.3, obstacles = [], clearance = 2.0 } = {}) {
        this.b = bounds;
        this.cell = cell;
        this.nx = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cell));
        this.nz = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / cell));
        this.blocked = new Uint8Array(this.nx * this.nz);
        for (const o of obstacles) this._stamp(o.x, o.z, (o.r || 0) + clearance);
    }

    _stamp(cx, cz, R) {
        const { x0, z0 } = this.b, c = this.cell, R2 = R * R;
        const ix0 = Math.max(0, Math.floor((cx - R - x0) / c));
        const ix1 = Math.min(this.nx - 1, Math.ceil((cx + R - x0) / c));
        const iz0 = Math.max(0, Math.floor((cz - R - z0) / c));
        const iz1 = Math.min(this.nz - 1, Math.ceil((cz + R - z0) / c));
        for (let iz = iz0; iz <= iz1; iz++) {
            for (let ix = ix0; ix <= ix1; ix++) {
                const wx = x0 + (ix + 0.5) * c, wz = z0 + (iz + 0.5) * c;
                if ((wx - cx) ** 2 + (wz - cz) ** 2 <= R2) this.blocked[iz * this.nx + ix] = 1;
            }
        }
    }

    _ix(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.b.x0) / this.cell))); }
    _iz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.b.z0) / this.cell))); }
    _wx(ix) { return this.b.x0 + (ix + 0.5) * this.cell; }
    _wz(iz) { return this.b.z0 + (iz + 0.5) * this.cell; }
    _free(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz && !this.blocked[iz * this.nx + ix]; }

    isFree(x, z) { return this._free(this._ix(x), this._iz(z)); }

    // Nearest free cell to a world point, as {ix,iz} (ring-expanding search).
    _nearestFreeCell(x, z) {
        const cx = this._ix(x), cz = this._iz(z);
        if (this._free(cx, cz)) return { ix: cx, iz: cz };
        for (let r = 1; r < Math.max(this.nx, this.nz); r++) {
            for (let dz = -r; dz <= r; dz++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    if (this._free(cx + dx, cz + dz)) return { ix: cx + dx, iz: cz + dz };
                }
            }
        }
        return null;
    }

    // Clear straight line between two world points (sampled at half-cell steps).
    lineClear(ax, az, bx, bz) {
        const d = Math.hypot(bx - ax, bz - az);
        const steps = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            if (!this.isFree(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
        }
        return true;
    }

    // A* from `from` to `to` (world). Returns smoothed world waypoints
    // (excluding the start, ending at the goal cell centre) or null.
    findPath(from, to) {
        const s = this._nearestFreeCell(from.x, from.z);
        const g = this._nearestFreeCell(to.x, to.z);
        if (!s || !g) return null;
        const nx = this.nx, N = nx * this.nz;
        const sIdx = s.iz * nx + s.ix, gIdx = g.iz * nx + g.ix;
        if (sIdx === gIdx) return [{ x: this._wx(g.ix), z: this._wz(g.iz) }];

        const gScore = new Float32Array(N).fill(Infinity);
        const came = new Int32Array(N).fill(-1);
        const open = new MinHeap();
        const h = (i) => { const ix = i % nx, iz = (i / nx) | 0; return Math.hypot(ix - g.ix, iz - g.iz); };
        gScore[sIdx] = 0;
        open.push(sIdx, h(sIdx));
        let iters = 0;
        const cap = N * 4;
        while (open.size && iters++ < cap) {
            const cur = open.pop();
            if (cur === gIdx) return this._reconstruct(came, gIdx);
            const cix = cur % nx, ciz = (cur / nx) | 0;
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dz) continue;
                    const nix = cix + dx, niz = ciz + dz;
                    if (!this._free(nix, niz)) continue;
                    if (dx && dz && (!this._free(cix + dx, ciz) || !this._free(cix, ciz + dz))) continue; // no corner cutting
                    const ni = niz * nx + nix;
                    const ng = gScore[cur] + (dx && dz ? SQRT2 : 1);
                    if (ng < gScore[ni]) {
                        gScore[ni] = ng; came[ni] = cur;
                        open.push(ni, ng + h(ni));
                    }
                }
            }
        }
        return null;
    }

    _reconstruct(came, gIdx) {
        const nx = this.nx, cells = [];
        for (let i = gIdx; i !== -1; i = came[i]) cells.push(i);
        cells.reverse(); // start -> goal, as world points
        const pts = cells.map(i => ({ x: this._wx(i % nx), z: this._wz((i / nx) | 0) }));
        // String-pull: keep a point only when the line from the last kept
        // waypoint to the NEXT point is blocked (i.e. this corner is needed).
        const out = [];
        let anchor = pts[0];
        for (let i = 1; i < pts.length - 1; i++) {
            if (!this.lineClear(anchor.x, anchor.z, pts[i + 1].x, pts[i + 1].z)) {
                out.push(pts[i]); anchor = pts[i];
            }
        }
        out.push(pts[pts.length - 1]); // goal
        return out;
    }

    // Debug: list of blocked cell centres (for an optional ground overlay).
    blockedCells() {
        const out = [];
        for (let iz = 0; iz < this.nz; iz++)
            for (let ix = 0; ix < this.nx; ix++)
                if (this.blocked[iz * this.nx + ix]) out.push({ x: this._wx(ix), z: this._wz(iz) });
        return out;
    }
    freeCount() { let n = 0; for (let i = 0; i < this.blocked.length; i++) if (!this.blocked[i]) n++; return n; }
}

// Tiny binary min-heap keyed by priority (for A*).
class MinHeap {
    constructor() { this.v = []; this.p = []; }
    get size() { return this.v.length; }
    push(val, pri) {
        this.v.push(val); this.p.push(pri);
        let i = this.v.length - 1;
        while (i > 0) { const par = (i - 1) >> 1; if (this.p[par] <= this.p[i]) break; this._swap(i, par); i = par; }
    }
    pop() {
        const top = this.v[0], n = this.v.length - 1;
        this.v[0] = this.v[n]; this.p[0] = this.p[n]; this.v.pop(); this.p.pop();
        let i = 0;
        while (true) {
            const l = 2 * i + 1, r = 2 * i + 2; let m = i;
            if (l < this.v.length && this.p[l] < this.p[m]) m = l;
            if (r < this.v.length && this.p[r] < this.p[m]) m = r;
            if (m === i) break; this._swap(i, m); i = m;
        }
        return top;
    }
    _swap(a, b) { [this.v[a], this.v[b]] = [this.v[b], this.v[a]]; [this.p[a], this.p[b]] = [this.p[b], this.p[a]]; }
}
