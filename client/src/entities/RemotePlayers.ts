import * as THREE from "three";
import { MOVE, lerp, lerpAngle, type PlayerState } from "@drunkr/shared";

/** Render this many milliseconds behind the latest snapshot for smooth interp. */
const INTERP_DELAY = 100;

interface Snap {
  time: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
}

class Remote {
  readonly group = new THREE.Group();
  private head: THREE.Mesh;
  private buffer: Snap[] = [];
  name: string;
  kills = 0;
  deaths = 0;

  constructor(state: PlayerState) {
    this.name = state.name;
    const color = new THREE.Color().setHSL(state.hue, 0.85, 0.55);
    const emissive = color.clone().multiplyScalar(0.5);

    const bodyMat = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: 0.6,
      roughness: 0.5,
      metalness: 0.2,
    });

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.35), bodyMat);
    torso.position.y = MOVE.height * 0.55;
    this.group.add(torso);

    // Legs
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.3), bodyMat);
    legs.position.y = MOVE.height * 0.2;
    this.group.add(legs);

    // Head
    this.head = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.34, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x0a0c18, emissive: color, emissiveIntensity: 0.4 }),
    );
    this.head.position.y = MOVE.height * 0.92;
    this.group.add(this.head);

    // Facing visor
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.08, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    visor.position.set(0, MOVE.height * 0.92, 0.18);
    this.group.add(visor);

    this.group.add(this.makeLabel(state.name, color));
  }

  private makeLabel(name: string, color: THREE.Color): THREE.Sprite {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.font = "bold 34px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#" + color.getHexString();
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 8;
    ctx.fillText(name, 128, 36);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
    );
    sprite.position.y = MOVE.height + 0.35;
    sprite.scale.set(1.6, 0.4, 1);
    // The name tag must never be a bullet target (and sprite raycasting needs
    // a camera on the raycaster) — exclude it entirely.
    sprite.raycast = () => {};
    return sprite;
  }

  push(state: PlayerState, time: number) {
    this.kills = state.kills;
    this.deaths = state.deaths;
    this.group.visible = !state.dead;
    this.buffer.push({
      time,
      x: state.pos.x, y: state.pos.y, z: state.pos.z,
      yaw: state.yaw, pitch: state.pitch,
    });
    if (this.buffer.length > 16) this.buffer.shift();
  }

  render(renderTime: number) {
    const buf = this.buffer;
    if (buf.length === 0) return;
    if (buf.length === 1) {
      this.apply(buf[0].x, buf[0].y, buf[0].z, buf[0].yaw, buf[0].pitch);
      return;
    }
    // Find the two snapshots straddling renderTime.
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= renderTime && buf[i + 1].time >= renderTime) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }
    const span = b.time - a.time || 1;
    const t = Math.max(0, Math.min(1, (renderTime - a.time) / span));
    this.apply(
      lerp(a.x, b.x, t),
      lerp(a.y, b.y, t),
      lerp(a.z, b.z, t),
      lerpAngle(a.yaw, b.yaw, t),
      lerp(a.pitch, b.pitch, t),
    );
  }

  private apply(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.head.rotation.x = pitch;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

/** Manages all remote player avatars and their snapshot interpolation. */
export class RemotePlayers {
  private players = new Map<number, Remote>();
  /** Estimated offset between server clock and local clock (serverNow ≈ now + offset). */
  private clockOffset = 0;
  private offsetInit = false;

  constructor(private scene: THREE.Scene, private localId: () => number) {}

  add(state: PlayerState) {
    if (state.id === this.localId() || this.players.has(state.id)) return;
    const r = new Remote(state);
    this.players.set(state.id, r);
    this.scene.add(r.group);
  }

  remove(id: number) {
    const r = this.players.get(id);
    if (r) {
      r.dispose(this.scene);
      this.players.delete(id);
    }
  }

  /** Ingest a server snapshot. */
  onSnapshot(states: PlayerState[], serverTime: number) {
    const now = performance.now();
    const sample = serverTime - now;
    if (!this.offsetInit) {
      this.clockOffset = sample;
      this.offsetInit = true;
    } else {
      // Smooth the offset to absorb jitter.
      this.clockOffset = lerp(this.clockOffset, sample, 0.1);
    }

    const seen = new Set<number>();
    for (const s of states) {
      if (s.id === this.localId()) continue;
      seen.add(s.id);
      let r = this.players.get(s.id);
      if (!r) {
        this.add(s);
        r = this.players.get(s.id);
      }
      r?.push(s, serverTime);
    }
    // Remove players no longer present (defensive; pleave normally handles this).
    for (const id of this.players.keys()) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  update() {
    const renderTime = performance.now() + this.clockOffset - INTERP_DELAY;
    for (const r of this.players.values()) r.render(renderTime);
  }

  /** Meshes used for client-side hit raycasting, tagged with player id. */
  hittables(): { mesh: THREE.Object3D; id: number }[] {
    const out: { mesh: THREE.Object3D; id: number }[] = [];
    for (const [id, r] of this.players) {
      if (r.group.visible) out.push({ mesh: r.group, id });
    }
    return out;
  }

  get(id: number): Remote | undefined {
    return this.players.get(id);
  }

  all(): Map<number, Remote> {
    return this.players;
  }

  position(id: number): THREE.Vector3 | null {
    const r = this.players.get(id);
    return r ? r.group.position : null;
  }
}
