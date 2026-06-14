import * as THREE from "three";
import { MOVE, lerp, lerpAngle, type PlayerState } from "@drunkr/shared";

/** Render this many milliseconds behind the latest snapshot for smooth interp.
 * ~2.5 snapshot intervals at 33 Hz — enough to absorb jitter without much lag. */
const INTERP_DELAY = 75;

interface Snap {
  time: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
}

class Remote {
  readonly group = new THREE.Group();
  private head: THREE.Group;
  private legL: THREE.Group;
  private legR: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private hand: THREE.Group;
  private torso: THREE.Mesh;
  private buffer: Snap[] = [];
  private bodyMat: THREE.MeshStandardMaterial;
  private color: THREE.Color;
  private weaponId = "";
  private weaponMesh: THREE.Object3D | null = null;
  private invis = false;
  private stride = 0;
  private prev = new THREE.Vector3();
  private hasPrev = false;
  name: string;
  kills = 0;
  deaths = 0;

  constructor(state: PlayerState) {
    this.name = state.name;
    this.color = new THREE.Color().setHSL(state.hue, 0.85, 0.55);
    const emissive = this.color.clone().multiplyScalar(0.5);
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: this.color, emissive, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.2,
    });

    this.torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.3), this.bodyMat);
    this.torso.position.y = MOVE.height * 0.58;
    this.group.add(this.torso);

    // Head (a group so we can pitch it).
    this.head = new THREE.Group();
    this.head.position.y = MOVE.height * 0.9;
    const headMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.34, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x0a0c18, emissive: this.color, emissiveIntensity: 0.4 }),
    );
    this.head.add(headMesh);
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.08, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    visor.position.set(0, 0, 0.18);
    this.head.add(visor);
    this.group.add(this.head);

    // Legs (pivoting at the hip).
    this.legL = this.makeLimb(0.2, 0.8, 0.24, -0.15, MOVE.height * 0.42);
    this.legR = this.makeLimb(0.2, 0.8, 0.24, 0.15, MOVE.height * 0.42);
    this.group.add(this.legL, this.legR);

    // Arms (pivoting at the shoulder).
    this.armL = this.makeLimb(0.15, 0.5, 0.16, -0.34, MOVE.height * 0.64);
    this.armR = this.makeLimb(0.15, 0.5, 0.16, 0.34, MOVE.height * 0.64);
    this.group.add(this.armL, this.armR);

    // The right hand holds the weapon; angled to point forward.
    this.hand = new THREE.Group();
    this.hand.position.set(0, -0.4, -0.1);
    this.armR.add(this.hand);
    this.armR.rotation.x = -1.2; // raise the gun arm forward

    this.setWeapon(state.weapon ?? "ak");

    const label = this.makeLabel(state.name, this.color);
    this.group.add(label);
  }

  private makeLimb(w: number, h: number, d: number, x: number, y: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.bodyMat);
    mesh.position.y = -h / 2; // pivot at the top
    g.add(mesh);
    return g;
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
      // depthTest true so walls occlude the tag (no more see-through names).
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }),
    );
    sprite.position.y = MOVE.height + 0.4;
    sprite.scale.set(1.6, 0.4, 1);
    sprite.raycast = () => {};
    return sprite;
  }

  /** Build / swap the held weapon model. */
  private setWeapon(id: string) {
    if (id === this.weaponId) return;
    this.weaponId = id;
    if (this.weaponMesh) {
      this.hand.remove(this.weaponMesh);
      this.weaponMesh.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
      });
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x16182a, emissive: 0x18e0ff, emissiveIntensity: 0.4, metalness: 0.6, roughness: 0.4,
    });
    const accent = new THREE.MeshStandardMaterial({ color: 0xff2d9b, emissive: 0xff2d9b, emissiveIntensity: 0.9 });
    const box = (w: number, h: number, d: number, m: THREE.Material, z: number, x = 0, y = 0) => {
      const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      me.position.set(x, y, z);
      g.add(me);
    };
    switch (id) {
      case "sniper":
        box(0.08, 0.1, 0.9, mat, -0.45);
        box(0.05, 0.05, 0.6, mat, -1.0);
        box(0.06, 0.06, 0.2, accent, -0.45, 0, 0.09);
        break;
      case "shotgun":
        box(0.07, 0.08, 0.6, mat, -0.4, -0.05);
        box(0.07, 0.08, 0.6, mat, -0.4, 0.05);
        break;
      case "katana": {
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.04, 1.1),
          new THREE.MeshStandardMaterial({ color: 0x18e0ff, emissive: 0x18e0ff, emissiveIntensity: 1.4 }),
        );
        blade.position.z = -0.6;
        g.add(blade);
        box(0.05, 0.05, 0.16, accent, -0.02);
        break;
      }
      default: // ak
        box(0.08, 0.12, 0.55, mat, -0.32);
        box(0.05, 0.05, 0.3, mat, -0.65);
        box(0.07, 0.18, 0.08, mat, -0.18, 0, -0.16);
    }
    g.traverse((o) => { o.raycast = () => {}; }); // gun isn't a hitbox
    this.weaponMesh = g;
    this.hand.add(g);
  }

  /** Cloaked enemies fade to a faint shimmer. */
  private setInvis(on: boolean) {
    if (on === this.invis) return;
    this.invis = on;
    this.group.traverse((o) => {
      const mat = (o as THREE.Mesh | THREE.Sprite).material as THREE.Material | undefined;
      if (mat) {
        mat.transparent = true;
        (mat as THREE.Material & { opacity: number }).opacity = on ? 0.08 : 1;
      }
    });
  }

  push(state: PlayerState, time: number) {
    this.kills = state.kills;
    this.deaths = state.deaths;
    this.group.visible = !state.dead;
    this.setWeapon(state.weapon ?? "ak");
    this.setInvis(!!state.invis);
    this.buffer.push({
      time,
      x: state.pos.x, y: state.pos.y, z: state.pos.z,
      yaw: state.yaw, pitch: state.pitch,
    });
    if (this.buffer.length > 16) this.buffer.shift();
  }

  render(renderTime: number, dt: number) {
    const buf = this.buffer;
    if (buf.length === 0) return;
    let x: number, y: number, z: number, yaw: number, pitch: number;
    const newest = buf[buf.length - 1];
    if (buf.length === 1) {
      ({ x, y, z, yaw, pitch } = buf[0]);
    } else if (renderTime >= newest.time) {
      // Buffer ran dry (late/dropped packets) — briefly extrapolate from the
      // last two samples instead of freezing, then clamp.
      const prev = buf[buf.length - 2];
      const span = newest.time - prev.time || 1;
      const over = Math.min(renderTime - newest.time, 120);
      x = newest.x + ((newest.x - prev.x) / span) * over;
      y = newest.y + ((newest.y - prev.y) / span) * over;
      z = newest.z + ((newest.z - prev.z) / span) * over;
      yaw = newest.yaw;
      pitch = newest.pitch;
    } else {
      let a = buf[0];
      let b = newest;
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].time <= renderTime && buf[i + 1].time >= renderTime) {
          a = buf[i]; b = buf[i + 1]; break;
        }
      }
      const span = b.time - a.time || 1;
      const t = Math.max(0, Math.min(1, (renderTime - a.time) / span));
      x = lerp(a.x, b.x, t); y = lerp(a.y, b.y, t); z = lerp(a.z, b.z, t);
      yaw = lerpAngle(a.yaw, b.yaw, t); pitch = lerp(a.pitch, b.pitch, t);
    }

    this.group.position.set(x, y, z);
    // The avatar is modelled with its visor/weapon on +Z, so add π to face the
    // aim direction (the player's forward is local -Z).
    this.group.rotation.y = yaw + Math.PI;
    this.head.rotation.x = -pitch;

    this.animate(x, z, dt);
  }

  /** Procedural walk cycle driven by horizontal speed. */
  private animate(x: number, z: number, dt: number) {
    let speed = 0;
    if (this.hasPrev && dt > 0) {
      speed = Math.hypot(x - this.prev.x, z - this.prev.z) / dt;
    }
    this.prev.set(x, 0, z);
    this.hasPrev = true;

    const moving = Math.min(1, speed / MOVE.speed);
    this.stride += dt * (4 + speed * 0.9);
    const swing = Math.sin(this.stride) * 0.7 * moving;

    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    // Right arm stays raised to aim, with a little sway.
    this.armR.rotation.x = -1.2 + swing * 0.1;
    // Subtle torso/head bob.
    this.torso.position.y = MOVE.height * 0.58 + Math.abs(Math.sin(this.stride)) * 0.03 * moving;
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

  onSnapshot(states: PlayerState[], serverTime: number) {
    const now = performance.now();
    const sample = serverTime - now;
    if (!this.offsetInit) {
      this.clockOffset = sample;
      this.offsetInit = true;
    } else {
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
    for (const id of this.players.keys()) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  update(dt: number) {
    const renderTime = performance.now() + this.clockOffset - INTERP_DELAY;
    for (const r of this.players.values()) r.render(renderTime, dt);
  }

  clear() {
    for (const r of this.players.values()) r.dispose(this.scene);
    this.players.clear();
  }

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
