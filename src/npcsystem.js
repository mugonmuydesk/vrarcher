// NPC adapter: the Babylon/engine touch for the engine-clean NpcBrain
// (npc.js). Loads the CC0 Quaternius mannequin (mesh + skeleton + animation
// clips in one GLB), and every frame feeds the brain the player's world pose
// and applies the brain's position/yaw to a mover node plus a walk<->idle
// animation crossfade. Mirrors the birds.js loader idiom (ImportMeshAsync ->
// __root__ under a mover, localFix orientation, clips by name, ticked from
// ctx.updatables). No behaviour logic lives here — that's all in npc.js.

import { NpcBrain, NPC_TUNING } from "./npc.js";
import { NavGrid } from "./navmesh.js";

const NPC_MODEL = {
    file: "npc-mannequin.glb",
    scale: 1.0,        // mannequin is ~1.8 m at native scale
    groundY: 0.0,      // feet on the flat arena (ground y = 0)
    walkClip: "Walk_Loop",
    idleClip: "Idle_Loop",
    // Identity-pose fix so the model faces the mover's +Z (brain yaw 0).
    // glTF import flips handedness; tuned in-scene.
    localFix: new BABYLON.Quaternion(0, 1, 0, 0), // 180° about Y
    blendRate: 8,      // 1/s — walk/idle weight crossfade
};

export class NpcSystem {
    // opts: { obstacles: [{x,z,r}], spawns: [{x,z}] }
    constructor(ctx, { obstacles = [], spawns = [{ x: -2, z: 2.5 }] } = {}) {
        this.ctx = ctx;
        this.npcs = [];
        this.ready = false;
        this._obstacles = obstacles;
        this._spawns = spawns;
        this._load();
    }

    async _load() {
        // Build the navmesh once from the static props; the brain A*-routes on
        // it so the NPC walks AROUND obstacles instead of into them. Bounds =
        // the wander region (out-of-region props still block in-region cells).
        this.nav = new NavGrid({
            bounds: NPC_TUNING.region,
            cell: 0.3,
            obstacles: this._obstacles,
            clearance: NPC_TUNING.clearance,
        });

        for (let i = 0; i < this._spawns.length; i++) {
            const spawn = this._spawns[i];
            const res = await BABYLON.SceneLoader.ImportMeshAsync(
                null, "assets/", NPC_MODEL.file, this.ctx.scene);
            const root = res.meshes.find(m => m.name === "__root__") || res.meshes[0];
            const mover = new BABYLON.TransformNode(`npc${i}`, this.ctx.scene);
            mover.rotationQuaternion = new BABYLON.Quaternion();
            mover.position.set(spawn.x, NPC_MODEL.groundY, spawn.z);
            root.parent = mover;
            root.position.set(0, 0, 0);
            root.rotationQuaternion = NPC_MODEL.localFix.clone();
            root.scaling.scaleInPlace(NPC_MODEL.scale);

            // Two looped clips, weight-blended (only the needed ones; the GLB
            // ships ~45 groups — stop the rest so they don't drive the rig).
            const walk = res.animationGroups.find(a => a.name === NPC_MODEL.walkClip);
            const idle = res.animationGroups.find(a => a.name === NPC_MODEL.idleClip);
            res.animationGroups.forEach(a => a.stop());
            idle?.start(true); idle?.setWeightForAllAnimatables(1);
            walk?.start(true); walk?.setWeightForAllAnimatables(0);

            this.ctx.blobShadows?.register(mover, { radiusX: 0.4, radiusZ: 0.4, alpha: 0.3 });

            this.npcs.push({
                brain: new NpcBrain({ x: spawn.x, z: spawn.z, obstacles: this._obstacles, navigator: this.nav }),
                mover, walk, idle, walkW: 0,
            });
        }
        this.ready = true;
        this.ctx.updatables.push((dt) => this.update(dt));
    }

    // Player ground position + normalized horizontal look direction.
    _world() {
        const cam = this.ctx.scene.activeCamera;
        if (!cam) return { player: null, gaze: null };
        const p = cam.globalPosition;
        const f = cam.getDirection(BABYLON.Axis.Z);
        const gl = Math.hypot(f.x, f.z) || 1;
        return { player: { x: p.x, z: p.z }, gaze: { x: f.x / gl, z: f.z / gl } };
    }

    update(dt) {
        const world = this._world();
        for (const n of this.npcs) {
            const o = n.brain.update(dt, world);
            n.mover.position.x = o.x;
            n.mover.position.z = o.z;
            BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Y, o.yaw, n.mover.rotationQuaternion);

            // Crossfade walk<->idle by weight (both loop; weights sum to 1).
            const target = o.moving ? 1 : 0;
            n.walkW += (target - n.walkW) * Math.min(1, NPC_MODEL.blendRate * dt);
            n.walk?.setWeightForAllAnimatables(n.walkW);
            n.idle?.setWeightForAllAnimatables(1 - n.walkW);
        }
    }
}
