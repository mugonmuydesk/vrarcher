// Hover labels (hand-interactions.md §Ambient/contextual): text that
// appears over an object while a hand hovers it.
//
// attachHoverLabel(ctx, interactable, text) chains onto the interactable's
// existing hover callbacks (it doesn't replace them) and shows a billboard
// DynamicTexture plane above the mesh, fading in/out over ~0.12 s.

const LABEL = {
    width: 0.30, height: 0.075,    // m
    texW: 512, texH: 128,
    rise: 0.12,                    // m above the mesh's bounding top
    fade: 0.12,                    // s
};

export function attachHoverLabel(ctx, interactable, text) {
    const scene = ctx.scene;
    const mesh = interactable.mesh;
    const name = `${mesh.name}-label`;

    const tex = new BABYLON.DynamicTexture(name + "Tex",
        { width: LABEL.texW, height: LABEL.texH }, scene, false);
    tex.hasAlpha = true;
    const g = tex.getContext();
    g.clearRect(0, 0, LABEL.texW, LABEL.texH);
    g.fillStyle = "rgba(10, 14, 8, 0.75)";
    g.fillRect(0, 0, LABEL.texW, LABEL.texH);
    tex.drawText(text, null, 84, "bold 56px monospace", "#e8f0c8", null, true);

    const mat = new BABYLON.StandardMaterial(name + "Mat", scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new BABYLON.Color3(0.85, 0.85, 0.85);
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;

    const plane = BABYLON.MeshBuilder.CreatePlane(name,
        { width: LABEL.width, height: LABEL.height }, scene);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.material = mat;
    plane.isPickable = false;
    plane.visibility = 0;
    plane.setEnabled(false);

    let target = 0;
    const prevBegin = interactable.onHoverBegin;
    const prevEnd = interactable.onHoverEnd;
    interactable.onHoverBegin = (hand) => { target = 1; prevBegin?.(hand); };
    interactable.onHoverEnd = (hand) => { target = 0; prevEnd?.(hand); };

    ctx.updatables.push((dt) => {
        if (plane.visibility === target && target === 0) {
            if (plane.isEnabled()) plane.setEnabled(false);
            return;
        }
        if (!plane.isEnabled()) plane.setEnabled(true);
        const step = dt / LABEL.fade;
        plane.visibility = target > plane.visibility
            ? Math.min(target, plane.visibility + step)
            : Math.max(target, plane.visibility - step);
        // Track the (possibly held/moving) mesh: sit above its bounding top.
        let top;
        if (typeof mesh.getBoundingInfo === "function") {
            const bs = mesh.getBoundingInfo().boundingSphere;
            top = bs.centerWorld.add(new BABYLON.Vector3(0, bs.radiusWorld + LABEL.rise, 0));
        } else {
            top = mesh.getAbsolutePosition().add(new BABYLON.Vector3(0, LABEL.rise, 0));
        }
        plane.position.copyFrom(top);
    });

    return plane;
}
