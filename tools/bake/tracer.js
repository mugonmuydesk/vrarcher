// Minimal Lambertian path tracer for lightmap baking (concept after
// smallpt / tojicode's JS port; implementation our own). Primitives are
// axis-aligned boxes and spheres — everything static in the range is one
// of those. Units: metres, Babylon world space (left-handed, +Z downrange).
//
// Lighting model mirrors scene.js: one directional sun + a hemispheric sky
// term. Rays that escape the scene return the sky radiance; rays that hit
// geometry return albedo-modulated irradiance gathered recursively.

export const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    mulv: (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]],
    norm: (a) => {
        const l = Math.hypot(a[0], a[1], a[2]);
        return [a[0] / l, a[1] / l, a[2] / l];
    },
};

const EPS = 1e-4;

// box: { min:[x,y,z], max:[x,y,z], albedo:[r,g,b] }
function hitBox(box, o, d, tMax) {
    let t0 = EPS, t1 = tMax, axis = -1, sign = 0;
    for (let i = 0; i < 3; i++) {
        const inv = 1 / d[i];
        let ta = (box.min[i] - o[i]) * inv;
        let tb = (box.max[i] - o[i]) * inv;
        let s = -1;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
        if (ta > t0) { t0 = ta; axis = i; sign = s; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) return null;
    }
    if (axis < 0) return null; // origin inside
    const n = [0, 0, 0];
    n[axis] = sign;
    return { t: t0, n };
}

// sphere: { c:[x,y,z], r, albedo }
function hitSphere(s, o, d, tMax) {
    const oc = V.sub(o, s.c);
    const b = V.dot(oc, d);
    const c = V.dot(oc, oc) - s.r * s.r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let t = -b - sq;
    if (t < EPS) t = -b + sq;
    if (t < EPS || t > tMax) return null;
    const p = V.add(o, V.mul(d, t));
    return { t, n: V.norm(V.sub(p, s.c)) };
}

export class Tracer {
    /**
     * scene: {
     *   boxes: [...], spheres: [...],
     *   sunDir: [x,y,z] (direction light TRAVELS, normalized),
     *   sunColor: [r,g,b] (irradiance on a sun-facing surface),
     *   skyColor: [r,g,b] (hemispheric radiance for escaped rays),
     *   sunAngle: radians of cone jitter for soft shadows
     * }
     */
    constructor(scene) {
        this.s = scene;
    }

    intersect(o, d, tMax = Infinity) {
        let best = null;
        for (const b of this.s.boxes) {
            const h = hitBox(b, o, d, best ? best.t : tMax);
            if (h) best = { ...h, albedo: b.albedo, box: b };
        }
        for (const sp of this.s.spheres) {
            const h = hitSphere(sp, o, d, best ? best.t : tMax);
            if (h) best = { ...h, albedo: sp.albedo, box: null };
        }
        // Spatially-varying albedo (checkerboard ground): pick the tile
        // colour at the actual hit point so bounce light carries the
        // pattern.
        if (best?.box?.checker) {
            const c = best.box.checker;
            const p = V.add(o, V.mul(d, best.t));
            const tile = (Math.floor(p[0] / c.size) + Math.floor(p[2] / c.size)) & 1;
            if (tile) best.albedo = c.albedo2;
        }
        return best;
    }

    occluded(o, d, tMax) {
        for (const b of this.s.boxes) if (hitBox(b, o, d, tMax)) return true;
        for (const sp of this.s.spheres) if (hitSphere(sp, o, d, tMax)) return true;
        return false;
    }

    // Random direction in a cone around `dir` (soft sun).
    _jitter(dir, angle) {
        if (angle <= 0) return dir;
        const [t, b] = this._basis(dir);
        const r = Math.sqrt(Math.random()) * Math.tan(angle);
        const phi = Math.random() * Math.PI * 2;
        return V.norm(V.add(dir,
            V.add(V.mul(t, r * Math.cos(phi)), V.mul(b, r * Math.sin(phi)))));
    }

    _basis(n) {
        const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const t = V.norm(V.cross(a, n));
        return [t, V.cross(n, t)];
    }

    _cosineDir(n) {
        const [t, b] = this._basis(n);
        const u = Math.random(), v = Math.random();
        const r = Math.sqrt(u), phi = 2 * Math.PI * v;
        const x = r * Math.cos(phi), y = r * Math.sin(phi), z = Math.sqrt(1 - u);
        return V.norm(V.add(V.mul(n, z), V.add(V.mul(t, x), V.mul(b, y))));
    }

    // Direct sun irradiance at p with normal n (one shadow ray, jittered).
    sunAt(p, n) {
        const toSun = this._jitter(V.mul(this.s.sunDir, -1), this.s.sunAngle);
        const ndl = V.dot(n, toSun);
        if (ndl <= 0) return [0, 0, 0];
        if (this.occluded(V.add(p, V.mul(n, EPS * 4)), toSun, 100)) return [0, 0, 0];
        return V.mul(this.s.sunColor, ndl);
    }

    // Irradiance arriving at p/n: sun + one hemisphere sample carrying sky
    // or bounced light (call many times per texel and average).
    sample(p, n, depth = 2) {
        let e = this.sunAt(p, n);
        const d = this._cosineDir(n);
        const o = V.add(p, V.mul(n, EPS * 4));
        const hit = this.intersect(o, d, 60);
        if (!hit) {
            // Escaped: sky radiance (cosine-weighted sampling makes the
            // unoccluded sum equal skyColor exactly).
            e = V.add(e, this.s.skyColor);
        } else if (depth > 1) {
            const q = V.add(o, V.mul(d, hit.t));
            const sub = this.sample(q, hit.n, depth - 1);
            // indirectBoost: artistic amplifier on BOUNCED light only (sun
            // and sky stay physical) so color casts read clearly.
            e = V.add(e, V.mul(V.mulv(hit.albedo, sub), this.s.indirectBoost ?? 1));
        }
        return e;
    }

    // Reference irradiance with NO occlusion/bounce — what the runtime
    // lights deliver to an unshadowed surface. Ratio sample/reference is
    // the value baked into the multiplicative lightmap.
    reference(n) {
        const ndl = Math.max(0, V.dot(n, V.mul(this.s.sunDir, -1)));
        return V.add(V.mul(this.s.sunColor, ndl), this.s.skyColor);
    }

    // Bounce-only sample: indirect irradiance at surface point p with
    // normal n, from STATIC geometry only (cosine-weighted hemisphere —
    // one ray; average many). Rays that escape contribute nothing, and
    // there is NO direct term — movables bake this per texel as an
    // additive map while their direct sun/sky stays live and unshadowed.
    bounceSample(p, n) {
        const d = this._cosineDir(n);
        const hit = this.intersect(V.add(p, V.mul(d, 1e-3)), d, 60);
        if (!hit) return [0, 0, 0];
        const boost = this.s.indirectBoost ?? 1;
        const q = V.add(p, V.mul(d, hit.t));
        const through = V.mul(hit.albedo, boost);
        let e = V.mulv(through, this.sunAt(q, hit.n));
        // One more bounce (or sky reflected off the static surface).
        const d2 = this._cosineDir(hit.n);
        const o2 = V.add(q, V.mul(hit.n, 1e-3));
        const hit2 = this.intersect(o2, d2, 60);
        if (!hit2) {
            e = V.add(e, V.mulv(through, this.s.skyColor));
        } else {
            const q2 = V.add(o2, V.mul(d2, hit2.t));
            const through2 = V.mulv(through, V.mul(hit2.albedo, boost));
            e = V.add(e, V.mulv(through2, this.sunAt(q2, hit2.n)));
        }
        return e;
    }
}
