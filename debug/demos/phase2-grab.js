// Phase 2 demo: hover a cube -> grab (grip) -> hand pose snaps -> carry ->
// release. Asserts the full lifecycle through event markers.
//
// Cube sits at Babylon (0.3, 1.1, 0.45) = XR (0.3, 1.1, -0.45).

export async function run(rig, ctx) {
    const cubeIt = [...ctx.interaction.interactables]
        .find(i => i.mesh.name === "grabCube");
    if (!cubeIt) { rig.mark("FAIL: grabCube interactable not found"); return; }

    const events = [];
    cubeIt.onHoverBegin = (h) => { events.push("hoverBegin:" + h); rig.mark("event hoverBegin", h); };
    cubeIt.onHoverEnd = (h) => { events.push("hoverEnd:" + h); rig.mark("event hoverEnd", h); };
    cubeIt.onGrab = (h, info) => { events.push("grab:" + h); rig.mark("event grab", `${h} ${info.grabType}`); };
    cubeIt.onRelease = (h, info) => {
        events.push("release:" + h);
        rig.mark("event release", `${h} v=${info.linearVelocity.length().toFixed(2)}m/s`);
    };

    await rig.run(async (r) => {
        r.reset();
        await r.wait(0.8);

        // Approach the cube (XR coords).
        await r.moveHand("right", [0.3, 1.1, -0.45], { over: 0.8 });
        await r.wait(0.4); // give the 10 Hz hover poll time
        r.mark("assert hover", cubeIt.hoveredBy === "right" ? "PASS" : `FAIL (${cubeIt.hoveredBy})`);

        // Grip-grab.
        await r.rampButton("right", "grip", 0, 1, 0.25);
        await r.wait(0.3);
        r.mark("assert held", cubeIt.heldBy === "right" ? "PASS" : `FAIL (${cubeIt.heldBy})`);
        r.mark("assert parented", cubeIt.mesh.parent ? "PASS" : "FAIL");
        r.mark("screenshot:holding");

        // Carry it somewhere else.
        await r.moveHand("right", [0.1, 1.5, -0.35], { over: 0.7 });
        await r.wait(0.2);
        const cubePos = cubeIt.mesh.absolutePosition;
        const handPos = ctx.hands.hands.right.worldPosition;
        const carried = BABYLON.Vector3.Distance(cubePos, handPos) < 0.15;
        r.mark("assert carried", carried ? "PASS" : `FAIL d=${BABYLON.Vector3.Distance(cubePos, handPos).toFixed(3)}`);

        // Release.
        await r.rampButton("right", "grip", 1, 0, 0.2);
        await r.wait(0.3);
        r.mark("assert released", cubeIt.heldBy === null ? "PASS" : "FAIL");

        const expected = ["hoverBegin:right", "grab:right", "release:right"];
        const ok = expected.every(e => events.includes(e));
        r.mark("assert lifecycle", ok ? "PASS" : `FAIL [${events.join(",")}]`);
    });
}
