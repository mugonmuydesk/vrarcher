// Button demo: hover plunger (start round) + fingertip button.
//  1. Hover button: press to 96% -> down event + score resets; back off to
//     92% -> STILL engaged (hysteresis, release is at 90%); withdraw -> up.
//  2. Fingertip button: fingertip at 0.08 -> hovering highlight, no press;
//     push the tip 0.02 in -> pressed + down event; withdraw -> up.
//
// Hover button touch surface rest: (0.7, 1.03, 0.05) Babylon, palm radius
// 0.05 => palm y = 1.08 - depth. Fingertip button touch surface:
// (0.7, 0.65, -0.051), axis (0,0,-1).

export async function run(rig, ctx) {
    const start = ctx.buttons?.start, fancy = ctx.buttons?.fancy;
    if (!start || !fancy) { rig.mark("FAIL: buttons missing"); return; }
    const right = ctx.hands.hands.right;

    const ev = { sDown: 0, sUp: 0, sHeld: 0, fDown: 0, fUp: 0 };
    const origs = { sd: start.onDown, su: start.onUp, fd: fancy.onDown, fu: fancy.onUp };
    start.onDown = (h) => { ev.sDown++; origs.sd?.(h); };
    start.onUp = (h) => { ev.sUp++; origs.su?.(h); };
    start.onHeld = () => { ev.sHeld++; };
    fancy.onDown = (h) => { ev.fDown++; origs.fd?.(h); };
    fancy.onUp = (h) => { ev.fUp++; origs.fu?.(h); };

    // Move the right hand so the named probe lands exactly at targetB.
    async function placeProbe(probe, targetB, over = 0.45) {
        const cur = probe();
        const d = targetB.subtract(cur);
        const p = rig.state.right.position;
        await rig.moveHand("right", [p[0] + d.x, p[1] + d.y, p[2] - d.z], { over });
        await rig.wait(0.15);
    }
    const palm = () => right.worldPosition;
    const tip = () => right.fingertipPoint;
    const V3 = (x, y, z) => new BABYLON.Vector3(x, y, z);

    await rig.run(async (r) => {
        r.reset();
        await r.wait(1.0);
        for (let i = 0; i < 50 && !right._indexTip; i++) await r.wait(0.1);

        // --- 1. hover button ---------------------------------------------
        ctx.target.score = 37; // must reset to 0 on start-round press
        await r.moveHand("right", [0.7, 1.3, -0.05], { over: 0.6 });
        await r.wait(0.2);

        await placeProbe(palm, V3(0.7, 0.984, 0.05)); // depth 0.096 = 96%
        r.mark("hover btn depth", start.depth.toFixed(3));
        r.mark("assert hover btn down", (start.engaged && ev.sDown === 1)
            ? "PASS" : `FAIL engaged=${start.engaged} down=${ev.sDown}`);
        r.mark("assert start round reset", ctx.target.score === 0
            ? "PASS" : `FAIL score=${ctx.target.score}`);
        r.mark("screenshot:hover-btn-down");

        await placeProbe(palm, V3(0.7, 0.988, 0.05)); // back to 92%
        r.mark("assert hysteresis holds", (start.engaged && ev.sUp === 0)
            ? "PASS" : `FAIL engaged=${start.engaged} up=${ev.sUp}`);
        const heldBefore = ev.sHeld;

        await r.moveHand("right", [0.7, 1.3, -0.05], { over: 0.4 });
        await r.wait(0.2);
        r.mark("assert hover btn up", (!start.engaged && ev.sUp === 1 && heldBefore > 5)
            ? "PASS" : `FAIL engaged=${start.engaged} up=${ev.sUp} held=${heldBefore}`);

        // --- 2. fingertip button -------------------------------------------
        // Stage in front of the button, then hover at 0.08.
        await r.moveHand("right", [0.7, 0.65, 0.35], { over: 0.6 });
        await r.wait(0.2);
        await placeProbe(tip, V3(0.7, 0.65, -0.051 - 0.08));
        await r.wait(0.2);
        r.mark("assert tip hover", (fancy.hovering && !fancy.pressed && ev.fDown === 0)
            ? "PASS" : `FAIL hov=${fancy.hovering} press=${fancy.pressed} down=${ev.fDown}`);

        await placeProbe(tip, V3(0.7, 0.65, -0.039), 0.6); // 12 mm into the cap
        r.mark("tip depth", fancy.depth.toFixed(4));
        r.mark("assert tip pressed", (fancy.pressed && ev.fDown === 1)
            ? "PASS" : `FAIL press=${fancy.pressed} down=${ev.fDown}`);
        r.mark("screenshot:tip-pressed");

        await placeProbe(tip, V3(0.7, 0.65, -0.3), 0.4);
        await r.wait(0.2);
        r.mark("assert tip released", (!fancy.pressed && ev.fUp === 1)
            ? "PASS" : `FAIL press=${fancy.pressed} up=${ev.fUp}`);

        // Restore wiring.
        start.onDown = origs.sd; start.onUp = origs.su; start.onHeld = null;
        fancy.onDown = origs.fd; fancy.onUp = origs.fu;
    });
}
