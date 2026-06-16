// Lightmap baker for the VRarcher static set.
//
// Mirrors the STATIC scene analytically (keep in sync with scene.js /
// main.js / door.js — positions, sizes, colors, lights), then for every
// texel of every receiver surface gathers irradiance with the path tracer
// and bakes the ratio against the unoccluded runtime lighting into a
// multiplicative lightmap (assets/lightmaps/*.png, texture.level 1.2).
//
// Movers are deliberately absent (door PANEL, target, throwables, lamp
// arm, slider/crank handles) so nothing bakes a stale shadow. The door
// FRAME, poles, button and joystick are static and participate.
//
// Run: http://localhost:8000/tools/bake/bake.html?passes=8&spp=8
// Each pass adds `spp` samples/texel progressively. Results land in
// window.__bakeResults as PNG data URLs when done.

import { Tracer, V } from "./tracer.js";
import { GpuBaker } from "./gpu.js";

const box = (cx, cy, cz, sx, sy, sz, albedo) => ({
    min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
    max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
    albedo,
});

// --- static scene (Babylon world coords) -----------------------------------
// Bake albedos are deliberately MORE saturated than the render materials:
// they only drive the bounce COLOR, and the muted render palette produces
// invisible casts. Same trick as hand-tuned bounce cards in film lighting.
const FRAME_ALBEDO = [0.32, 0.20, 0.08];
const POLE_ALBEDO = [0.40, 0.26, 0.12];

// Checkerboard ground, 0.5 m world-aligned tiles, black & white (user
// request). Tile parity 0 = black, 1 = white — bounce light carries the
// pattern (white tiles throw bright neutral bounce, black tiles ~none).
const CHECKER = {
    size: 0.5,
    bounceBlack: [0.04, 0.04, 0.04], bounceWhite: [0.85, 0.85, 0.85],
    // renderWhite sits below 1/1.35 so a sunlit white tile keeps headroom
    // for bounce TINT (at 0.82 it clamped to flat white and casts died —
    // user report); black raised just enough to not be a void.
    renderBlack: [0.08, 0.08, 0.08], renderWhite: [0.70, 0.70, 0.70],
};

// LDR encode ceiling: PNGs store value/LEVEL, runtime restores via
// texture.level (lightmaps.js LEVEL must match). Without it, any texel
// whose lit value exceeds 1 clamps and loses its colour cast.
export const LEVEL = 1.5;

const SCENE = {
    boxes: [
        { ...box(0, -0.05, 9, 12, 0.1, 30, CHECKER.bounceBlack), // ground slab
            checker: { size: CHECKER.size, albedo2: CHECKER.bounceWhite } },
        box(0.45, 0.4, 0.55, 0.5, 0.8, 0.5, [0.62, 0.32, 0.10]), // crate
        box(0.7, 0.45, 0.05, 0.15, 0.9, 0.15, [0.30, 0.30, 0.40]), // pedestal
        box(-0.45, 0.375, 0.95, 0.3, 0.75, 0.3, [0.50, 0.34, 0.16]), // lamp table
        box(-0.85, 0.525, 0.74, 0.05, 1.05, 0.05, POLE_ALBEDO), // crank pole
        box(0, 0.475, 1.15, 0.05, 0.95, 0.05, POLE_ALBEDO),     // joystick pole
        box(0.90, 1.0, 1.3, 0.08, 2.0, 0.1, FRAME_ALBEDO),      // door post L
        box(1.70, 1.0, 1.3, 0.08, 2.0, 0.1, FRAME_ALBEDO),      // door post R
        box(1.30, 2.04, 1.3, 0.88, 0.08, 0.1, FRAME_ALBEDO),    // lintel
        box(0.7, 0.965, 0.05, 0.12, 0.13, 0.12, [0.85, 0.12, 0.08]), // start button (red)
        box(0, 0.97, 1.15, 0.16, 0.04, 0.16, [0.2, 0.2, 0.25]), // joystick base
    ],
    spheres: [
        { c: [0, 1.11, 1.15], r: 0.03, albedo: [0.85, 0.18, 0.10] }, // joystick knob
    ],
    sunDir: V.norm([0, -1, 0.3]),
    sunColor: [1.2, 1.2, 1.2],
    skyColor: [0.15, 0.15, 0.16],
    sunAngle: 0.06, // rad — soft shadow penumbra
    indirectBoost: 2.5, // artistic: bounce-only amplifier so casts read
};

// Maps are FULL-ILLUMINATION lightmaps (classic baked lighting): texel =
// renderAlbedo x irradiance, used as emissive with dynamic lighting off.
// A ratio/shadowmap encode was tried first and clamps flat on faces the
// runtime sun barely grazes (vertical sides) — bounce color died there.

// --- receivers ---------------------------------------------------------------
// Size-aware texel densities: a uniform texels-per-metre target so big
// surfaces aren't starved and small ones aren't wasteful.
const GROUND_TPM = 80;     // 1.25 cm ground texels (halved again —
const BOX_TPM = 96;        // denoise carries the smoothness)
const SLOT_MIN = 32, SLOT_MAX = 256; // px clamp per atlas slot

// Box-face UV convention (BAKER and the runtime UV rewrite in
// src/lightmaps.js MUST agree):
//   ±x faces: u along +z, v along +y
//   ±y faces: u along +x, v along +z
//   ±z faces: u along +x, v along +y
// Atlas: 6 face slots in a 3x2 grid, face order [+x,-x,+y,-y,+z,-z].
// Slot size scales with the box's largest face extents (clamped), so the
// runtime UV rewrite (plain thirds/halves) needs no changes.
function boxReceiver(name, b, renderAlbedo) {
    const size = V.sub(b.max, b.min);
    const clampPx = (m) => Math.max(SLOT_MIN, Math.min(SLOT_MAX, Math.round(m * BOX_TPM)));
    // u extents per face: ±x→z, ±y→x, ±z→x; v extents: ±x→y, ±y→z, ±z→y.
    const slotW = clampPx(Math.max(size[2], size[0]));
    const slotH = clampPx(Math.max(size[1], size[2]));
    const W = slotW * 3, H = slotH * 2;
    return {
        name, width: W, height: H, albedo: renderAlbedo,
        slot: [slotW, slotH], // denoiser must not blur across face slots
        gpu: { mode: 1, bmin: b.min, bmax: b.max },
        texel(i, j) {
            const col = Math.floor(i / slotW), row = Math.floor(j / slotH);
            const face = row * 3 + col;
            const fu = (i % slotW + 0.5) / slotW, fv = (j % slotH + 0.5) / slotH;
            const axis = face >> 1;            // 0:x 1:y 2:z
            const sign = (face & 1) ? -1 : 1;  // even:+ odd:-
            const ua = axis === 0 ? 2 : 0;     // u axis index
            const va = axis === 1 ? 2 : 1;     // v axis index
            const p = [0, 0, 0];
            p[axis] = sign > 0 ? b.max[axis] : b.min[axis];
            p[ua] = b.min[ua] + fu * size[ua];
            p[va] = b.min[va] + fv * size[va];
            const n = [0, 0, 0];
            n[axis] = sign;
            return { p, n };
        },
    };
}

const RECEIVERS = [
    {
        // Ground top face: u along +x (-6..6), v along -z (Babylon's
        // CreateGround puts v=0 at the +z edge — verified in-engine, the
        // first bake's shadows landed mirrored about z=9).
        name: "ground", width: 12 * GROUND_TPM, height: 30 * GROUND_TPM,
        albedo: [1, 1, 1],
        // Per-texel RENDER albedo: the checkerboard itself (the baked map
        // IS the floor's full look, so the pattern lives here).
        albedoAt(i, j) {
            const x = -6 + (i + 0.5) / (12 * GROUND_TPM) * 12;
            const z = 24 - (j + 0.5) / (30 * GROUND_TPM) * 30;
            const tile = (Math.floor(x / CHECKER.size) + Math.floor(z / CHECKER.size)) & 1;
            return tile ? CHECKER.renderWhite : CHECKER.renderBlack;
        },
        gpu: {
            mode: 0,
            origin: [-6, 0, 24], uAxis: [12, 0, 0], vAxis: [0, 0, -30],
            normal: [0, 1, 0],
        },
        texel(i, j) {
            return {
                p: [-6 + (i + 0.5) / (12 * GROUND_TPM) * 12, 0,
                    24 - (j + 0.5) / (30 * GROUND_TPM) * 30],
                n: [0, 1, 0],
            };
        },
    },
    // Render albedos = the materials' diffuseColor in main.js.
    boxReceiver("crate", SCENE.boxes[1], [0.5, 0.35, 0.2]),
    boxReceiver("pedestal", SCENE.boxes[2], [0.3, 0.3, 0.33]),
    boxReceiver("lampTable", SCENE.boxes[3], [0.35, 0.3, 0.25]),
];

// MOVABLE objects: same per-texel resolution as the statics, but
// BOUNCE-ONLY (indirect-from-statics; no direct term, no occlusion
// darkening) and baked at the object's REST pose — high path resolution
// on the surface, static paths (user-specified). Applied additively over
// each movable's live, unshadowed dynamic lighting. Stale once the object
// moves: accepted trade.
function sphereReceiver(name, center, radius, renderAlbedo) {
    // Lat-long sized to the box-face density (equator circumference).
    const W = Math.max(64, Math.round(2 * Math.PI * radius * BOX_TPM / 2) * 2);
    const H = Math.max(32, Math.round(W / 2));
    return {
        name, width: W, height: H, albedo: renderAlbedo, bounceOnly: true,
        gpu: { mode: 3, center, radius },
        texel(i, j) {
            // Lat-long matching the GPU mode-3 mapping.
            const phi = (i + 0.5) / W * 2 * Math.PI;
            const th = (1 - (j + 0.5) / H) * Math.PI;
            const n = [Math.sin(th) * Math.cos(phi), Math.cos(th),
                Math.sin(th) * Math.sin(phi)];
            return { p: V.add(center, V.mul(n, radius)), n };
        },
    };
}

RECEIVERS.push(
    { ...boxReceiver("grabCube", box(-0.35, 1.1, 0.45, 0.12, 0.12, 0.12),
        [0.9, 0.6, 0.2]), bounceOnly: true },
    { ...boxReceiver("heavyBox", box(1.0, 0.18, 0.5, 0.35, 0.35, 0.35),
        [0.25, 0.25, 0.3]), bounceOnly: true },
    { ...boxReceiver("beam", box(-0.9, 0.07, 0.7, 1.0, 0.12, 0.12),
        [0.6, 0.5, 0.25]), bounceOnly: true },
    { ...boxReceiver("doorPanel", box(1.30, 0.95, 1.3, 0.7, 1.9, 0.05),
        [0.5, 0.36, 0.22]), bounceOnly: true },
    sphereReceiver("ball", [0.45, 0.86, 0.55], 0.05, [0.2, 0.5, 0.9]),
);

// --- bake loop -----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const PASSES = Number(params.get("passes") ?? 8);
const SPP = Number(params.get("spp") ?? 8);

const tracer = new Tracer(SCENE);
const state = { pass: 0, passes: PASSES, receiver: "", done: false };
window.__bakeState = state;
window.__bakeResults = {};

function setupCanvas(r) {
    const c = document.createElement("canvas");
    c.width = r.width; c.height = r.height;
    c.style.cssText = "image-rendering:pixelated;border:1px solid #444;margin:4px;max-width:24%";
    const label = document.createElement("div");
    label.textContent = r.name;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:inline-block;color:#ccc;font:12px monospace;text-align:center";
    wrap.appendChild(c); wrap.appendChild(label);
    document.body.appendChild(wrap);
    r.canvas = c;
    r.gctx = c.getContext("2d");
    r.accum = new Float32Array(r.width * r.height * 3);
    r.samples = 0;
}

// Encode = final surface color: renderAlbedo x traced irradiance, clamped
// to LDR. This IS the rendering equation's diffuse term — the texture is
// the path-traced result, applied at runtime as emissive (lighting off).
function drawPreview(r) {
    const img = r.gctx.createImageData(r.width, r.height);
    for (let t = 0, px = 0; t < r.accum.length; t += 3, px += 4) {
        const texel = t / 3;
        const alb = r.albedoAt
            ? r.albedoAt(texel % r.width, Math.floor(texel / r.width)) : r.albedo;
        for (let ch = 0; ch < 3; ch++) {
            const v = Math.min(1, r.accum[t + ch] / r.samples * alb[ch] / LEVEL);
            img.data[px + ch] = Math.round(v * 255);
        }
        img.data[px + 3] = 255;
    }
    r.gctx.putImageData(img, 0, 0);
}

function cpuPass(r) {
    let t = 0;
    for (let j = 0; j < r.height; j++) {
        for (let i = 0; i < r.width; i++, t += 3) {
            const { p, n } = r.texel(i, j);
            let e = [0, 0, 0];
            for (let s = 0; s < SPP; s++) {
                e = V.add(e, r.bounceOnly ? tracer.bounceSample(p, n) : tracer.sample(p, n, 2));
            }
            for (let ch = 0; ch < 3; ch++) {
                r.accum[t + ch] += e[ch] / SPP; // raw irradiance
            }
        }
    }
    r.samples += 1; // accum holds per-pass averaged ratios
}

function gpuPass(gpu, r, pass) {
    const data = gpu.pass(r, pass, SPP); // Float32 RGBA ratio map
    for (let t = 0, px = 0; t < r.accum.length; t += 3, px += 4) {
        r.accum[t] += data[px];
        r.accum[t + 1] += data[px + 1];
        r.accum[t + 2] += data[px + 2];
    }
    r.samples += 1;
}

async function main() {
    document.body.style.background = "#222";
    const status = document.createElement("div");
    status.style.cssText = "color:#8f8;font:14px monospace;margin:6px";
    document.body.prepend(status);
    for (const r of RECEIVERS) setupCanvas(r);

    let gpu = null;
    if (params.get("cpu") !== "1") {
        try { gpu = new GpuBaker(SCENE); } catch (e) {
            console.warn("[bake] GPU unavailable, CPU fallback:", e.message);
        }
    }
    const t0 = performance.now();
    for (let pass = 1; pass <= PASSES; pass++) {
        state.pass = pass;
        for (const r of RECEIVERS) {
            state.receiver = r.name;
            status.textContent = `pass ${pass}/${PASSES} — ${r.name} (${SPP} spp/pass, ${gpu ? "GPU" : "CPU"})`;
            await new Promise(res => setTimeout(res, 0)); // let the page paint
            if (gpu) gpuPass(gpu, r, pass); else cpuPass(r);
            drawPreview(r);
        }
    }
    // Post-process denoise (?denoise=0 to skip, ?sigma= to tune): GPU
    // à-trous bilateral on the raw irradiance. The albedo (checkerboard
    // included) multiplies in at encode AFTER this, so patterns stay
    // crisp — only the traced light is smoothed.
    if (gpu && params.get("denoise") !== "0") {
        const sigma = Number(params.get("sigma") ?? 0.12);
        for (const r of RECEIVERS) {
            status.textContent = `denoising ${r.name}…`;
            await new Promise(res => setTimeout(res, 0));
            const rgba = new Float32Array(r.width * r.height * 4);
            for (let t = 0, p = 0; t < r.accum.length; t += 3, p += 4) {
                rgba[p] = r.accum[t] / r.samples;
                rgba[p + 1] = r.accum[t + 1] / r.samples;
                rgba[p + 2] = r.accum[t + 2] / r.samples;
                rgba[p + 3] = 1;
            }
            const out = gpu.denoise(r.width, r.height, rgba,
                r.slot ?? [r.width, r.height], [1, 2, 4], sigma);
            for (let t = 0, p = 0; t < r.accum.length; t += 3, p += 4) {
                r.accum[t] = out[p];
                r.accum[t + 1] = out[p + 1];
                r.accum[t + 2] = out[p + 2];
            }
            r.samples = 1;
            drawPreview(r);
        }
    }
    console.log(`[bake] traced in ${((performance.now() - t0) / 1000).toFixed(1)} s (${gpu ? "GPU" : "CPU"})`);
    if (params.get("post") === "1") {
        fetch("http://localhost:8002/log/diag", {
            method: "POST",
            body: `traced ${((performance.now() - t0) / 1000).toFixed(1)}s `
                + `${gpu ? "GPU" : "CPU"}; ${window.__gpuDiag ?? "no gpu diag"}`,
        }).catch(() => {});
    }
    for (const r of RECEIVERS) {
        window.__bakeResults[r.name] = r.canvas.toDataURL("image/png");
    }
    // &post=1: upload PNGs to the local receiver (tools/bake/receiver.py on
    // :8002), which writes them into assets/lightmaps/.
    if (params.get("post") === "1") {
        for (const r of RECEIVERS) {
            const blob = await new Promise(res => r.canvas.toBlob(res, "image/png"));
            const resp = await fetch(`http://localhost:8002/save/${r.name}`,
                { method: "POST", body: blob });
            console.log(`[bake] posted ${r.name}: ${resp.status}`);
        }
    }
    state.done = true;
    status.textContent = `DONE — ${PASSES * SPP} spp; results in window.__bakeResults`;
    console.log("[bake] done");
}

main();
