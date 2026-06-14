import type { GameMap, MapBox } from "./map.js";
import type { Vec3 } from "./math.js";

export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function boxToAABB(b: MapBox): AABB {
  return {
    minX: b.pos.x - b.size.x / 2,
    minY: b.pos.y - b.size.y / 2,
    minZ: b.pos.z - b.size.z / 2,
    maxX: b.pos.x + b.size.x / 2,
    maxY: b.pos.y + b.size.y / 2,
    maxZ: b.pos.z + b.size.z / 2,
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

export class CollisionWorld {
  readonly boxes: AABB[];
  private pads: PadZone[];

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
