// Phase 3 motor validation: SPRING_ACCELERATION 6DOF motors, one axis at a
// time, in a flat test setup. These motor types have zero mileage through
// Babylon — prove each axis converges before trusting them in the hand.
//
// Runs WITHOUT entering XR (physics doesn't need a session): load with
// ?demo=phase3-motors and call runDemo() from the console.
//
// Per axis: build anchor(ANIMATED) + probe(DYNAMIC, gravity 0) + 6DOF with
// a spring motor on that axis only, displace the anchor target by a step
// (0.3 m linear / 45° angular), then sample the error. PASS = settles
// within 1.2 s to <0.02 (m or rad) without exceeding 50% overshoot.

import { HAND_TUNING } from "../../src/handphysics.js";
import { AXES } from "../../src/physics.js";

const STEP_LIN = 0.3;             // m
const STEP_ANG = Math.PI / 4;     // rad
const SETTLE_TOL_LIN = 0.02;      // m
const SETTLE_TOL_ANG = 0.02;      // rad
const TIMEOUT = 1.2;              // s

export async function run(rig, ctx) {
    const scene = ctx.scene;
    const phys = ctx.physics;

    await rig.run(async (r) => {
        for (const [axisName, axis] of Object.entries(AXES)) {
            const isLinear = axis < 3;

            // Fresh rig per axis so failures don't contaminate each other.
            const anchorNode = new BABYLON.TransformNode("mt-anchor", scene);
            anchorNode.position.set(0, 1.5, 3);
            anchorNode.rotationQuaternion = new BABYLON.Quaternion();
            const anchorBody = new BABYLON.PhysicsBody(
                anchorNode, BABYLON.PhysicsMotionType.ANIMATED, false, scene);
            const aShape = new BABYLON.PhysicsShapeSphere(BABYLON.Vector3.Zero(), 0.005, scene);
            aShape.filterMembershipMask = 0;
            aShape.filterCollideMask = 0;
            anchorBody.shape = aShape;

            const probeNode = BABYLON.MeshBuilder.CreateBox("mt-probe", { size: 0.07 }, scene);
            probeNode.position.copyFrom(anchorNode.position);
            probeNode.rotationQuaternion = new BABYLON.Quaternion();
            const probeBody = new BABYLON.PhysicsBody(
                probeNode, BABYLON.PhysicsMotionType.DYNAMIC, false, scene);
            const pShape = new BABYLON.PhysicsShapeBox(
                BABYLON.Vector3.Zero(), BABYLON.Quaternion.Identity(),
                new BABYLON.Vector3(0.07, 0.07, 0.07), scene);
            pShape.filterMembershipMask = 0;
            pShape.filterCollideMask = 0;
            probeBody.shape = pShape;
            probeBody.setMassProperties({ mass: HAND_TUNING.mass });
            probeBody.setGravityFactor(0);
            phys.hknp.HP_Body_SetActivationControl(
                phys.bodyId(probeBody), phys.hknp.ActivationControl.ALWAYS_ACTIVE);

            const constraint = phys.make6DoF(scene);
            anchorBody.addConstraint(probeBody, constraint);
            phys.setSpringMotor(constraint, axis,
                isLinear ? HAND_TUNING.linear : HAND_TUNING.angular);

            await r.wait(0.1);

            // Step input via the velocity-correct anchor drive.
            const targetPos = anchorNode.position.clone();
            let targetRot = BABYLON.Quaternion.Identity();
            if (isLinear) {
                const d = [0, 0, 0]; d[axis] = STEP_LIN;
                targetPos.addInPlaceFromFloats(...d);
            } else {
                const ax = [0, 0, 0]; ax[axis - 3] = 1;
                targetRot = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(...ax), STEP_ANG);
            }

            const error = () => {
                if (isLinear) {
                    return Math.abs(targetPos.asArray()[axis] - probeNode.absolutePosition.asArray()[axis]);
                }
                let dq = targetRot.multiply(BABYLON.Quaternion.Inverse(
                    probeNode.rotationQuaternion ?? BABYLON.Quaternion.Identity()));
                if (dq.w < 0) dq.scaleInPlace(-1);
                return 2 * Math.acos(Math.min(1, dq.w));
            };

            // Sample every frame until settled or timeout.
            const tol = isLinear ? SETTLE_TOL_LIN : SETTLE_TOL_ANG;
            const step = isLinear ? STEP_LIN : STEP_ANG;
            const t0 = performance.now() / 1000;
            let settleTime = null, peakOvershoot = 0, lastErr = error();
            let crossed = false;

            anchorBody.setTargetTransform(targetPos, targetRot);

            await new Promise(resolve => {
                const obs = scene.onAfterPhysicsObservable.add(() => {
                    anchorBody.setTargetTransform(targetPos, targetRot); // hold target
                    const t = performance.now() / 1000 - t0;
                    const e = error();
                    if (!crossed && e < tol) crossed = true;
                    if (crossed) peakOvershoot = Math.max(peakOvershoot, e / step);
                    if (e < tol && settleTime === null) settleTime = t;
                    if (e >= tol) settleTime = null; // must STAY settled
                    lastErr = e;
                    if ((settleTime !== null && t - settleTime > 0.25) || t > TIMEOUT) {
                        scene.onAfterPhysicsObservable.remove(obs);
                        resolve();
                    }
                });
            });

            const pass = settleTime !== null && peakOvershoot < 0.5 && Number.isFinite(lastErr);
            r.mark(`motor ${axisName}`, `${pass ? "PASS" : "FAIL"} settle=${settleTime?.toFixed(2) ?? ">1.2"}s overshoot=${(peakOvershoot * 100).toFixed(0)}% finalErr=${lastErr.toFixed(4)}`);

            constraint.dispose();
            probeBody.dispose();
            anchorBody.dispose();
            probeNode.dispose();
            anchorNode.dispose();
        }
    });
}
