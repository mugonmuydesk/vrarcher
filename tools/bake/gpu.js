// GPU lightmap baker: the tracer.js algorithm ported to a WebGL2 fragment
// shader. One fullscreen draw per pass renders `spp` samples per texel for
// a whole receiver into an RGBA32F target; readPixels returns the ratio
// map, accumulated in JS exactly like the CPU path. Needs
// EXT_color_buffer_float (universal on desktop).

const VS = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = (nbox) => `#version 300 es
precision highp float;
precision highp int;
const int NBOX = ${nbox};
const float EPS = 1e-4;
uniform vec3 uBoxMin[NBOX];
uniform vec3 uBoxMax[NBOX];
uniform vec3 uBoxAlb[NBOX];
uniform vec3 uSphC; uniform float uSphR; uniform vec3 uSphAlb;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyCol;
uniform float uSunAngle; uniform float uBoost;
uniform int uSpp; uniform int uPass;
// Receiver: mode 0 = plane (origin/uAxis/vAxis/normal), mode 1 = box atlas,
// mode 3 = sphere (lat-long). uBounceOnly = bake indirect-from-statics
// only (movables' additive maps).
uniform int uMode;
uniform int uBounceOnly;
uniform vec3 uOrigin; uniform vec3 uUAxis; uniform vec3 uVAxis; uniform vec3 uNormal;
uniform vec3 uBMin; uniform vec3 uBMax;
uniform vec3 uRSphC; uniform float uRSphR;
// Checkerboard ground: box uCheckerBox alternates albedo/uCheckerAlb2 in
// world-aligned uCheckerSize tiles (bounce light carries the pattern).
uniform int uCheckerBox; uniform vec3 uCheckerAlb2; uniform float uCheckerSize;
in vec2 vUV;
out vec4 frag;

uint gstate;
void seed(uint a, uint b, uint c) { gstate = a * 1664525u ^ b * 22695477u ^ c * 747796405u; }
float rnd() {
    gstate = gstate * 747796405u + 2891336453u;
    uint w = ((gstate >> ((gstate >> 28) + 4u)) ^ gstate) * 277803737u;
    return float((w >> 22) ^ w) / 1048576.0 * (1.0 / 4096.0);
}

bool hitBox(vec3 mn, vec3 mx, vec3 o, vec3 d, float tMax, out float t, out vec3 n) {
    float t0 = EPS, t1 = tMax; int ax = -1; float sg = 0.0;
    for (int i = 0; i < 3; i++) {
        float inv = 1.0 / d[i];
        float ta = (mn[i] - o[i]) * inv, tb = (mx[i] - o[i]) * inv;
        float s = -1.0;
        if (ta > tb) { float tmp = ta; ta = tb; tb = tmp; s = 1.0; }
        if (ta > t0) { t0 = ta; ax = i; sg = s; }
        t1 = min(t1, tb);
        if (t0 > t1) return false;
    }
    if (ax < 0) return false;
    n = vec3(0.0); n[ax] = sg; t = t0;
    return true;
}

bool hitSphere(vec3 o, vec3 d, float tMax, out float t, out vec3 n) {
    vec3 oc = o - uSphC;
    float b = dot(oc, d), c = dot(oc, oc) - uSphR * uSphR;
    float disc = b * b - c;
    if (disc < 0.0) return false;
    float sq = sqrt(disc);
    t = -b - sq;
    if (t < EPS) t = -b + sq;
    if (t < EPS || t > tMax) return false;
    n = normalize(o + d * t - uSphC);
    return true;
}

bool intersect(vec3 o, vec3 d, out float t, out vec3 n, out vec3 alb) {
    t = 60.0; bool hit = false; float ht; vec3 hn; int bi = -1;
    for (int i = 0; i < NBOX; i++) {
        if (hitBox(uBoxMin[i], uBoxMax[i], o, d, t, ht, hn)) {
            t = ht; n = hn; alb = uBoxAlb[i]; hit = true; bi = i;
        }
    }
    if (hitSphere(o, d, t, ht, hn)) { t = ht; n = hn; alb = uSphAlb; hit = true; bi = -1; }
    if (hit && bi == uCheckerBox) {
        vec3 hp = o + d * t;
        float tile = mod(floor(hp.x / uCheckerSize) + floor(hp.z / uCheckerSize), 2.0);
        if (tile >= 1.0) alb = uCheckerAlb2;
    }
    return hit;
}

bool occluded(vec3 o, vec3 d) {
    float t; vec3 n;
    for (int i = 0; i < NBOX; i++) {
        if (hitBox(uBoxMin[i], uBoxMax[i], o, d, 100.0, t, n)) return true;
    }
    return hitSphere(o, d, 100.0, t, n);
}

void basis(vec3 n, out vec3 t, out vec3 b) {
    vec3 a = abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    t = normalize(cross(a, n));
    b = cross(n, t);
}

vec3 cosineDir(vec3 n) {
    vec3 t, b; basis(n, t, b);
    float u = rnd(), v = rnd();
    float r = sqrt(u), phi = 6.2831853 * v;
    return normalize(n * sqrt(1.0 - u) + t * (r * cos(phi)) + b * (r * sin(phi)));
}

vec3 sunAt(vec3 p, vec3 n) {
    vec3 toSun = -uSunDir;
    vec3 t, b; basis(toSun, t, b);
    float r = sqrt(rnd()) * tan(uSunAngle), phi = 6.2831853 * rnd();
    toSun = normalize(toSun + t * (r * cos(phi)) + b * (r * sin(phi)));
    float ndl = dot(n, toSun);
    if (ndl <= 0.0) return vec3(0.0);
    if (occluded(p + n * EPS * 4.0, toSun)) return vec3(0.0);
    return uSunCol * ndl;
}

// Bounce-only irradiance at surface point p / normal n, from STATIC
// surfaces only — no direct term, escaped rays contribute nothing
// (runtime lights own direct/sky on movables).
vec3 bounceE(vec3 p, vec3 n) {
    vec3 d = cosineDir(n);
    float t; vec3 hn, alb;
    if (!intersect(p + d * EPS * 4.0, d, t, hn, alb)) return vec3(0.0);
    vec3 q = p + d * (EPS * 4.0) + d * t;
    vec3 through = uBoost * alb;
    vec3 e = through * sunAt(q, hn);
    vec3 d2 = cosineDir(hn);
    vec3 o2 = q + hn * EPS * 4.0;
    float t2; vec3 hn2, alb2;
    if (!intersect(o2, d2, t2, hn2, alb2)) {
        e += through * uSkyCol;
    } else {
        vec3 q2 = o2 + d2 * t2;
        e += through * uBoost * alb2 * sunAt(q2, hn2);
    }
    return e;
}

vec3 sampleE(vec3 p, vec3 n) {
    vec3 e = sunAt(p, n);
    vec3 through = vec3(1.0);
    vec3 o = p, nn = n;
    for (int bnc = 0; bnc < 2; bnc++) {
        vec3 d = cosineDir(nn);
        float t; vec3 hn, alb;
        if (!intersect(o + nn * EPS * 4.0, d, t, hn, alb)) {
            e += through * uSkyCol;
            break;
        }
        o = o + nn * EPS * 4.0 + d * t;
        nn = hn;
        through *= uBoost * alb;
        e += through * sunAt(o, nn);
    }
    return e;
}

void main() {
    // Texel -> world (mirrors bake.js texel() functions).
    vec3 p, n;
    if (uMode == 0) {
        p = uOrigin + vUV.x * uUAxis + vUV.y * uVAxis;
        n = uNormal;
    } else if (uMode == 3) {
        // Sphere lat-long: u = longitude around +Y, v = 0 at the SOUTH
        // pole (flip empirically if the bake lands upside down).
        float phi = vUV.x * 6.2831853;
        float th = (1.0 - vUV.y) * 3.14159265; // th 0 at +y pole
        n = vec3(sin(th) * cos(phi), cos(th), sin(th) * sin(phi));
        p = uRSphC + n * uRSphR;
    } else {
        int col = min(2, int(vUV.x * 3.0)), row = min(1, int(vUV.y * 2.0));
        float fu = fract(vUV.x * 3.0), fv = fract(vUV.y * 2.0);
        int face = row * 3 + col;
        int axis = face >> 1;
        float sg = (face & 1) == 1 ? -1.0 : 1.0;
        int ua = axis == 0 ? 2 : 0;
        int va = axis == 1 ? 2 : 1;
        vec3 size = uBMax - uBMin;
        p = vec3(0.0);
        p[axis] = sg > 0.0 ? uBMax[axis] : uBMin[axis];
        p[ua] = uBMin[ua] + fu * size[ua];
        p[va] = uBMin[va] + fv * size[va];
        n = vec3(0.0); n[axis] = sg;
    }

    seed(uint(gl_FragCoord.x), uint(gl_FragCoord.y), uint(uPass) * 9781u + 17u);

    vec3 e = vec3(0.0);
    if (uBounceOnly == 1) {
        for (int s = 0; s < uSpp; s++) e += bounceE(p, n);
    } else {
        for (int s = 0; s < uSpp; s++) e += sampleE(p, n);
    }
    // Raw irradiance out — render albedo is multiplied in at encode time
    // (standard full-illumination lightmap, not a shadow-ratio map).
    frag = vec4(e / float(uSpp), 1.0);
}`;

// Edge-aware à-trous bilateral filter (one iteration; run with growing
// step sizes). Range term keeps shadow edges; the 5x5 B3 kernel smooths
// Monte-Carlo noise. uSlot stops taps crossing atlas face-slot borders.
const DN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uStep;
uniform vec2 uSlot;
uniform float uSigma;
out vec4 frag;
const float K[5] = float[5](0.0625, 0.25, 0.375, 0.25, 0.0625);
void main() {
    ivec2 size = textureSize(uSrc, 0);
    ivec2 pc = ivec2(gl_FragCoord.xy);
    vec3 center = texelFetch(uSrc, pc, 0).rgb;
    ivec2 slot0 = ivec2(vec2(pc) / uSlot);
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            ivec2 q = pc + ivec2(dx, dy) * uStep;
            if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
            if (any(notEqual(ivec2(vec2(q) / uSlot), slot0))) continue;
            vec3 c = texelFetch(uSrc, q, 0).rgb;
            vec3 d = c - center;
            float w = K[dx + 2] * K[dy + 2]
                * exp(-dot(d, d) / (2.0 * uSigma * uSigma));
            sum += c * w;
            wsum += w;
        }
    }
    frag = vec4(sum / max(wsum, 1e-6), 1.0);
}`;

export class GpuBaker {
    constructor(scene) {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        if (!gl) throw new Error("WebGL2 unavailable");
        if (!gl.getExtension("EXT_color_buffer_float")) {
            throw new Error("EXT_color_buffer_float unavailable");
        }
        this.gl = gl;
        this.scene = scene;

        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                throw new Error("shader: " + gl.getShaderInfoLog(sh));
            }
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS(scene.boxes.length)));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error("link: " + gl.getProgramInfoLog(prog));
        }
        this.prog = prog;
        gl.useProgram(prog);
        this.u = (name) => gl.getUniformLocation(prog, name);

        // Static scene uniforms.
        const flat = (key) => new Float32Array(scene.boxes.flatMap(b => b[key]));
        gl.uniform3fv(this.u("uBoxMin"), flat("min"));
        gl.uniform3fv(this.u("uBoxMax"), flat("max"));
        gl.uniform3fv(this.u("uBoxAlb"), flat("albedo"));
        const sp = scene.spheres[0];
        gl.uniform3fv(this.u("uSphC"), new Float32Array(sp.c));
        gl.uniform1f(this.u("uSphR"), sp.r);
        gl.uniform3fv(this.u("uSphAlb"), new Float32Array(sp.albedo));
        gl.uniform3fv(this.u("uSunDir"), new Float32Array(scene.sunDir));
        gl.uniform3fv(this.u("uSunCol"), new Float32Array(scene.sunColor));
        gl.uniform3fv(this.u("uSkyCol"), new Float32Array(scene.skyColor));
        gl.uniform1f(this.u("uSunAngle"), scene.sunAngle);
        gl.uniform1f(this.u("uBoost"), scene.indirectBoost ?? 1);
        const ci = scene.boxes.findIndex(b => b.checker);
        gl.uniform1i(this.u("uCheckerBox"), ci);
        if (ci >= 0) {
            gl.uniform3fv(this.u("uCheckerAlb2"), new Float32Array(scene.boxes[ci].checker.albedo2));
            gl.uniform1f(this.u("uCheckerSize"), scene.boxes[ci].checker.size);
        }

        this._fb = gl.createFramebuffer();
        this._tex = null;
        this._size = [0, 0];
    }

    _target(w, h) {
        const gl = this.gl;
        if (this._size[0] === w && this._size[1] === h) return;
        if (this._tex) gl.deleteTexture(this._tex);
        this._tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, this._tex, 0);
        this._size = [w, h];
    }

    // À-trous bilateral denoise of a mean-irradiance RGBA float buffer.
    // Returns a new Float32Array; slot = atlas face-slot size in px.
    denoise(width, height, rgba, slot, steps = [1, 2, 4], sigma = 0.12) {
        const gl = this.gl;
        if (!this._dnProg) {
            const compile = (type, src) => {
                const sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                    throw new Error("denoise shader: " + gl.getShaderInfoLog(sh));
                }
                return sh;
            };
            const prog = gl.createProgram();
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, DN_FS));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                throw new Error("denoise link: " + gl.getProgramInfoLog(prog));
            }
            this._dnProg = prog;
        }
        const mkTex = (data) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0,
                gl.RGBA, gl.FLOAT, data);
            return t;
        };
        const texA = mkTex(rgba), texB = mkTex(null);
        const fb = gl.createFramebuffer();
        gl.useProgram(this._dnProg);
        const u = (n) => gl.getUniformLocation(this._dnProg, n);
        gl.uniform1i(u("uSrc"), 0);
        gl.uniform2f(u("uSlot"), slot[0], slot[1]);
        gl.uniform1f(u("uSigma"), sigma);
        gl.activeTexture(gl.TEXTURE0);
        gl.viewport(0, 0, width, height);
        let src = texA, dst = texB;
        for (const step of steps) {
            gl.uniform1i(u("uStep"), step);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, dst, 0);
            gl.bindTexture(gl.TEXTURE_2D, src);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            [src, dst] = [dst, src];
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, src, 0);
        const out = new Float32Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
        gl.deleteTexture(texA); gl.deleteTexture(texB); gl.deleteFramebuffer(fb);
        gl.useProgram(this.prog);
        return out;
    }

    // One pass: `spp` samples for every texel of the receiver. Returns
    // Float32Array RGBA, rows matching the CPU canvas convention.
    pass(r, passIndex, spp) {
        const gl = this.gl;
        this._target(r.width, r.height);
        gl.useProgram(this.prog);
        gl.uniform1i(this.u("uSpp"), spp);
        gl.uniform1i(this.u("uPass"), passIndex);
        const g = r.gpu;
        gl.uniform1i(this.u("uMode"), g.mode);
        if (g.mode === 0) {
            gl.uniform3fv(this.u("uOrigin"), new Float32Array(g.origin));
            gl.uniform3fv(this.u("uUAxis"), new Float32Array(g.uAxis));
            gl.uniform3fv(this.u("uVAxis"), new Float32Array(g.vAxis));
            gl.uniform3fv(this.u("uNormal"), new Float32Array(g.normal));
        } else if (g.mode === 1) {
            gl.uniform3fv(this.u("uBMin"), new Float32Array(g.bmin));
            gl.uniform3fv(this.u("uBMax"), new Float32Array(g.bmax));
        } else {
            gl.uniform3fv(this.u("uRSphC"), new Float32Array(g.center));
            gl.uniform1f(this.u("uRSphR"), g.radius);
        }
        gl.uniform1i(this.u("uBounceOnly"), r.bounceOnly ? 1 : 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
        gl.viewport(0, 0, r.width, r.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const out = new Float32Array(r.width * r.height * 4);
        gl.readPixels(0, 0, r.width, r.height, gl.RGBA, gl.FLOAT, out);
        if (passIndex === 1) {
            const fbs = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            let mean = 0;
            for (let i = 0; i < 4000; i += 4) mean += out[i];
            const dbg = gl.getExtension("WEBGL_debug_renderer_info");
            const renderer = dbg
                ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                : gl.getParameter(gl.RENDERER);
            window.__gpuDiag = `${r.name} fb=${fbs === gl.FRAMEBUFFER_COMPLETE ? "ok" : fbs} `
                + `glErr=${gl.getError()} meanR(1k px)=${(mean / 1000).toFixed(4)} renderer=${renderer}`;
            console.log("[bake:gpu]", window.__gpuDiag);
        }
        return out;
    }
}
