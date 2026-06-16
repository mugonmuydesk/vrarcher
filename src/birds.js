// Soaring birds: a few CC0 eagles gliding smooth figure-8s high in the sky.
// Each bird flies a Gerono lemniscate (a clean figure-8) and slowly drifts
// its loop among 3 "stations" at different sky positions, so the motion
// wanders naturally instead of repeating one fixed path (user request:
// "varying between 3 smooth figure of 8s in different positions"). Wings are
// fixed — soaring, not flapping — and the body banks into each turn like a
// red kite.
//
// Engine touch is confined here (mesh load + node transforms); the flight
// path is pure math. Registered on ctx.updatables and ticked by the main
// loop, so it has no private render observer.

const BIRD_TUNING = {
    count: 2,
    scale: 0.26,             // uniform mesh scale (~1.5 m wingspan)
    loopSpeed: [0.16, 0.12], // rad/s along the figure-8 (per bird, varied)
    stationPeriod: 28,       // s to drift through all 3 stations once
    maxBank: 0.6,            // rad — cap on roll into a turn
    bankGain: 2.5,           // turn-rate -> bank
    // Flapping: bursts of 1-3 wingbeats, then a glide of 1-6 s, repeat. The
    // burst's clip phase is eased (smootherstep) so it accelerates out of the
    // glide and decelerates back into it — no jerk at start/stop.
    flapTime: 0.5,           // s per wingbeat (before easing)
    flapsMin: 1, flapsMax: 3,
    pauseMin: 1, pauseMax: 6, // s gliding between bursts
    // 3 figure-8 "stations": center [x,y,z] m, radii [along, cross] m,
    // tilt (rad, plane pitch from horizontal), yaw (rad, heading of the 8).
    // All ABOVE the play area and biased to the FRONT (+Z, downrange), with
    // enough lateral/height spread that the birds drift in and out of the
    // forward view — the player has to look around to keep track of them.
    stations: [
        { c: [-11, 28, 20], r: [16, 8],  tilt: 0.15, yaw: 0.5 },  // ahead-left, high
        { c: [ 13, 33, 30], r: [20, 10], tilt: 0.10, yaw: -0.4 }, // ahead-right, far/higher
        { c: [  2, 24, 13], r: [14, 7],  tilt: 0.20, yaw: 1.2 },  // ahead-centre, lower/closer
    ],
    // Model->path-frame fix: rotates the eagle's identity pose so its beak
    // points along mover +Z with wings level. Tuned in-scene.
    localFix: new BABYLON.Quaternion(0, 0, 0, 1),
};

const smooth = (t) => t * t * (3 - 2 * t);
// smootherstep — zero 1st derivative at both ends, so flap bursts ease in
// and out (the "slow down" into/out of the glide).
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class BirdSystem {
    constructor(ctx) {
        this.ctx = ctx;
        this.birds = [];
        this._t = 0;
        this._load();
    }

    async _load() {
        for (let i = 0; i < BIRD_TUNING.count; i++) {
            const res = await BABYLON.SceneLoader.ImportMeshAsync(
                null, "assets/", "eagle.glb", this.ctx.scene);
            const model = res.meshes.find(m => m.name === "__root__") || res.meshes[0];
            const mover = new BABYLON.TransformNode(`bird${i}`, this.ctx.scene);
            mover.rotationQuaternion = new BABYLON.Quaternion();
            model.parent = mover;
            model.position.set(0, 0, 0);
            model.rotationQuaternion = BIRD_TUNING.localFix.clone();
            model.scaling.scaleInPlace(BIRD_TUNING.scale);

            // Wing-flap clip, scrubbed (never looped) — start it to build the
            // animatables, then pause and hold the first (glide) frame.
            const flying = res.animationGroups.find(a => a.name === "Flying");
            res.animationGroups.forEach(a => a.stop());
            if (flying) { flying.start(false); flying.pause(); flying.goToFrame(flying.from); }

            this.birds.push({
                mover,
                u: i * Math.PI,                       // phase offset along the 8
                speed: BIRD_TUNING.loopSpeed[i % BIRD_TUNING.loopSpeed.length],
                stationPhase: i / BIRD_TUNING.count,  // offset among the stations
                flying, fFrom: flying ? flying.from : 0, fTo: flying ? flying.to : 0,
                mode: "pause", timer: Math.random() * BIRD_TUNING.pauseMax,
                n: 0, elapsed: 0,                     // current burst
            });

            // Faint shadow on the ground far below (only when over the ground
            // disc; the sky has no receiver). Grows + stays faint with height.
            this.ctx.blobShadows?.register(mover, {
                radiusX: 0.8, radiusZ: 0.8, alpha: 0.18, fadeHeight: 60, scaleAtFade: 4,
            });
        }
        this.ctx.updatables.push((dt) => this.update(dt));
    }

    // Blend the 3 stations into one parameter set at cycle position s in [0,3).
    _station(s) {
        const S = BIRD_TUNING.stations;
        const k = Math.floor(s) % 3, n = (k + 1) % 3;
        const f = smooth(s - Math.floor(s));
        const L = (a, b) => a + (b - a) * f;
        const LA = (a, b) => a.map((v, j) => L(v, b[j]));
        return { c: LA(S[k].c, S[n].c), r: LA(S[k].r, S[n].r),
                 tilt: L(S[k].tilt, S[n].tilt), yaw: L(S[k].yaw, S[n].yaw) };
    }

    // World point on a station's tilted figure-8 plane at parameter u.
    _point(st, u) {
        const a = Math.cos(u), b = 2 * Math.sin(u) * Math.cos(u); // Gerono figure-8
        const ct = Math.cos(st.tilt), si = Math.sin(st.tilt);
        const along = new BABYLON.Vector3(Math.cos(st.yaw), 0, Math.sin(st.yaw));
        const cross = new BABYLON.Vector3(-Math.sin(st.yaw) * ct, si, Math.cos(st.yaw) * ct);
        return new BABYLON.Vector3(st.c[0], st.c[1], st.c[2])
            .addInPlace(along.scaleInPlace(st.r[0] * a))
            .addInPlace(cross.scaleInPlace(st.r[1] * b));
    }

    update(dt) {
        this._t += dt;
        const T = BIRD_TUNING;
        for (const bird of this.birds) {
            bird.u += bird.speed * dt;
            const s = ((this._t / T.stationPeriod + bird.stationPhase) % 1) * 3;
            const st = this._station(s);

            const pos = this._point(st, bird.u);
            const fwd = this._point(st, bird.u + 0.04).subtract(pos);
            if (fwd.lengthSquared() < 1e-8) continue;
            fwd.normalize();

            // Bank from the path's horizontal turn over a fixed step (dt-free,
            // so it doesn't jitter with frame timing).
            const fwd2 = this._point(st, bird.u + 0.08)
                .subtract(this._point(st, bird.u + 0.04)).normalize();
            const turn = fwd.x * fwd2.z - fwd.z * fwd2.x; // sin of yaw change
            const bank = Math.max(-T.maxBank, Math.min(T.maxBank, -turn * T.bankGain));

            // Orient: +Z along fwd, up rolled by bank about fwd (same axis
            // construction as bow.seatRotation — valid under any handedness).
            let right = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), fwd).normalize();
            let up = BABYLON.Vector3.Cross(fwd, right).normalize();
            const upB = up.scale(Math.cos(bank)).addInPlace(right.scale(Math.sin(bank)));
            const rightB = BABYLON.Vector3.Cross(upB, fwd).normalize();
            const trueUp = BABYLON.Vector3.Cross(fwd, rightB);
            bird.mover.rotationQuaternion = BABYLON.Quaternion.RotationQuaternionFromAxis(
                rightB, trueUp, fwd);
            bird.mover.position.copyFrom(pos);

            // Flap bursts: glide (hold first frame), then 1-3 eased wingbeats.
            const fl = bird.flying;
            if (!fl) continue;
            if (bird.mode === "pause") {
                bird.timer -= dt;
                if (bird.timer <= 0) {
                    bird.mode = "burst"; bird.elapsed = 0;
                    bird.n = T.flapsMin + Math.floor(Math.random() * (T.flapsMax - T.flapsMin + 1));
                }
            } else {
                bird.elapsed += dt;
                const tn = bird.elapsed / (bird.n * T.flapTime);
                if (tn >= 1) {
                    bird.mode = "pause";
                    bird.timer = T.pauseMin + Math.random() * (T.pauseMax - T.pauseMin);
                    fl.goToFrame(bird.fFrom);          // settle back to the glide pose
                } else {
                    const phase = bird.n * smoother(tn); // eased -> slow in/out
                    const frac = phase - Math.floor(phase);
                    fl.goToFrame(bird.fFrom + frac * (bird.fTo - bird.fFrom));
                }
            }
        }
    }
}
