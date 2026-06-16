// rigctl — scriptable test rig for the Immersive Web Emulator (IWE).
//
// Drives the IWE polyfill (v1.5.0) from page context via unvalidated
// CustomEvents on window. One-way: the DevTools emulator panel does NOT
// reflect injected poses and will overwrite them if touched — don't mix.
//
// All coordinates are XR space: right-handed, -Z forward, +Y up.
// With the pre-XR camera at the origin (see scene.js) the Babylon mapping
// is babylon = (x, y, -z).
//
// Button index gotcha: pa-button-state-change takes the polyfill's INTERNAL
// index, remapped before reaching the xr-standard gamepad:
// internal 1 -> exposed 0 (trigger), internal 2 -> exposed 1 (squeeze/grip).
//
// Exposed as window.rig. Demo scripts live in debug/demos/ and receive the
// rig instance; load one with ?demo=<name>[&autorun=1].

const INTERNAL_BUTTON = { trigger: 1, grip: 2 };

const DEFAULT_HEAD = { position: [0, 1.7, 0], quaternion: [0, 0, 0, 1] };
// Natural resting controller pose: ~30° forward pitch.
const PITCH15 = [-Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)];
const DEFAULT_HAND = {
    left: { position: [-0.25, 1.4, -0.55], quaternion: PITCH15.slice() },
    right: { position: [0.25, 1.4, -0.55], quaternion: PITCH15.slice() },
};

// --- tiny dependency-free vec/quat helpers -------------------------------

const lerpV = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function slerpQ(a, b, t) {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
    if (dot > 0.9995) {
        const q = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t];
        const n = Math.hypot(...q);
        return q.map(v => v / n);
    }
    const theta = Math.acos(dot);
    const s = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / s;
    const wb = Math.sin(t * theta) / s;
    return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

// axis-angle (degrees) -> quaternion [x,y,z,w]
export function quatAxisAngle(axis, degrees) {
    const h = (degrees * Math.PI / 180) / 2;
    const n = Math.hypot(...axis);
    const s = Math.sin(h) / n;
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

export function quatMul(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

const easeInOut = t => t * t * (3 - 2 * t);

// --------------------------------------------------------------------------

class Rig {
    constructor(ctx) {
        this.ctx = ctx;
        this.state = {
            head: structuredClone(DEFAULT_HEAD),
            left: structuredClone(DEFAULT_HAND.left),
            right: structuredClone(DEFAULT_HAND.right),
            buttons: { left: {}, right: {} },
        };
    }

    _dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    poseHead(position, quaternion = this.state.head.quaternion) {
        this.state.head = { position: [...position], quaternion: [...quaternion] };
        this._dispatch("pa-headset-pose-change", { position: [...position], quaternion: [...quaternion] });
    }

    poseHand(hand, position, quaternion = this.state[hand].quaternion) {
        this.state[hand] = { position: [...position], quaternion: [...quaternion] };
        this._dispatch("pa-controller-pose-change", {
            objectName: `${hand}-controller`,
            position: [...position],
            quaternion: [...quaternion],
        });
    }

    // button: 'trigger' | 'grip' | raw internal index. value 0–1.
    setButton(hand, button, value) {
        const buttonIndex = INTERNAL_BUTTON[button] ?? button;
        this.state.buttons[hand][button] = value;
        this._dispatch("pa-button-state-change", {
            objectName: `${hand}-controller`,
            buttonIndex,
            pressed: value > 0.5,
            touched: value > 0,
            value,
        });
    }

    setGrip(hand, value) { this.setButton(hand, "grip", value); }
    setTrigger(hand, value) { this.setButton(hand, "trigger", value); }

    setAxis(hand, axisIndex, value) {
        this._dispatch("pa-analog-value-change", {
            objectName: `${hand}-controller`, axisIndex, value,
        });
    }

    // Park everything at the defaults and zero the buttons.
    reset() {
        this.poseHead(DEFAULT_HEAD.position, DEFAULT_HEAD.quaternion);
        for (const hand of ["left", "right"]) {
            this.poseHand(hand, DEFAULT_HAND[hand].position, DEFAULT_HAND[hand].quaternion);
            this.setGrip(hand, 0);
            this.setTrigger(hand, 0);
        }
    }

    wait(seconds) {
        return new Promise(r => setTimeout(r, seconds * 1000));
    }

    // Generic tween; step receives t in [0,1] (smoothstep-eased unless
    // ease:false — linear gives constant velocity for estimator tests).
    // NOT window.requestAnimationFrame: that loop is suspended entirely
    // while an immersive session is active (verified — 0 ticks/s in XR).
    // Ride the scene's per-frame observable instead; setInterval fallback.
    tween(over, step, ease = true) {
        const shape = ease ? easeInOut : (t => t);
        return new Promise(resolve => {
            const t0 = performance.now();
            const scene = this.ctx?.scene;
            if (scene) {
                const obs = scene.onBeforeRenderObservable.add(() => {
                    const t = Math.min(1, (performance.now() - t0) / (over * 1000));
                    step(shape(t));
                    if (t >= 1) {
                        scene.onBeforeRenderObservable.remove(obs);
                        resolve();
                    }
                });
            } else {
                const id = setInterval(() => {
                    const t = Math.min(1, (performance.now() - t0) / (over * 1000));
                    step(shape(t));
                    if (t >= 1) { clearInterval(id); resolve(); }
                }, 16);
            }
        });
    }

    // Smoothly move a hand to a pose. opts: {over=0.5, quat=null, ease=true}
    async moveHand(hand, to, opts = {}) {
        const { over = 0.5, quat = null, ease = true } = opts;
        const from = this.state[hand];
        const fromPos = [...from.position];
        const fromQuat = [...from.quaternion];
        const toQuat = quat ? [...quat] : fromQuat;
        await this.tween(over, t => {
            this.poseHand(hand, lerpV(fromPos, to, t), slerpQ(fromQuat, toQuat, t));
        }, ease);
    }

    async moveHead(to, opts = {}) {
        const { over = 0.5, quat = null, ease = true } = opts;
        const from = this.state.head;
        const fromPos = [...from.position];
        const fromQuat = [...from.quaternion];
        const toQuat = quat ? [...quat] : fromQuat;
        await this.tween(over, t => {
            this.poseHead(lerpV(fromPos, to, t), slerpQ(fromQuat, toQuat, t));
        }, ease);
    }

    // Ramp an analog button over time (e.g. slow squeeze).
    async rampButton(hand, button, fromV, toV, over = 0.5) {
        await this.tween(over, t => this.setButton(hand, button, fromV + (toV - fromV) * t));
    }

    // Programmatic XR entry — no goggle-button click needed (the IWE
    // polyfill does not require user activation). NB the polyfill's frame
    // pump rides the page's requestAnimationFrame, which Chrome stops for
    // OCCLUDED windows: if entry wedges at ENTERING_XR with healthy code,
    // un-cover the Chrome window (`xdotool windowraise` — no focus/cursor
    // theft) or launch Chrome with --disable-backgrounding-occluded-windows.
    async enterXR() {
        const base = this.ctx.xr.baseExperience;
        if (base.state !== 2) {
            await base.enterXRAsync("immersive-vr", "local-floor");
        }
        await this.calibrate();
        return base.state === 2;
    }

    // Babylon bakes an XR reference-space compensation at session entry
    // from whatever headset pose the IWE extension had persisted (panel
    // state survives reloads), leaving every injected pose translated by a
    // constant offset — and it COMPOUNDS on re-entry. Measured 2026-06-12:
    // ~(-0.14, 0, +0.26) Babylon per entry. Calibrate it away: park the
    // head at DEFAULT_HEAD, measure where the camera actually lands and
    // subtract the error from the rig (camera.position persists — same
    // mechanism locomotion uses).
    async calibrate() {
        const camera = this.ctx.xr.baseExperience?.camera;
        if (!camera) return;
        const [hx, hy, hz] = DEFAULT_HEAD.position; // XR -> babylon: (x, y, -z)
        const target = { x: hx, y: hy, z: -hz };
        // Iterate: the entry compensation settles over the first frames and
        // can overwrite a one-shot correction (verified — y polluted, x/z
        // ignored). Measure-and-subtract until converged. Yaw must be
        // corrected too: with the head parked at x=z=0 a rig yaw error is
        // INVISIBLE to the position check but swings every hand pose at
        // arm's length (and smooth-turn tests leave yaw behind).
        for (let i = 0; i < 8; i++) {
            this.poseHead(DEFAULT_HEAD.position, DEFAULT_HEAD.quaternion);
            await this.wait(0.25);
            const fw = camera.getDirection(BABYLON.Vector3.Forward());
            const yawErr = Math.atan2(fw.x, fw.z); // identity head faces +Z
            const e = {
                x: camera.position.x - target.x,
                y: camera.position.y - target.y,
                z: camera.position.z - target.z,
            };
            if (Math.hypot(e.x, e.y, e.z) < 0.01 && Math.abs(yawErr) < 0.01) return;
            if (Math.abs(yawErr) >= 0.01) {
                // world-frame un-yaw (premultiply), same as locomotion
                BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), -yawErr)
                    .multiplyToRef(camera.rotationQuaternion, camera.rotationQuaternion);
            }
            camera.position.x -= e.x;
            camera.position.y -= e.y;
            camera.position.z -= e.z;
        }
        console.warn("[rigctl] calibrate did not converge");
    }

    async exitXR() {
        const base = this.ctx.xr.baseExperience;
        if (base.state !== 2) return;
        await base.exitXRAsync();
    }

    // Console marker the test harness greps for.
    mark(label, data = "") {
        console.log(`[rigdemo] ${label}`, data);
    }

    // Run a demo function: await rig.run(async r => { ... })
    async run(fn) {
        this.mark("script:start");
        try {
            await fn(this);
            this.mark("script:done");
        } catch (e) {
            this.mark("script:error", e.message ?? String(e));
            throw e;
        }
    }
}

export function installRig(ctx) {
    window.rig = new Rig(ctx);
    return window.rig;
}
