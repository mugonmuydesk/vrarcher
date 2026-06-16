// Baked-lighting loader (assets/lightmaps/*.png from tools/bake/).
//
// The PNGs are classic FULL-ILLUMINATION lightmaps: each texel is the
// path-traced surface color (render albedo x traced irradiance — sun with
// soft shadows, sky, and bounced color casts). Static receivers therefore
// take their entire look from the bake: the texture is applied as
// emissive with dynamic lighting disabled. (A multiplicative shadowmap
// encode was tried first and clamps flat on faces the runtime sun barely
// grazes — bounce casts on vertical sides died.) Missing files are
// skipped silently, so the scene works with or without a bake.
//
// Box meshes get their lightmap UVs rewritten into a 3x2 face atlas in
// "uv2". The convention MUST match tools/bake/bake.js boxReceiver():
//   face order [+x,-x,+y,-y,+z,-z] -> atlas col = face%3, row = face/3|0
//   ±x faces: u along +z, v along +y
//   ±y faces: u along +x, v along +z
//   ±z faces: u along +x, v along +y

function atlasBoxUVs(mesh) {
    const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const nor = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);
    const bb = mesh.getBoundingInfo().boundingBox;
    const min = bb.minimum, max = bb.maximum;
    const mins = [min.x, min.y, min.z], sizes = [
        max.x - min.x, max.y - min.y, max.z - min.z];
    const uv2 = new Float32Array(pos.length / 3 * 2);
    for (let v = 0; v < pos.length / 3; v++) {
        const n = [nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]];
        const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
        let axis = 0;
        if (Math.abs(n[1]) > Math.abs(n[axis])) axis = 1;
        if (Math.abs(n[2]) > Math.abs(n[axis])) axis = 2;
        const face = axis * 2 + (n[axis] >= 0 ? 0 : 1);
        const ua = axis === 0 ? 2 : 0;
        const va = axis === 1 ? 2 : 1;
        const fu = (p[ua] - mins[ua]) / sizes[ua];
        const fv = (p[va] - mins[va]) / sizes[va];
        uv2[v * 2] = (face % 3 + fu) / 3;
        // Full-image v flip: Babylon's default invertY puts v=0 at the
        // image BOTTOM; the bake canvas has face row 0 at the TOP.
        uv2[v * 2 + 1] = 1 - (Math.floor(face / 3) + fv) / 2;
    }
    mesh.setVerticesData(BABYLON.VertexBuffer.UV2Kind, uv2);
}

// Encode ceiling — must match LEVEL in tools/bake/bake.js (PNGs store
// value/LEVEL; texture.level restores it so >1 lit values keep their tint).
const LEVEL = 1.5;

// mode "full": the bake is the COMPLETE lighting (statics) — emissive with
// dynamic lighting off. mode "additive": the bake is bounce-only and adds
// onto live, unshadowed dynamic lighting (movables, baked at rest pose —
// per-texel resolution, static paths).
function attach(scene, mesh, file, { atlas, mode = "full" }) {
    return new Promise((resolve) => {
        const tex = new BABYLON.Texture(`assets/lightmaps/${file}`, scene,
            atlas /* noMipmap: avoid cross-face bleed in atlases */, true,
            BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
            () => {
                if (atlas) {
                    atlasBoxUVs(mesh);
                    tex.coordinatesIndex = 1;
                }
                tex.level = LEVEL;
                const mat = mesh.material;
                mat.emissiveTexture = tex;
                if (mode === "full") mat.disableLighting = true;
                resolve(true);
            },
            () => resolve(false)); // no bake present — fine
    });
}

export async function applyLightmaps(ctx) {
    const byName = (n) => ctx.scene.getMeshByName(n);
    const jobs = [
        // Statics: full-illumination maps. (The ground is now a textured
        // disc lit by its own emissive grass — no baked lightmap; the old
        // ground.png was baked for the 12×30 rectangle and no longer fits.)
        attach(ctx.scene, byName("crate"), "crate.png", { atlas: true }),
        attach(ctx.scene, byName("pedestal"), "pedestal.png", { atlas: true }),
        attach(ctx.scene, byName("lampTable"), "lampTable.png", { atlas: true }),
        // Movables: bounce-only additive maps (rest-pose bake).
        attach(ctx.scene, byName("grabCube"), "grabCube.png", { atlas: true, mode: "additive" }),
        attach(ctx.scene, byName("heavyBox"), "heavyBox.png", { atlas: true, mode: "additive" }),
        attach(ctx.scene, byName("beam"), "beam.png", { atlas: true, mode: "additive" }),
        attach(ctx.scene, byName("door-panel"), "doorPanel.png", { atlas: true, mode: "additive" }),
        attach(ctx.scene, byName("ball"), "ball.png", { atlas: false, mode: "additive" }),
    ];
    const loaded = (await Promise.all(jobs)).filter(Boolean).length;
    console.log(`[lightmaps] applied ${loaded}/${jobs.length}`);
}
