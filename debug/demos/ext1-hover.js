// Hover-tier demo: three-tier proximity hover + waist-level distance boost.
//  1. tip-only target: no hover at 0.10 gap, hover (tier "tip") at 0.05.
//  2. palm-only target: no hover at 0.07 gap, hover (tier "palm") at 0.04.
//  3. fingertip-only target: no hover at 0.04 gap, hover at 0.015.
//  4. boost: palm gap 0.15 hovers at waist height (boost ×4 ⇒ radius 0.2)
//     but NOT at chest height (radius 0.05).
//
// Targets are demo-local spheres with explicit hoverRadius (a sphere mesh's
// Babylon bounding sphere is the bbox half-diagonal, ×1.73 the true radius).
// Probe placement is exact: read the live probe point, compute the Babylon
// delta to the desired point, move the grip by that delta (orientation held
// constant so the probe offset doesn't rotate).

import { Interactable } from "../../src/interaction.js";

export async function run(rig, ctx) {
    const scene = ctx.scene;
    const right = ctx.hands.hands.right;
    const props = [];

    const mkTarget = (name, radius, pos, tiers) => {
        const m = BABYLON.MeshBuilder.CreateSphere(name, { diameter: radius * 2 }, scene);
        m.position.copyFrom(pos);
        const mat = new BABYLON.StandardMaterial(name + "Mat", scene);
        mat.emissiveColor = new BABYLON.Color3(0.2, 0.6, 0.4);
        m.material = mat;
        const it = ctx.interaction.register(new Interactable(m, { tiers, hoverRadius: radius }));
        props.push({ mesh: m, it });
        return { mesh: m, it, radius };
    };

    const probes = {
        palm: () => right.worldPosition,
        tip: () => right.tipPoint,
        fingertip: () => right.fingertipPoint,
    };

    // Move the right hand so the named probe lands `gap` meters from the
    // target surface, approaching along +X (lateral, so height is the
    // target's height — matters for the boost tests).
    async function placeProbe(probeName, target, gap) {
        const want = target.mesh.position.add(
            new BABYLON.Vector3(target.radius + gap, 0, 0));
        const cur = probes[probeName]();
        const d = want.subtract(cur);
        const p = rig.state.right.position;
        await rig.moveHand("right", [p[0] + d.x, p[1] + d.y, p[2] - d.z], { over: 0.4 });
        await rig.wait(0.35); // 10 Hz hover poll
    }

    const hoverState = () => {
        const it = ctx.interaction.hover.right;
        return it ? `${it.mesh.name}/${ctx.interaction.hoverTier.right}` : "none";
    };
    const assertHover = (label, expected) => {
        const got = hoverState();
        rig.mark(`assert ${label}`, got === expected ? "PASS" : `FAIL (got ${got}, want ${expected})`);
    };
    const park = async () => {
        await rig.moveHand("right", [0.25, 1.4, -0.55], { over: 0.3 });
        await rig.wait(0.3);
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);
        // The fingertip probe needs the hand GLB; wait for the bone.
        for (let i = 0; i < 50 && !right._indexTip; i++) await r.wait(0.1);
        r.mark("indexTip bone", right._indexTip?.bone.name ?? "FALLBACK");

        // --- 1. controller-tip tier (0.075) -----------------------------
        const tipT = mkTarget("tipTarget", 0.05, new BABYLON.Vector3(0.45, 1.3, -0.35), ["tip"]);
        await placeProbe("tip", tipT, 0.10);
        assertHover("tip far(0.10)", "none");
        await placeProbe("tip", tipT, 0.05);
        assertHover("tip near(0.05)", "tipTarget/tip");
        await park();

        // --- 2. palm tier (0.05, no boost at chest height) ---------------
        const palmT = mkTarget("palmTarget", 0.05, new BABYLON.Vector3(0.0, 1.3, -0.45), ["palm"]);
        await placeProbe("palm", palmT, 0.07);
        assertHover("palm far(0.07)", "none");
        await placeProbe("palm", palmT, 0.04);
        assertHover("palm near(0.04)", "palmTarget/palm");
        await park();

        // --- 3. fingertip tier (0.025) -----------------------------------
        const fingT = mkTarget("fingerTarget", 0.02, new BABYLON.Vector3(-0.4, 1.3, -0.35), ["fingertip"]);
        await placeProbe("fingertip", fingT, 0.04);
        assertHover("fingertip far(0.04)", "none");
        await placeProbe("fingertip", fingT, 0.015);
        assertHover("fingertip near(0.015)", "fingerTarget/fingertip");
        await park();
        r.mark("screenshot:tiers");

        // --- 4. waist-level distance boost --------------------------------
        // Same 0.15 lateral palm gap: hovers at y=0.45 (boost ×4 ⇒ 0.2),
        // not at y=1.5 (plain 0.05).
        const lowT = mkTarget("lowTarget", 0.05, new BABYLON.Vector3(0.5, 0.45, -0.5), ["palm"]);
        await placeProbe("palm", lowT, 0.15);
        assertHover("boost waist(0.15)", "lowTarget/palm");
        await park();
        const highT = mkTarget("highTarget", 0.05, new BABYLON.Vector3(0.5, 1.5, -0.5), ["palm"]);
        await placeProbe("palm", highT, 0.15);
        assertHover("boost chest(0.15)", "none");

        // Cleanup so other demos aren't polluted.
        for (const p of props) { ctx.interaction.unregister(p.it); p.mesh.dispose(); }
    });
}
