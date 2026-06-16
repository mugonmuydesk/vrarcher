// Ring target: concentric-ring face on a stand, tagged as an arrow stick
// surface (metadata.arrowTarget). Hits score by ring (gold 10 ... white 2)
// and a scoreboard plane above the target shows the running total.

const RINGS = [
    { r: 0.08, score: 10, color: [0.95, 0.85, 0.20] }, // gold
    { r: 0.20, score: 8, color: [0.85, 0.20, 0.20] },  // red
    { r: 0.32, score: 6, color: [0.25, 0.45, 0.85] },  // blue
    { r: 0.45, score: 4, color: [0.22, 0.22, 0.25] },  // black
    { r: 0.60, score: 2, color: [0.92, 0.92, 0.88] },  // white
];
const FACE_DEPTH = 0.08;
const STAND_HEIGHT_FUDGE = 0.02;

export class Target {
    constructor(ctx, { position, name = "target" } = {}) {
        this.ctx = ctx;
        this.score = 0;
        this.hits = 0;
        this.lastHit = null; // { point, ring, score }
        const scene = ctx.scene;

        this.root = new BABYLON.TransformNode(name, scene);
        this.root.position.copyFrom(position);

        // Face: flat cylinder, axis along Z (string side toward the player).
        // This is the physics/stick surface; the rings are thin cosmetic
        // discs layered on the front.
        const faceMat = new BABYLON.StandardMaterial(`${name}-faceMat`, scene);
        faceMat.diffuseColor = new BABYLON.Color3(0.55, 0.45, 0.3);
        this.face = BABYLON.MeshBuilder.CreateCylinder(`${name}-face`, {
            diameter: RINGS.at(-1).r * 2, height: FACE_DEPTH, tessellation: 48,
        }, scene);
        this.face.rotation.x = Math.PI / 2; // cylinder +Y -> +Z
        this.face.parent = this.root;
        this.face.material = faceMat;

        for (let i = RINGS.length - 1; i >= 0; i--) {
            const ring = RINGS[i];
            const disc = BABYLON.MeshBuilder.CreateCylinder(`${name}-ring${i}`, {
                diameter: ring.r * 2, height: 0.004, tessellation: 48,
            }, scene);
            disc.rotation.x = Math.PI / 2;
            // Stack toward the player so inner rings draw on top.
            disc.position.z = -(FACE_DEPTH / 2 + 0.002 + (RINGS.length - i) * 0.001);
            disc.parent = this.root;
            const m = new BABYLON.StandardMaterial(`${name}-ringMat${i}`, scene);
            m.diffuseColor = new BABYLON.Color3(...ring.color);
            disc.material = m;
        }

        // Simple A-stand: two legs.
        const legMat = new BABYLON.StandardMaterial(`${name}-legMat`, scene);
        legMat.diffuseColor = new BABYLON.Color3(0.35, 0.25, 0.15);
        for (const side of [-1, 1]) {
            const leg = BABYLON.MeshBuilder.CreateBox(`${name}-leg${side}`, {
                width: 0.06, height: position.y + STAND_HEIGHT_FUDGE, depth: 0.06,
            }, scene);
            leg.position.set(side * 0.35, -(position.y / 2), 0.08);
            leg.rotation.z = side * 0.12;
            leg.parent = this.root;
            leg.material = legMat;
        }

        // ANIMATED (not static) with pre-step sync on, so the crank can
        // raise/lower the whole target and the physics face follows the node.
        const faceAgg = new BABYLON.PhysicsAggregate(this.face,
            BABYLON.PhysicsShapeType.CYLINDER, { mass: 0 }, scene);
        faceAgg.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
        faceAgg.body.disablePreStep = false;
        this.faceBody = faceAgg.body;
        this.face.metadata = {
            arrowTarget: true,
            onArrowHit: (info) => this._onHit(info),
        };

        this._buildScoreboard(scene, name);
        this._drawScore();
    }

    _buildScoreboard(scene, name) {
        this._scoreTex = new BABYLON.DynamicTexture(`${name}-scoreTex`,
            { width: 512, height: 160 }, scene, false);
        const mat = new BABYLON.StandardMaterial(`${name}-scoreMat`, scene);
        mat.diffuseTexture = this._scoreTex;
        mat.emissiveColor = new BABYLON.Color3(0.6, 0.6, 0.6); // readable at night
        const board = BABYLON.MeshBuilder.CreatePlane(`${name}-scoreboard`,
            { width: 1.0, height: 0.31, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        board.parent = this.root;
        board.position.set(0, RINGS.at(-1).r + 0.35, 0);
        board.material = mat;
        this._scoreBoard = board;
    }

    _drawScore() {
        const last = this.lastHit ? `  +${this.lastHit.score}` : "";
        this._scoreTex.getContext().clearRect(0, 0, 512, 160);
        this._scoreTex.drawText(`SCORE ${this.score}${last}`,
            24, 100, "bold 56px monospace", "#f0e8c0", "#26301f", true);
    }

    // Start a fresh round: zero the score/scoreboard (start-round button).
    resetRound() {
        this.score = 0;
        this.hits = 0;
        this.lastHit = null;
        this._drawScore();
        this.ctx.debug.set("score", "0 (new round)");
    }

    // Ring score for a world-space hit point (radial distance from the
    // face centre in the face plane).
    ringScoreFor(point) {
        const c = this.face.getAbsolutePosition();
        const r = Math.hypot(point.x - c.x, point.y - c.y);
        const ring = RINGS.find(rr => r <= rr.r);
        return ring ? ring.score : 0;
    }

    _onHit({ point, speed }) {
        const score = this.ringScoreFor(point);
        this.score += score;
        this.hits++;
        this.lastHit = { point: point.clone(), score };
        this._drawScore();
        this.ctx.feedback.sound("score", { pitch: 0.8 + score * 0.06, volume: 0.5 });
        this.ctx.debug.set("score", `${this.score} (${this.hits} hits, last +${score} @${speed.toFixed(0)} m/s)`);
    }
}
