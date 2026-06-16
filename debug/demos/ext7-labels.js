// Hover-label demo: labels fade in over hovered objects and back out.
//  1. Ball: hover -> "BALL" plane enabled + visibility ~1, floats above the
//     mesh; retreat -> fades back to hidden.
//  2. Crank handle: same on a non-mesh-bounded interactable.
//
// Ball at Babylon (0.45, 0.86, 0.55); crank knob via getAbsolutePosition.

export async function run(rig, ctx) {
    const scene = ctx.scene;
    const ballLabel = scene.getMeshByName("ball-label");
    const crankLabel = scene.getMeshByName("targetCrank-handle-label");
    if (!ballLabel || !crankLabel) {
        rig.mark(`FAIL: labels missing (ball=${!!ballLabel} crank=${!!crankLabel})`);
        return;
    }

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);

        r.mark("assert label starts hidden",
            (!ballLabel.isEnabled() || ballLabel.visibility === 0) ? "PASS" : "FAIL");

        // --- 1. ball -------------------------------------------------------
        await r.moveHand("right", [0.45, 0.93, -0.55], { over: 0.7 });
        await r.wait(0.5);
        const vis1 = ballLabel.visibility;
        const above = ballLabel.position.y > 0.92;
        r.mark("ball label", `vis=${vis1.toFixed(2)} y=${ballLabel.position.y.toFixed(2)}`);
        r.mark("assert ball label shown",
            (ballLabel.isEnabled() && vis1 > 0.9 && above) ? "PASS" : "FAIL");
        r.mark("screenshot:ball-label");

        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.5 });
        await r.wait(0.6);
        r.mark("assert ball label hidden",
            (!ballLabel.isEnabled() || ballLabel.visibility === 0) ? "PASS" : "FAIL");

        // --- 2. crank handle -------------------------------------------------
        const kp = ctx.crank.handle.getAbsolutePosition();
        await r.moveHand("right", [kp.x, kp.y, -kp.z], { over: 0.7 });
        await r.wait(0.5);
        r.mark("assert crank label shown",
            (crankLabel.isEnabled() && crankLabel.visibility > 0.9) ? "PASS" : "FAIL");

        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.5 });
        await r.wait(0.6);
        r.mark("assert crank label hidden",
            (!crankLabel.isEnabled() || crankLabel.visibility === 0) ? "PASS" : "FAIL");
    });
}
