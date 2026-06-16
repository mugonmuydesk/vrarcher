// Scene, lighting, ground and the WebXR experience.
//
// Coordinate conventions (the single most confusing thing in this stack):
// Babylon's world is LEFT-handed (+Z into the screen); WebXR/glTF are
// right-handed (-Z forward). Babylon negates Z when ingesting XR poses and
// offsets by the pre-XR camera position. We park the pre-XR camera at the
// origin so the mapping stays clean: babylon = (xr.x, xr.y, -xr.z).
// The emulator's default headset (identity orientation) therefore looks
// down Babylon +Z — the shooting range points that way.

// Bowl ground: a flat shooting arena in the middle, ringed by a gentle
// undulating berm that rises to ~0.5 m and falls back to 0 cm at the rim.
// The berm exists only to OCCLUDE the seam where the flat ground meets the
// skydome sphere — you look "over" a low rise instead of at a hard edge.
const GROUND_TUNING = {
    radius: 15,      // m — outer rim
    flatRadius: 10,  // m — dead-flat centre (the arena)
    peak: 0.5,       // m — max berm height (hard cap)
    rings: 64,       // radial subdivisions
    segments: 128,   // angular subdivisions
};

// Berm height at polar (r, theta): 0 inside flatRadius, a noise-modulated
// hump that is 0 at both flatRadius and the rim (blends into the flat arena,
// lands at 0 cm at the edge), capped at peak. Sum-of-sines pseudo-noise is
// deterministic (no per-load variation) and its amplitudes sum to 1, so the
// normalised lump stays in [0,1] and the height never exceeds peak.
function bermHeight(r, theta) {
    const T = GROUND_TUNING;
    if (r <= T.flatRadius) return 0;
    const t = (r - T.flatRadius) / (T.radius - T.flatRadius); // 0..1 across berm
    const env = Math.sin(Math.PI * t);                        // 0 at both ends, 1 mid
    const lump = 0.55 * Math.sin(theta * 5 + r * 0.7)
               + 0.30 * Math.sin(theta * 9 - r * 1.3 + 1.1)
               + 0.15 * Math.sin(theta * 3 + r * 2.1 + 2.7);
    return env * T.peak * (0.5 + 0.5 * lump);
}

// Stochastic ground shader: iq's texture-repetition technique — each tile
// gets a random offset + axis flip, blended across tile borders — so the
// texture tiles to high density with NO seams and NO visible repeat grid
// (the mirror trick read as a kaleidoscope). Full-bright (no lighting), to
// match the emissive look the rest of the static set uses.
const GROUND_TILE_SCALE = 8.0; // tiles across the ground (texel density)
BABYLON.Effect.ShadersStore["groundVertexShader"] = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void){ vUV = uv; gl_Position = worldViewProjection * vec4(position, 1.0); }`;
BABYLON.Effect.ShadersStore["groundFragmentShader"] = `
precision highp float;
varying vec2 vUV;
uniform sampler2D grassTex;
vec4 hash4(vec2 p){
  return fract(sin(vec4(
    1.0 + dot(p, vec2(37.0, 17.0)), 2.0 + dot(p, vec2(11.0, 47.0)),
    3.0 + dot(p, vec2(41.0, 29.0)), 4.0 + dot(p, vec2(23.0, 31.0)))) * 103.0);
}
vec4 noTile(vec2 uv){
  vec2 iuv = floor(uv), fuv = fract(uv);
  // CONTINUOUS derivatives of the pre-transform uv: pass them to textureGrad
  // so mip selection is correct across tile borders. (Plain texture() lets
  // the GPU derive mips from the per-tile offset/flip uv, which jumps at
  // every border -> wrong mip -> flickering grid seams.)
  vec2 ddx = dFdx(uv), ddy = dFdy(uv);
  vec4 ofa = hash4(iuv + vec2(0.0, 0.0)), ofb = hash4(iuv + vec2(1.0, 0.0));
  vec4 ofc = hash4(iuv + vec2(0.0, 1.0)), ofd = hash4(iuv + vec2(1.0, 1.0));
  ofa.zw = sign(ofa.zw - 0.5); ofb.zw = sign(ofb.zw - 0.5);
  ofc.zw = sign(ofc.zw - 0.5); ofd.zw = sign(ofd.zw - 0.5);
  vec2 uva = uv * ofa.zw + ofa.xy, uvb = uv * ofb.zw + ofb.xy;
  vec2 uvc = uv * ofc.zw + ofc.xy, uvd = uv * ofd.zw + ofd.xy;
  vec2 b = smoothstep(0.25, 0.75, fuv);
  return mix(mix(textureGrad(grassTex, uva, ddx * ofa.zw, ddy * ofa.zw),
                 textureGrad(grassTex, uvb, ddx * ofb.zw, ddy * ofb.zw), b.x),
             mix(textureGrad(grassTex, uvc, ddx * ofc.zw, ddy * ofc.zw),
                 textureGrad(grassTex, uvd, ddx * ofd.zw, ddy * ofd.zw), b.x), b.y);
}
void main(void){ gl_FragColor = noTile(vUV * ${GROUND_TILE_SCALE.toFixed(1)}); }`;

// 30 m-wide bowl ground, kept named "ground"/ctx.ground: physics.js builds
// its (trimesh) collider, locomotion clamps to its bounds, and it's the XR
// floor mesh. Square top-down grass texture planar-projected once over the
// bounds; emissive + lighting-disabled to read full-bright under the sky.
function buildGround(scene) {
    const T = GROUND_TUNING;
    const positions = [], uvs = [], indices = [];
    const cols = T.segments + 1;
    for (let i = 0; i <= T.rings; i++) {
        const r = T.radius * i / T.rings;
        for (let j = 0; j <= T.segments; j++) {
            const th = 2 * Math.PI * j / T.segments;
            const x = r * Math.cos(th), z = r * Math.sin(th);
            positions.push(x, bermHeight(r, th), z);
            uvs.push(x / (2 * T.radius) + 0.5, z / (2 * T.radius) + 0.5);
        }
    }
    for (let i = 0; i < T.rings; i++) {
        for (let j = 0; j < T.segments; j++) {
            const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    const vd = new BABYLON.VertexData();
    vd.positions = positions; vd.indices = indices; vd.uvs = uvs; vd.normals = normals;
    const ground = new BABYLON.Mesh("ground", scene);
    vd.applyToMesh(ground);

    const tex = new BABYLON.Texture("assets/floor-grass.jpg", scene);
    tex.wrapU = tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    const mat = new BABYLON.ShaderMaterial("groundMat", scene, "ground", {
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        samplers: ["grassTex"],
    });
    mat.setTexture("grassTex", tex);
    mat.backFaceCulling = false;
    ground.material = mat;
    return ground;
}

// Sky rendering. Two concentric inverted spheres:
//   1. skydome (r=500) — the equirectangular photo, with its flat blue sky
//      knocked out to transparent by a HAND-PAINTED alpha mask
//      (assets/sky-grassland-alpha.png, authored in GIMP from sky.xcf).
//      The JPEG's blue regions carry the compression blocking and the
//      equirect wrap-seam; the mask removes exactly those while keeping the
//      clouds, the mountain ridge, the grass ground and the sun core. Colour
//      stays in the JPEG; the mask rides alongside as a cheap grayscale PNG.
//   2. skygradient (r=505) — a procedural vertical blue gradient drawn behind
//      it, so the artifact-free gradient shows through wherever the sky was
//      knocked out. No texture → no seam, no blocking.
// PORT: in Unity this is a panoramic skybox shader sampling an alpha mask,
// layered over a gradient skybox.
const SKY_TUNING = {
    radius: 500,        // m — photo sphere
    gradientRadius: 505, // m — gradient sphere, just outside the photo
    // Gradient colours, horizon → zenith, sampled from the photo's own sky
    // (near-horizon ≈ .33,.59,.84; zenith ≈ .23,.44,.71) so the gradient
    // meets the kept pale-blue haze band at the mask edge without a colour step.
    horizonColor: new BABYLON.Color3(0.40, 0.62, 0.84),
    zenithColor: new BABYLON.Color3(0.23, 0.44, 0.71),
    zenithBias: 0.55,   // pow() on the horizon→zenith ramp (<1 lifts horizon)
};

let _skyShadersRegistered = false;
function registerSkyShaders() {
    if (_skyShadersRegistered) return;
    _skyShadersRegistered = true;
    const S = BABYLON.Effect.ShadersStore;

    // Photo sphere: flip UVs for inside-of-sphere viewing (matches the old
    // uScale=-1/vScale=-1). Colour from the JPEG, alpha from the painted mask
    // (grayscale: white=opaque land/cloud, black=transparent sky).
    S["skyPanoVertexShader"] = `
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 worldViewProjection;
        varying vec2 vUV;
        void main() {
            vUV = vec2(1.0 - uv.x, 1.0 - uv.y);
            gl_Position = worldViewProjection * vec4(position, 1.0);
        }`;
    S["skyPanoFragmentShader"] = `
        precision highp float;
        varying vec2 vUV;
        uniform sampler2D tex;
        uniform sampler2D alphaTex;
        void main() {
            vec3 rgb = texture2D(tex, vUV).rgb;
            float a = texture2D(alphaTex, vUV).r;
            gl_FragColor = vec4(rgb, a);
        }`;

    // Gradient sphere: colour from view-direction Y (0 at horizon, 1 up).
    S["skyGradVertexShader"] = `
        precision highp float;
        attribute vec3 position;
        uniform mat4 worldViewProjection;
        varying vec3 vDir;
        void main() {
            vDir = normalize(position);
            gl_Position = worldViewProjection * vec4(position, 1.0);
        }`;
    S["skyGradFragmentShader"] = `
        precision highp float;
        varying vec3 vDir;
        uniform vec3 horizonColor, zenithColor;
        uniform float zenithBias;
        void main() {
            float t = pow(clamp(vDir.y, 0.0, 1.0), zenithBias);
            gl_FragColor = vec4(mix(horizonColor, zenithColor, t), 1.0);
        }`;
}

function buildSkydome(scene) {
    registerSkyShaders();
    const T = SKY_TUNING;

    const tex = new BABYLON.Texture("assets/sky-grassland-panorama.jpg", scene);
    const alphaTex = new BABYLON.Texture("assets/sky-grassland-alpha.png", scene);

    const mat = new BABYLON.ShaderMaterial("skyMat", scene,
        { vertex: "skyPano", fragment: "skyPano" },
        { attributes: ["position", "uv"],
          uniforms: ["worldViewProjection"],
          samplers: ["tex", "alphaTex"] });
    mat.setTexture("tex", tex);
    mat.setTexture("alphaTex", alphaTex);
    mat.backFaceCulling = false;
    mat.needAlphaBlending = () => true; // painted mask → transparent sky

    const sky = BABYLON.MeshBuilder.CreateSphere("skydome",
        { diameter: T.radius * 2, segments: 64 }, scene);
    sky.material = mat;
    sky.isPickable = false;
    sky.applyFog = false;
    sky.infiniteDistance = false; // a real finite sphere, per spec
    return { sky, mat };
}

// Opaque gradient sphere just outside the photo sphere. Opaque geometry
// renders before the transparent photo, so it's already in the framebuffer
// when the keyed sky blends over it — the gradient shows wherever alpha→0.
function buildSkyGradient(scene) {
    registerSkyShaders();
    const T = SKY_TUNING;

    const mat = new BABYLON.ShaderMaterial("skyGradMat", scene,
        { vertex: "skyGrad", fragment: "skyGrad" },
        { attributes: ["position"],
          uniforms: ["worldViewProjection", "horizonColor", "zenithColor", "zenithBias"] });
    mat.setColor3("horizonColor", T.horizonColor);
    mat.setColor3("zenithColor", T.zenithColor);
    mat.setFloat("zenithBias", T.zenithBias);
    mat.backFaceCulling = false;

    const dome = BABYLON.MeshBuilder.CreateSphere("skygradient",
        { diameter: T.gradientRadius * 2, segments: 32 }, scene);
    dome.material = mat;
    dome.isPickable = false;
    dome.applyFog = false;
    dome.infiniteDistance = false;
    return { dome, mat };
}

// Giant sky credit, 150 m behind the start point (-Z) and 5 m up, facing
// back toward the player so they read it when they turn around. Plane +
// DynamicTexture (cheap, crisp), emissive + lighting-disabled, white with a
// dark outline so it reads against any sky. Plane aspect matches the texture
// (2:1) so the letters aren't stretched.
function buildSkyText(scene) {
    const W = 2048, H = 1024;
    const tex = new BABYLON.DynamicTexture("skyText", { width: W, height: H }, scene, true);
    tex.hasAlpha = true;
    const g = tex.getContext();
    g.clearRect(0, 0, W, H);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "bold 220px Arial, sans-serif";
    g.lineJoin = "round";
    const lines = ["THIS GAME", "WAS MADE BY", "ROBIN HARTLEY"];
    lines.forEach((line, i) => {
        const y = H * (i + 0.5) / lines.length;
        g.lineWidth = 24;
        g.strokeStyle = "rgba(20,25,35,0.95)";
        g.strokeText(line, W / 2, y);
        g.fillStyle = "#ffffff";
        g.fillText(line, W / 2, y);
    });
    tex.update();

    const mat = new BABYLON.StandardMaterial("skyTextMat", scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;

    const banner = BABYLON.MeshBuilder.CreatePlane("skyText",
        { width: 44, height: 22 }, scene); // 2:1, matches the texture
    banner.position = new BABYLON.Vector3(0, 5, -150);
    banner.rotation.y = Math.PI; // face +Z, back toward the start point
    banner.material = mat;
    banner.isPickable = false;
    banner.applyFog = false;
    return banner;
}

export async function createScene(ctx) {
    const scene = new BABYLON.Scene(ctx.engine);
    scene.clearColor = new BABYLON.Color4(0.05, 0.05, 0.1, 1);

    const camera = new BABYLON.FreeCamera("camera", new BABYLON.Vector3(0, 1.6, 0), scene);
    camera.setTarget(new BABYLON.Vector3(0, 1.3, 3));
    camera.attachControl(ctx.canvas, true);

    // Sun direction taken from the brightest spot in the skydome panorama,
    // measured against the rendered sphere (the sun core and white clouds
    // both clip to pure white, so pixel-max is unreliable — this was read off
    // the actual render): the sun sits at world dir ≈ (-0.69, 0.72, -0.06),
    // ~46° elevation, due -X. The light travels FROM the sun toward the
    // scene, so its direction is the negation.
    const SUN_DIR = new BABYLON.Vector3(-0.69, 0.72, -0.06).normalize();
    const light = new BABYLON.DirectionalLight("topLight", SUN_DIR.negate(), scene);
    light.position = SUN_DIR.scale(30);
    light.intensity = 1.2;
    ctx.sunDir = SUN_DIR; // shared for any sun-aligned work (e.g. bakes)

    const ambient = new BABYLON.HemisphericLight("ambient", new BABYLON.Vector3(0, 1, 0), scene);
    ambient.intensity = 0.15;

    // Global blue sky-fill: lifts the target (and other non-baked props) out
    // of shadow with a cool daylight tint. Baked/emissive statics ignore it
    // (disableLighting); it mainly illuminates the target, bow, arrows, hands.
    const skyFill = new BABYLON.HemisphericLight("skyFill", new BABYLON.Vector3(0, 1, 0), scene);
    skyFill.diffuse = new BABYLON.Color3(0.5, 0.7, 1.0);
    skyFill.groundColor = new BABYLON.Color3(0.35, 0.4, 0.45);
    skyFill.intensity = 0.7;

    const ground = buildGround(scene);

    const { mat: skyGradMat } = buildSkyGradient(scene); // opaque, renders first (behind)
    const { mat: skyMat } = buildSkydome(scene);         // chroma-keyed photo on top
    ctx.skyMat = skyMat;          // exposed for debugging
    ctx.skyGradMat = skyGradMat;  // exposed for live gradient-colour retuning
    buildSkyText(scene);

    const xr = await scene.createDefaultXRExperienceAsync({
        floorMeshes: [ground],
        // Default teleportation rides the thumbstick + shows target visuals;
        // it would fight the draw hand mid-shot. Locomotion isn't part of
        // the range design — stand and shoot.
        disableTeleportation: true,
        inputOptions: {
            doNotLoadControllerMeshes: true,
        },
    });
    console.log("WebXR initialized:", xr.baseExperience ? "OK" : "unavailable");

    // Kill the default pointer-selection laser rays from the controllers —
    // interaction here is hand-proximity based, and the lasers otherwise
    // flick out from the hands (notably mid-shot). Nothing uses them.
    xr.baseExperience.featuresManager.disableFeature(BABYLON.WebXRFeatureName.POINTER_SELECTION);

    ctx.scene = scene;
    ctx.camera = camera;
    ctx.xr = xr;
    ctx.ground = ground;
    return ctx;
}
