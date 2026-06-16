// Havok bootstrap + raw-WASM helpers.
//
// Two engine facts shape everything here (see ROADMAP.md gotchas):
//  - Web Havok has NO CCD at any layer. Fast bodies need manual swept
//    shape-casts each step; HP_World_SetSpeedLimit is the backstop.
//  - Babylon POSITION motors exert zero force until stiffness/damping are
//    set via raw WASM, and the better SPRING_FORCE / SPRING_ACCELERATION
//    motor types exist only below the wrapper. Requires @babylonjs/havok
//    >= 1.3.12 (angular X/Y position motors were broken before).

import HavokPhysics from "../vendor/havok/HavokPhysics_es.js";

export const AXES = {
    LINEAR_X: 0, LINEAR_Y: 1, LINEAR_Z: 2,
    ANGULAR_X: 3, ANGULAR_Y: 4, ANGULAR_Z: 5,
};
export const LINEAR_AXES = [0, 1, 2];
export const ANGULAR_AXES = [3, 4, 5];

// Collision layers (bitmasks) — from BabylonHands tuning.
export const LAYERS = {
    DEFAULT: 0x0001,
    HAND: 0x0002,
    GRABBABLE: 0x0008,
    HELD: 0x0010,
    ARROW: 0x0020,
};

// World speed limit backstop: arrows top out at 30 m/s.
const MAX_LINEAR_SPEED = 40;   // m/s
const MAX_ANGULAR_SPEED = 150; // rad/s

export async function initPhysics(ctx) {
    const hknp = await HavokPhysics({
        locateFile: (file) => "vendor/havok/" + file,
    });
    const plugin = new BABYLON.HavokPlugin(true, hknp);
    ctx.scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), plugin);

    hknp.HP_World_SetSpeedLimit(plugin.world, MAX_LINEAR_SPEED, MAX_ANGULAR_SPEED);

    // Static ground. MESH (trimesh), not BOX: the ground is a bowl (flat
    // centre + raised berm), so a bounding box would float everything ~0.5 m
    // up. A static trimesh matches the real surface — props rest on the flat
    // arena, arrows can bury in the berm.
    const groundAgg = new BABYLON.PhysicsAggregate(
        ctx.ground, BABYLON.PhysicsShapeType.MESH, { mass: 0 }, ctx.scene);

    ctx.physics = {
        plugin,
        hknp,
        groundAgg,
        constraintId,
        bodyId,
        make6DoF,
        setSpringMotor,
        setMotorEnabled,
    };
    console.log("Havok physics initialized (speed limit",
        MAX_LINEAR_SPEED, "m/s /", MAX_ANGULAR_SPEED, "rad/s)");
    return ctx.physics;

    // ---- raw-WASM helpers (closures over hknp) ----------------------------

    // 6DOF constraint with all axes FREE and an EXPLICIT, non-degenerate
    // constraint frame. Babylon's Physics6DoFConstraint defaults the axes
    // to null, which leaves the Havok constraint basis degenerate — motors
    // then only work on LINEAR_X (verified empirically in the motor demo).
    function make6DoF(scene) {
        return new BABYLON.Physics6DoFConstraint({
            pivotA: BABYLON.Vector3.Zero(),
            pivotB: BABYLON.Vector3.Zero(),
            axisA: new BABYLON.Vector3(1, 0, 0),
            axisB: new BABYLON.Vector3(1, 0, 0),
            perpAxisA: new BABYLON.Vector3(0, 1, 0),
            perpAxisB: new BABYLON.Vector3(0, 1, 0),
        }, [], scene);
    }

    // HP_ConstraintId for a Babylon Physics6DoFConstraint.
    function constraintId(constraint) {
        const pd = constraint._pluginData;
        return pd?.constraint ?? pd?.[0] ?? pd;
    }

    // HP_BodyId for a Babylon PhysicsBody (instance index 0).
    function bodyId(body) {
        const pd = body._pluginData ?? body._pluginDataInstances?.[0];
        return pd?.hpBodyId ?? pd;
    }

    // Map an axis INDEX (0–5) to the embind enum INSTANCE. Critical: the
    // WASM functions take embind enums; a raw integer silently marshals to
    // value 0 (LINEAR_X), so every motor call would configure axis X.
    // Found the hard way — only LINEAR_X motors "worked" until this.
    function axisEnum(axis) {
        const order = ["LINEAR_X", "LINEAR_Y", "LINEAR_Z",
            "ANGULAR_X", "ANGULAR_Y", "ANGULAR_Z"];
        return hknp.ConstraintAxis[order[axis]];
    }

    // Configure one axis of a 6DOF constraint as a SPRING_ACCELERATION
    // motor targeting zero offset (the default target — the explicit
    // Set*Target calls return E_INVALIDARG for spring motors).
    // Acceleration-based gains are mass-independent:
    // accel = stiffness*error - damping*vel. maxForce caps the motor.
    function setSpringMotor(constraint, axis, { stiffness, damping, maxForce }) {
        const cid = constraintId(constraint);
        if (!cid) throw new Error("setSpringMotor: no constraint id (constraint not added to bodies yet?)");
        const ax = axisEnum(axis);
        check(hknp.HP_Constraint_SetAxisMotorType(cid, ax, hknp.ConstraintMotorType.SPRING_ACCELERATION));
        check(hknp.HP_Constraint_SetAxisMotorStiffness(cid, ax, stiffness));
        check(hknp.HP_Constraint_SetAxisMotorDamping(cid, ax, damping));
        check(hknp.HP_Constraint_SetAxisMotorMaxForce(cid, ax, maxForce));
    }

    function setMotorEnabled(constraint, axis, enabled) {
        const cid = constraintId(constraint);
        const type = enabled ? hknp.ConstraintMotorType.SPRING_ACCELERATION
            : hknp.ConstraintMotorType.NONE;
        check(hknp.HP_Constraint_SetAxisMotorType(cid, axisEnum(axis), type));
    }

    function check(result) {
        // Havok Result is an embind enum instance: compare .value (0 = OK).
        const r = Array.isArray(result) ? result[0] : result;
        const v = r?.value ?? r;
        if (v !== 0) console.warn("Havok call failed:", v);
        return result;
    }
}
