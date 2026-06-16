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
        // the player play-area (the ground mesh bounding box, inset to match
        // locomotion's clamp — locomotion.js LOCO_TUNING.boundsInset = 0.3) so
        // the commanded companion can path to wherever the player can walk. Fall
        // back to the hardcoded wander region if the ground isn't available.
        const region = this._playRegion() || NPC_TUNING.region;
        NPC_TUNING.region = region;   // the wander path uses this too
        this._region = region;
        this.nav = new NavGrid({
            bounds: region,
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

    // Play-area bounds = the ground mesh's world bounding box, inset 0.3 m to
    // match locomotion's player clamp (LOCO_TUNING.boundsInset). Returns a
    // {x0,x1,z0,z1} region, or null if the ground isn't ready (caller falls back
    // to the hardcoded NPC_TUNING.region).
    _playRegion() {
        const g = this.ctx.ground;
        if (!g || !g.getBoundingInfo) return null;
        const bb = g.getBoundingInfo().boundingBox;
        const inset = 0.3; // keep in sync with locomotion.js LOCO_TUNING.boundsInset
        return {
            x0: bb.minimumWorld.x + inset, x1: bb.maximumWorld.x - inset,
            z0: bb.minimumWorld.z + inset, z1: bb.maximumWorld.z - inset,
        };
    }

    // Player ground position + normalized horizontal look direction + travel
    // heading. heading = the player's locomotion velocity flattened/normalized
    // when they're actually moving, else null (the brain falls back to gaze).
    _world() {
        const cam = this.ctx.scene.activeCamera;
        if (!cam) return { player: null, gaze: null, heading: null };
        const p = cam.globalPosition;
        const f = cam.getDirection(BABYLON.Axis.Z);
        const gl = Math.hypot(f.x, f.z) || 1;
        let heading = null;
        const v = this.ctx.locomotion?.velocity;
        if (v) {
            const vl = Math.hypot(v.x, v.z);
            if (vl > 0.15) heading = { x: v.x / vl, z: v.z / vl }; // > ~0.15 m/s = moving
        }
        return { player: { x: p.x, z: p.z }, gaze: { x: f.x / gl, z: f.z / gl }, heading };
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
