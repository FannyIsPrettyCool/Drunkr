import * as THREE from "three";
import {
  CollisionWorld, textureForBox, platformPosAt,
  type GameMap, type Ramp, type BoxShape, type Vec3, type MovingPlatform,
} from "@drunkr/shared";
import { getTexture, applyBoxUV } from "../render/Textures.js";

/**
 * Visual geometry for a map primitive. Collision matches the silhouette for
 * cylinders/spheres/wedges (see CollisionWorld); these build the matching mesh.
 */
export function shapeGeometry(shape: BoxShape | undefined, size: Vec3): THREE.BufferGeometry {
  const { x: sx, y: sy, z: sz } = size;
  if (shape === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 24).scale(sx, sy, sz);
  if (shape === "sphere") return new THREE.SphereGeometry(0.5, 24, 16).scale(sx, sy, sz);
  if (shape === "wedge") {
    const s = new THREE.Shape();
    s.moveTo(-sx / 2, -sy / 2);
    s.lineTo(sx / 2, -sy / 2);
    s.lineTo(-sx / 2, sy / 2);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: sz, bevelEnabled: false });
    g.translate(0, 0, -sz / 2);
    return g;
  }
  return new THREE.BoxGeometry(sx, sy, sz);
}

/**
 * A cheap particle stream (THREE.Points) used for jump-pad jets and decorative
 * emitters. Particles spawn at `origin`, fly along `vel` (with spread), fall,
 * fade, and recycle.
 */
class FxStream {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private readonly n: number;
  private readonly maxLife: number;
  private readonly rate: number;
  private readonly spread: number;
  private accum = 0;

  constructor(
    private origin: Vec3,
    private vel: Vec3,
    color: number,
    rate: number,
    spread = 0.6,
    maxLife = 1.1,
    size = 0.22,
  ) {
    this.rate = rate;
    this.spread = spread;
    this.maxLife = maxLife;
    this.n = Math.max(8, Math.ceil(rate * maxLife) + 8);
    this.pos = new Float32Array(this.n * 3);
    this.vx = new Float32Array(this.n);
    this.vy = new Float32Array(this.n);
    this.vz = new Float32Array(this.n);
    this.life = new Float32Array(this.n); // 0 = dead
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = -9999; // park until spawned
    const mat = new THREE.PointsMaterial({
      color, size, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  private spawn(i: number) {
    this.pos[i * 3] = this.origin.x;
    this.pos[i * 3 + 1] = this.origin.y;
    this.pos[i * 3 + 2] = this.origin.z;
    const s = this.spread;
    this.vx[i] = this.vel.x + (Math.random() - 0.5) * s * 4;
    this.vy[i] = this.vel.y + (Math.random() - 0.5) * s * 2;
    this.vz[i] = this.vel.z + (Math.random() - 0.5) * s * 4;
    this.life[i] = this.maxLife * (0.6 + Math.random() * 0.4);
  }

  update(dt: number) {
    this.accum += this.rate * dt;
    let budget = Math.floor(this.accum);
    this.accum -= budget;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] > 0) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; continue; }
        this.pos[i * 3] += this.vx[i] * dt;
        this.pos[i * 3 + 1] += this.vy[i] * dt;
        this.pos[i * 3 + 2] += this.vz[i] * dt;
        this.vy[i] -= 6 * dt; // gentle gravity
      } else if (budget > 0) {
        this.spawn(i);
        budget--;
      }
    }
    (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}

/**
 * Builds the visual geometry for a map and exposes:
 *  - `group`: meshes to add to the scene
 *  - `colliders`: solid meshes for weapon raycasts (walls block bullets)
 *  - `collision`: the world used by the player controller
 *  - `update(ms, dt)`: drives moving platforms + particle fx
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly colliders: THREE.Mesh[] = [];
  readonly collision: CollisionWorld;
  private platformMeshes: { mesh: THREE.Object3D; data: MovingPlatform }[] = [];
  private streams: FxStream[] = [];

  constructor(map: GameMap) {
    this.collision = new CollisionWorld(map);

    for (const box of map.boxes) {
      const isBox = !box.shape || box.shape === "box";
      const geo = shapeGeometry(box.shape, box.size);
      const tex = textureForBox(box);
      let mat: THREE.MeshStandardMaterial;
      if (tex) {
        if (isBox) applyBoxUV(geo, box.size, tex);
        const map3 = getTexture(tex);
        mat = new THREE.MeshStandardMaterial({
          map: map3,
          emissiveMap: map3,
          emissive: 0xffffff,
          emissiveIntensity: 0.18,
          roughness: 0.9,
          metalness: 0.05,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          color: box.color,
          roughness: 0.85,
          metalness: 0.1,
          emissive: box.emissive ?? 0x000000,
          emissiveIntensity: box.emissive ? 0.35 : 0,
        });
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(box.pos.x, box.pos.y, box.pos.z);
      if (box.rot) mesh.rotation.set(box.rot.x, box.rot.y, box.rot.z);
      this.group.add(mesh);
      this.colliders.push(mesh);

      // Neon wireframe edge accent for the cyberpunk look.
      if (box.emissive) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: box.emissive }),
        );
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        this.group.add(edges);
      }
    }

    for (const pad of map.pads ?? []) {
      // A flat, glowing square that sits on the ground.
      const geo = new THREE.BoxGeometry(pad.size.x, pad.size.y, pad.size.z);
      applyBoxUV(geo, pad.size, "pads");
      const padTex = getTexture("pads");
      const mat = new THREE.MeshStandardMaterial({
        map: padTex, emissiveMap: padTex, emissive: pad.color, emissiveIntensity: 0.9,
        metalness: 0.3, roughness: 0.5,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pad.pos.x, pad.pos.y, pad.pos.z);
      this.group.add(mesh);
      // Particles jet out in the launch direction (where the pad sends you).
      const lv = new THREE.Vector3(pad.launch.x, pad.launch.y, pad.launch.z);
      const jet = lv.clone().multiplyScalar(0.32);
      const stream = new FxStream(
        { x: pad.pos.x, y: pad.pos.y + pad.size.y / 2 + 0.1, z: pad.pos.z },
        { x: jet.x, y: jet.y, z: jet.z },
        pad.color, 36, 0.5, 0.9, 0.26,
      );
      this.streams.push(stream);
      this.group.add(stream.points);
      // A small arrow on top pointing the way.
      const dir = lv.length() > 1e-3 ? lv.clone().normalize() : new THREE.Vector3(0, 1, 0);
      const arrow = new THREE.ArrowHelper(
        dir, new THREE.Vector3(pad.pos.x, pad.pos.y + pad.size.y / 2 + 0.05, pad.pos.z), 2.2, pad.color, 0.7, 0.4,
      );
      this.group.add(arrow);
    }

    for (const r of map.ramps ?? []) this.addRamp(r);

    for (const l of map.lights ?? []) {
      const light = new THREE.PointLight(l.color, l.intensity, l.range, 2);
      light.position.set(l.pos.x, l.pos.y, l.pos.z);
      this.group.add(light);
      // A small glowing orb so the fixture itself reads as a light source.
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 12, 10),
        new THREE.MeshBasicMaterial({ color: l.color }),
      );
      orb.position.copy(light.position);
      this.group.add(orb);
    }

    for (const e of map.emitters ?? []) {
      const stream = new FxStream(
        { x: e.pos.x, y: e.pos.y, z: e.pos.z },
        { x: e.dir.x, y: e.dir.y, z: e.dir.z },
        e.color, e.rate, 0.5, 1.4, 0.2,
      );
      this.streams.push(stream);
      this.group.add(stream.points);
    }

    for (const h of map.hazards ?? []) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(h.size.x, h.size.y, h.size.z),
        new THREE.MeshStandardMaterial({
          color: h.color, emissive: h.color, emissiveIntensity: 0.6,
          transparent: true, opacity: 0.4, depthWrite: false,
        }),
      );
      mesh.position.set(h.pos.x, h.pos.y, h.pos.z);
      this.group.add(mesh);
    }

    for (const p of map.platforms ?? []) {
      const geo = new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z);
      const tex = textureForBox({ pos: p.pos, size: p.size, color: p.color, emissive: p.emissive, texture: p.texture });
      let mat: THREE.MeshStandardMaterial;
      if (tex) {
        applyBoxUV(geo, p.size, tex);
        const t = getTexture(tex);
        mat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: p.emissive ?? 0x888888, emissiveIntensity: 0.25, roughness: 0.8, metalness: 0.1 });
      } else {
        mat = new THREE.MeshStandardMaterial({ color: p.color, emissive: p.emissive ?? 0x18e0ff, emissiveIntensity: 0.4, roughness: 0.7, metalness: 0.15 });
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      this.group.add(mesh);
      this.colliders.push(mesh); // bullets hit it at its current position
      this.platformMeshes.push({ mesh, data: p });
    }

    this.addGrid(map.bounds);
  }

  /** Move platforms onto the synced clock and advance particle fx. */
  update(ms: number, dt: number) {
    for (const { mesh, data } of this.platformMeshes) {
      const c = platformPosAt(data, ms);
      mesh.position.set(c.x, c.y, c.z);
    }
    for (const s of this.streams) s.update(dt);
  }

  /** A textured tilted slab whose top face is the walkable slope surface. */
  private addRamp(r: Ramp) {
    const alongX = r.dir === 0 || r.dir === 1;
    const L = alongX ? r.size.x : r.size.z;
    const angle = Math.atan2(r.size.y, L);
    const hyp = Math.hypot(L, r.size.y);
    const thick = 0.5;
    const dims = alongX
      ? new THREE.Vector3(hyp, thick, r.size.z)
      : new THREE.Vector3(r.size.x, thick, hyp);

    const geo = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
    const key = textureForBox({ pos: r.pos, size: r.size, color: r.color, emissive: r.emissive, texture: r.texture }) ?? "walls_dark";
    applyBoxUV(geo, dims, key);
    const tex = getTexture(key);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: r.emissive ?? 0x666666, emissiveIntensity: 0.2, roughness: 0.9, metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(r.pos.x, r.pos.y + r.size.y / 2 - thick * 0.4, r.pos.z);
    if (r.dir === 0) mesh.rotation.z = angle;
    else if (r.dir === 1) mesh.rotation.z = -angle;
    else if (r.dir === 2) mesh.rotation.x = -angle;
    else mesh.rotation.x = angle;
    this.group.add(mesh);
    this.colliders.push(mesh);
  }

  /** A subtle neon floor grid for spatial reference. */
  private addGrid(bounds: number) {
    const grid = new THREE.GridHelper(bounds * 2, bounds, 0x18e0ff, 0x131a33);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    grid.position.y = 0.02;
    this.group.add(grid);
  }
}
