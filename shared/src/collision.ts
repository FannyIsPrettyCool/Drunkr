import type { GameMap, MapBox } from "./map.js";
import type { Vec3 } from "./math.js";

export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function boxToAABB(b: MapBox): AABB {
  const hx = b.size.x / 2, hy = b.size.y / 2, hz = b.size.z / 2;
  if (!b.rot || (b.rot.x === 0 && b.rot.y === 0 && b.rot.z === 0)) {
    return {
      minX: b.pos.x - hx, minY: b.pos.y - hy, minZ: b.pos.z - hz,
      maxX: b.pos.x + hx, maxY: b.pos.y + hy, maxZ: b.pos.z + hz,
    };
  }
  // Rotated box → axis-aligned bounding box that encloses the rotated extents
  // (R = Rx·Ry·Rz). Collision is the enclosing box (slightly loose).
  const cx = Math.cos(b.rot.x), sx = Math.sin(b.rot.x);
  const cy = Math.cos(b.rot.y), sy = Math.sin(b.rot.y);
  const cz = Math.cos(b.rot.z), sz = Math.sin(b.rot.z);
  const ex = Math.abs(cy * cz) * hx + Math.abs(cy * sz) * hy + Math.abs(sy) * hz;
  const ey = Math.abs(cx * sz + sx * sy * cz) * hx + Math.abs(cx * cz - sx * sy * sz) * hy + Math.abs(sx * cy) * hz;
  const ez = Math.abs(sx * sz - cx * sy * cz) * hx + Math.abs(sx * cz + cx * sy * sz) * hy + Math.abs(cx * cy) * hz;
  return {
    minX: b.pos.x - ex, minY: b.pos.y - ey, minZ: b.pos.z - ez,
    maxX: b.pos.x + ex, maxY: b.pos.y + ey, maxZ: b.pos.z + ez,
  };
}

/**
 * Axis-separated AABB collision for the player capsule (approximated as a
 * vertical box of half-width `radius` and full `height`, feet at `pos.y`).
 *
 * Movement is applied and resolved one axis at a time so the player slides
 * smoothly along walls instead of catching on corners. Shared by the client
 * player controller and the server-side bot simulation.
 */
interface PadZone {
  minX: number; maxX: number; minZ: number; maxZ: number; top: number;
  launch: Vec3;
}

interface RampZone {
  minX: number; maxX: number; minZ: number; maxZ: number;
  baseY: number; height: number; dir: number;
}

export class CollisionWorld {
  readonly boxes: AABB[];
  private pads: PadZone[];
  private ramps: RampZone[];

  constructor(map: GameMap) {
    this.boxes = map.boxes.map(boxToAABB);
    this.pads = (map.pads ?? []).map((p) => ({
      minX: p.pos.x - p.size.x / 2,
      maxX: p.pos.x + p.size.x / 2,
      minZ: p.pos.z - p.size.z / 2,
      maxZ: p.pos.z + p.size.z / 2,
      top: p.pos.y + p.size.y / 2,
      launch: p.launch,
    }));
    this.ramps = (map.ramps ?? []).map((r) => ({
      minX: r.pos.x - r.size.x / 2,
      maxX: r.pos.x + r.size.x / 2,
      minZ: r.pos.z - r.size.z / 2,
      maxZ: r.pos.z + r.size.z / 2,
      baseY: r.pos.y,
      height: r.size.y,
      dir: r.dir,
    }));
  }

  /** Surface height of a ramp under `pos`, or null if not over any ramp. */
  rampGround(pos: Vec3): number | null {
    for (const r of this.ramps) {
      if (pos.x <= r.minX || pos.x >= r.maxX || pos.z <= r.minZ || pos.z >= r.maxZ) continue;
      let t: number; // 0 at low edge, 1 at high edge
      if (r.dir === 0) t = (pos.x - r.minX) / (r.maxX - r.minX);
      else if (r.dir === 1) t = (r.maxX - pos.x) / (r.maxX - r.minX);
      else if (r.dir === 2) t = (pos.z - r.minZ) / (r.maxZ - r.minZ);
      else t = (r.maxZ - pos.z) / (r.maxZ - r.minZ);
      return r.baseY + r.height * (t < 0 ? 0 : t > 1 ? 1 : t);
    }
    return null;
  }

  /** If grounded over a jump pad, returns its launch velocity; else null. */
  padLaunch(pos: Vec3): Vec3 | null {
    for (const p of this.pads) {
      if (
        pos.x > p.minX && pos.x < p.maxX &&
        pos.z > p.minZ && pos.z < p.maxZ &&
        pos.y < p.top + 0.8 && pos.y > p.top - 1.2
      ) {
        return p.launch;
      }
    }
    return null;
  }

  /**
   * Moves `pos` (feet position, mutated) by `vel` over `dt`, resolving against
   * world geometry. `vel` is also mutated (zeroed on the axes that collide).
   * Returns whether the player is standing on something this step.
   */
  move(
    pos: Vec3,
    vel: Vec3,
    radius: number,
    height: number,
    dt: number,
  ): { grounded: boolean; hitWall: boolean } {
    // Sub-step so high speed (bhop, dash, jump pads, blink) can't tunnel
    // through walls or the floor in a single frame.
    const maxDisp = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(maxDisp / (radius * 0.75))));
    const sdt = dt / steps;
    let grounded = false;
    let hitWall = false;
    for (let s = 0; s < steps; s++) {
      const r = this.stepAxes(pos, vel, radius, height, sdt);
      grounded = grounded || r.grounded;
      hitWall = hitWall || r.hitWall;
    }
    return { grounded, hitWall };
  }

  private stepAxes(
    pos: Vec3, vel: Vec3, radius: number, height: number, dt: number,
  ): { grounded: boolean; hitWall: boolean } {
    let grounded = false;
    let hitWall = false;

    // --- X axis ---
    pos.x += vel.x * dt;
    for (const b of this.boxes) {
      if (!this.overlaps(pos, radius, height, b)) continue;
      if (vel.x > 0) pos.x = b.minX - radius;
      else if (vel.x < 0) pos.x = b.maxX + radius;
      vel.x = 0;
      hitWall = true;
    }

    // --- Z axis ---
    pos.z += vel.z * dt;
    for (const b of this.boxes) {
      if (!this.overlaps(pos, radius, height, b)) continue;
      if (vel.z > 0) pos.z = b.minZ - radius;
      else if (vel.z < 0) pos.z = b.maxZ + radius;
      vel.z = 0;
      hitWall = true;
    }

    // --- Y axis ---
    pos.y += vel.y * dt;
    for (const b of this.boxes) {
      if (!this.overlaps(pos, radius, height, b)) continue;
      if (vel.y <= 0) {
        pos.y = b.maxY;
        grounded = true;
      } else {
        pos.y = b.minY - height;
      }
      vel.y = 0;
    }

    return { grounded, hitWall };
  }

  /** Does the segment from `a` to `b` hit any solid box? (line-of-sight test) */
  segmentBlocked(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const steps = Math.ceil(len / 0.5);
    for (const box of this.boxes) {
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const px = a.x + dx * t, py = a.y + dy * t, pz = a.z + dz * t;
        if (
          px > box.minX && px < box.maxX &&
          py > box.minY && py < box.maxY &&
          pz > box.minZ && pz < box.maxZ
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private overlaps(pos: Vec3, radius: number, height: number, b: AABB): boolean {
    return (
      pos.x - radius < b.maxX &&
      pos.x + radius > b.minX &&
      pos.y < b.maxY &&
      pos.y + height > b.minY &&
      pos.z - radius < b.maxZ &&
      pos.z + radius > b.minZ
    );
  }
}
