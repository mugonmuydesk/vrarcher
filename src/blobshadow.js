// Blob (contact) shadows — a soft radial-gradient disc projected straight
// down onto the nearest STATIC surface below (ground, crate top, table...).
// Per object you tune three things (register opts): `alpha` (darkness at
// contact), `fadeHeight` (height by which it has faded to nothing) and
// `scaleAtFade` (footprint multiplier at fadeHeight — <1 shrinks like a
// thrown prop leaving the ground, >1 grows like a high occluder's soft
// penumbra). The disc spans the object's footprint, rotates with its yaw,
// and lerps size while fading alpha linearly with height. Defaults match the
// original near-ground prop behaviour. Works for elevated objects too (the
// target, the soaring eagles) via large fadeHeight + growth.

const FADE_HEIGHT = 1.0;  // m — default: gone by 1 m (near-ground props)
const MIN_SCALE = 0.5;    // default footprint scale at fadeHeight (shrink)
const MAX_ALPHA = 0.45;   // default darkness at contact
const SURFACE_BIAS = 0.003; // m above the surface (z-fighting)
const FOOTPRINT = 1.05;   // blob radius vs object half-extent

export class BlobShadows {
    constructor(ctx) {
        this.ctx = ctx;
        this.entries = [];
        const scene = ctx.scene;

        // Shared radial-gradient texture (soft falloff, white in alpha).
        const SZ = 128;
        const tex = new BABYLON.DynamicTexture("blobTex", { width: SZ, height: SZ }, scene, false);
        tex.hasAlpha = true;
        const g = tex.getContext();
        const grad = g.createRadialGradient(SZ / 2, SZ / 2, 0, SZ / 2, SZ / 2, SZ / 2);
        grad.addColorStop(0, "rgba(0,0,0,1)");
        grad.addColorStop(0.55, "rgba(0,0,0,0.75)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.clearRect(0, 0, SZ, SZ);
        g.fillStyle = grad;
        g.fillRect(0, 0, SZ, SZ);
        tex.update(false);

        this._mat = new BABYLON.StandardMaterial("blobMat", scene);
        this._mat.diffuseColor = BABYLON.Color3.Black();
        this._mat.specularColor = BABYLON.Color3.Black();
        this._mat.emissiveColor = BABYLON.Color3.Black();
        this._mat.opacityTexture = tex;
        this._mat.disableLighting = true;
        this._mat.disableDepthWrite = true;

        // Statics the blob may land on (top surfaces the player can reach).
        const names = ["ground", "crate", "pedestal", "lampTable"];
        this._statics = names
            .map(n => scene.getMeshByName(n)).filter(Boolean);
        this._ray = new BABYLON.Ray(BABYLON.Vector3.Zero(), BABYLON.Vector3.Down(), 5);

        ctx.updatables.push((dt) => this.update(dt));
    }

    update(dt) {
        for (const e of this.entries) this._update(e);
    }

    // node: a mesh or bare TransformNode. opts: radiusX/Z (else from bounds),
    // alpha, fadeHeight, scaleAtFade. See the file header.
    register(node, {
        radiusX = null, radiusZ = null,
        alpha = MAX_ALPHA, fadeHeight = FADE_HEIGHT, scaleAtFade = MIN_SCALE,
    } = {}) {
        let rx = radiusX, rz = radiusZ;
        if ((rx == null || rz == null) && typeof node.getBoundingInfo === "function") {
            const bb = node.getBoundingInfo().boundingBox;
            rx = rx ?? (bb.maximum.x - bb.minimum.x) / 2 * FOOTPRINT;
            rz = rz ?? (bb.maximum.z - bb.minimum.z) / 2 * FOOTPRINT;
        }
        rx = rx ?? 0.2; rz = rz ?? 0.2;
        const disc = BABYLON.MeshBuilder.CreateDisc(`${node.name}-blob`,
            { radius: 1, tessellation: 32 }, this.ctx.scene);
        disc.rotation.x = Math.PI / 2; // face up
        disc.material = this._mat; // shared; per-disc fade via visibility
        disc.isPickable = false;
        disc.setEnabled(false);
        this.entries.push({ mesh: node, disc, rx, rz, alpha, fadeHeight, scaleAtFade });
        return disc;
    }

    _update(e) {
        if (e.mesh.isEnabled && !e.mesh.isEnabled()) { e.disc.setEnabled(false); return; }
        const m = e.mesh.getWorldMatrix();
        const center = e.mesh.absolutePosition;
        // Cast from the object's base (lowest bounding corner) or, for a bare
        // node, its origin.
        const baseY = (typeof e.mesh.getBoundingInfo === "function")
            ? e.mesh.getBoundingInfo().boundingBox.minimumWorld.y
            : center.y;

        this._ray.origin.copyFrom(center);
        this._ray.origin.y = baseY + 0.01;
        const hit = this.ctx.scene.pickWithRay(this._ray,
            (mesh) => this._statics.includes(mesh));
        if (!hit?.hit) { e.disc.setEnabled(false); return; }

        const h = Math.max(0, baseY - hit.pickedPoint.y);
        const t = h / e.fadeHeight;
        if (t >= 1) { e.disc.setEnabled(false); return; }

        const scale = 1 + (e.scaleAtFade - 1) * t; // shrink (<1) or grow (>1)
        e.disc.setEnabled(true);
        e.disc.position.set(center.x, hit.pickedPoint.y + SURFACE_BIAS, center.z);
        e.disc.scaling.set(e.rx * scale, e.rz * scale, 1);
        // Follow the object's yaw so elongated footprints stay aligned.
        const fwd = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Forward(), m);
        e.disc.rotation.y = Math.atan2(fwd.x, fwd.z);
        e.disc.visibility = e.alpha * (1 - t);
    }
}
