import * as THREE from "three";
import { MOVE, DECOY } from "@drunkr/shared";

/**
 * A Mirage decoy hologram, rendered as a player-shaped avatar with a procedural
 * run cycle so it reads as a sprinting clone rather than a sliding statue. The
 * server streams its position/yaw each snapshot; the legs/arms are animated
 * locally from how far it travels between snapshots.
 */
export class DecoyAvatar {
  readonly group = new THREE.Group();
  private torso: THREE.Mesh;
  private legL: THREE.Group;
  private legR: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private bodyMat: THREE.MeshStandardMaterial;
  private stride = 0;
  /** Eased 0..1 "is moving" amount (1 = sprinting, 0 = stopped at a wall). */
  private moving = 1;
  private targetMoving = 1;
  private lastSnap = new THREE.Vector3();
  private hasSnap = false;

  constructor(hue: number) {
    const col = new THREE.Color().setHSL(hue, 0.85, 0.55);
    const emissive = col.clone().multiplyScalar(0.5);
    this.bodyMat = new THREE.MeshStandardMaterial({ color: col, emissive, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.2 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x0a0c18, emissive: col, emissiveIntensity: 0.4 });
    const visorMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    // Torso
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.3), this.bodyMat);
    this.torso.position.y = MOVE.height * 0.58;
    this.group.add(this.torso);
    // Head + visor (visor on +Z, which is the decoy's forward / run direction)
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), headMat);
    head.position.y = MOVE.height * 0.9;
    this.group.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.04), visorMat);
    visor.position.set(0, MOVE.height * 0.9, 0.18);
    this.group.add(visor);
    // Legs + arms pivot at the hip / shoulder so they can swing.
    this.legL = this.makeLimb(0.2, 0.8, 0.24, -0.15, MOVE.height * 0.42);
    this.legR = this.makeLimb(0.2, 0.8, 0.24, 0.15, MOVE.height * 0.42);
    this.armL = this.makeLimb(0.15, 0.5, 0.16, -0.34, MOVE.height * 0.64);
    this.armR = this.makeLimb(0.15, 0.5, 0.16, 0.34, MOVE.height * 0.64);
    this.group.add(this.legL, this.legR, this.armL, this.armR);
  }

  private makeLimb(w: number, h: number, d: number, x: number, y: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.bodyMat);
    mesh.position.y = -h / 2; // pivot at the top
    g.add(mesh);
    return g;
  }

  /** Apply the latest network transform and note whether it actually moved. */
  setTransform(x: number, y: number, z: number, yaw: number) {
    if (this.hasSnap) {
      const moved = Math.hypot(x - this.lastSnap.x, z - this.lastSnap.z);
      this.targetMoving = moved > 0.02 ? 1 : 0;
    }
    this.lastSnap.set(x, 0, z);
    this.hasSnap = true;
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
  }

  /** Advance the run cycle. */
  update(dt: number) {
    this.moving += (this.targetMoving - this.moving) * Math.min(1, 10 * dt);
    this.stride += dt * (4 + DECOY.speed * 0.9) * (0.25 + 0.75 * this.moving);
    const swing = Math.sin(this.stride) * 0.7 * this.moving;
    // Legs: alternating fore/aft swing. Arms swing opposite, like a sprint.
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    this.armR.rotation.x = swing * 0.8;
    this.torso.position.y = MOVE.height * 0.58 + Math.abs(Math.sin(this.stride)) * 0.03 * this.moving;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
  }
}
