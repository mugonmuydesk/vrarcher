// Phase 0 demo: prove the rig drives the emulator end to end.
// Waves the right hand, ramps the grip closed and open, and logs the
// scrubbed fist curl read back from the hand system.

export async function run(rig, ctx) {
    await rig.run(async (r) => {
        r.reset();
        await r.wait(0.5);

        r.mark("wave:start");
        await r.moveHand("right", [0.45, 1.6, -0.45], { over: 0.6 });
        await r.moveHand("right", [0.05, 1.3, -0.65], { over: 0.6 });
        await r.moveHand("right", [0.25, 1.4, -0.55], { over: 0.4 });
        r.mark("wave:done");

        r.mark("grip:ramp-up");
        await r.rampButton("right", "grip", 0, 1, 0.8);
        await r.wait(0.3);
        r.mark("grip:closed curl=", ctx.hands.hands.right?.curl);

        await r.rampButton("right", "grip", 1, 0, 0.8);
        await r.wait(0.3);
        r.mark("grip:open curl=", ctx.hands.hands.right?.curl);
    });
}
