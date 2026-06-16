// On-screen debug HUD. Two outputs from one set of lines:
//   - a DOM overlay (#debugHud) — visible on the flat page;
//   - a FIXED world-space signboard near the door — visible INSIDE the
//     headset (the DOM overlay isn't composited into the immersive layer).
//     World-anchored, NOT head-locked: a headset-slaved panel induces
//     nausea, so the player glances toward it instead.
// Key/value lines render at 10 Hz; `pulse` flashes a per-hand indicator so
// haptics are visible under the emulator (which has no actuators).

export function initDebug(ctx) {
    const el = document.getElementById("debugHud");
    const lines = new Map();
    const pulses = { left: 0, right: 0 };
    let accum = 0;

    // --- in-VR signboard: fixed in the world, near the door --------------
    const scene = ctx.scene;
    const TW = 1024, TH = 768;
    const tex = new BABYLON.DynamicTexture("vrHudTex", { width: TW, height: TH }, scene, false);
    tex.hasAlpha = true;
    const mat = new BABYLON.StandardMaterial("vrHudMat", scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    // Large (it's ~5 m away by the door) so the text reads; faces the start
    // point so the player turns toward the door cluster to check it.
    const panel = BABYLON.MeshBuilder.CreatePlane("vrHud", { width: 2.0, height: 1.5 }, scene);
    panel.material = mat;
    panel.isPickable = false;
    panel.position.set(5.0, 1.7, 0.4); // left of the door (door hinge ~x6)
    // Fixed in the world (no head-coupling -> no nausea). Present the plane's
    // READABLE (-Z) side toward the start point so the text isn't mirrored
    // (pointing +Z at the viewer shows the flipped back face; same convention
    // as the sky-credit banner).
    const toPlayer = new BABYLON.Vector3(0, 1.7, 0).subtract(panel.position);
    panel.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
        BABYLON.Vector3.Up(), Math.atan2(-toPlayer.x, -toPlayer.z));

    const drawPanel = (out) => {
        const g = tex.getContext();
        g.clearRect(0, 0, TW, TH);
        g.fillStyle = "rgba(8,14,8,0.72)";
        g.fillRect(0, 0, TW, TH);
        g.font = "26px monospace";
        g.textBaseline = "top";
        g.fillStyle = "#9fe07a";
        const lh = 28;
        out.forEach((ln, i) => g.fillText(ln, 14, 10 + i * lh));
        tex.update(); // invertY default true — correct vertical orientation
    };

    const debug = {
        set(key, value) {
            lines.set(key, typeof value === "number" ? value.toFixed(3) : String(value));
        },
        clear(key) {
            lines.delete(key);
        },
        // amplitude 0–1; decays over ~0.3 s
        pulse(hand, amplitude) {
            pulses[hand] = Math.max(pulses[hand], amplitude);
        },
        update(dt) {
            pulses.left = Math.max(0, pulses.left - dt / 0.3);
            pulses.right = Math.max(0, pulses.right - dt / 0.3);
            accum += dt;
            if (accum < 0.1) return;
            accum = 0;
            const pulseBar = (v) => "#".repeat(Math.round(v * 10)).padEnd(10, "-");
            const out = [`haptic L [${pulseBar(pulses.left)}] R [${pulseBar(pulses.right)}]`];
            for (const [k, v] of lines) out.push(`${k}: ${v}`);
            // Surface the last captured error (see the shim in index.html)
            // so frozen-frame screenshots show WHY.
            const err = window.__errlog?.at(-1);
            if (err) out.push(`LAST ERR [${err.kind}]: ${err.msg.split("\n")[0].slice(0, 120)}`);

            if (el) el.textContent = out.join("\n");
            drawPanel(out); // always: the board is a fixed world object
        },
    };
    return debug;
}
