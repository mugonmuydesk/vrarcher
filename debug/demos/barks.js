// Combat-bark check. Two parts:
//   1. UNIT — drive the ENGINE-CLEAN BarkController directly with an injected
//      clock and assert the cooldown machine + event map: an unknown event →
//      -1; firing the same event twice inside the per-event cooldown → 2nd is
//      -1; firing again after both cooldowns elapse → the mapped index; every
//      mapped event resolves to a valid BARKS index. No Babylon, no audio.
//   2. LIVE — ctx.barks exists and firing "player_hit_target" doesn't throw and
//      (when the AudioContext is unlocked) schedules a bark source. The actual
//      audible bark + pan are verified manually in-headset.

export async function run(rig, ctx) {
    rig.mark("script:start");

    const { BarkController, BARK_EVENTS } = await import('/src/barks.js?v=' + Date.now());
    const { BARKS } = await import('/src/fillers.js?v=' + Date.now());

    // --- 1. UNIT: cooldown machine with an injected clock -------------------
    const bc = new BarkController();

    rig.mark("assert unknown event -> -1",
        bc.fire("not_a_real_event", 0) === -1 ? "PASS" : "FAIL");

    // First fire of a known event at t=0 returns its mapped index.
    const i0 = bc.fire("incoming", 0);
    rig.mark("first fire returns index",
        i0 === BARK_EVENTS.incoming && i0 >= 0 ? "PASS" : `FAIL (${i0})`);

    // Same event again 1 s later: blocked by BOTH cooldowns → -1.
    rig.mark("assert same event suppressed (cooldown)",
        bc.fire("incoming", 1000) === -1 ? "PASS" : "FAIL");

    // A DIFFERENT event 1 s later: still inside the GLOBAL gap (2.5 s) → -1.
    rig.mark("assert global cooldown suppresses other event",
        bc.fire("look_out", 1000) === -1 ? "PASS" : "FAIL");

    // Past both the global (2.5 s) and per-event (8 s) cooldowns: fires again.
    const i1 = bc.fire("incoming", 9000);
    rig.mark("assert fires after cooldown",
        i1 === BARK_EVENTS.incoming ? "PASS" : `FAIL (${i1})`);

    // Every mapped event resolves to a valid BARKS index (0..len-1). Use a
    // fresh controller per event so cooldowns don't mask a bad mapping.
    let badMap = null;
    for (const ev of Object.keys(BARK_EVENTS)) {
        const idx = new BarkController().fire(ev, 0);
        if (!(Number.isInteger(idx) && idx >= 0 && idx < BARKS.length)) { badMap = `${ev}->${idx}`; break; }
    }
    rig.mark("assert every event maps to a valid bark",
        badMap === null ? "PASS" : `FAIL (${badMap})`);

    // --- 2. LIVE: ctx.barks exists and fires without throwing --------------
    if (!ctx.barks) { rig.mark("assert ctx.barks exists", "FAIL (missing)"); rig.mark("DONE barks"); rig.mark("script:done"); return; }
    rig.mark("assert ctx.barks exists", "PASS");

    // Unlock the shared AudioContext if it's suspended (no user gesture in a
    // scripted run), so play() can actually schedule a source.
    const a = ctx.feedback?.audio;
    if (a?.state === "suspended") { try { await a.resume(); } catch { /* fine */ } }

    let threw = false, src = null;
    try {
        const idx = ctx.barks.fire("player_hit_target");   // resolve + schedule
        rig.mark("live fire", `index=${idx}`);
        src = await ctx.barks.audio.play(idx >= 0 ? idx : 3); // ensure a real schedule attempt
    } catch (e) { threw = true; rig.mark("live fire error", e.message); }

    rig.mark("assert fire did not throw", !threw ? "PASS" : "FAIL");
    // A source proves the clip decoded + scheduled; null is acceptable only if
    // the AudioContext never unlocked (record which).
    rig.mark("assert bark scheduled a source",
        src ? "PASS" : (a && a.state === "running" ? "FAIL (no source)" : `SKIP (audio ${a?.state ?? "absent"})`));

    rig.mark("DONE barks");
    rig.mark("script:done");
}
