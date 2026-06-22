import type { GameMap, MapBox, MovingPlatform } from "./map.js";
import type { Vec3 } from "./math.js";

/** Tallest ledge you can walk straight up without jumping (step-up height). */
const STEP_HEIGHT = 0.55;

/** Deterministic position of a moving platform at match-clock time `ms`. It
 * patrols pos → pos+travel → pos on a triangle wave with the given period. */
export function platformPosAt(p: MovingPlatform, ms: number): Vec3 {
  const period = Math.max(0.2, p.period);
  const phase = ((ms / 1000) % period + period) % period / period; // 0..1
  const t = phase < 0.5 ? phase * 2 : 2 - phase * 2;               // 0→1→0
  return { x: p.pos.x + p.travel.x * t, y: p.pos.y + p.travel.y * t, z: p.pos.z + p.travel.z * t };
}

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

/** A box rotated about the vertical (Y) axis — collided as a true oriented box
 * so bullets pass through the empty corners and you don't bump invisible space. */
interface OBBY {
  cx: number; cy: number; cz: number; // center
  hx: number; hy: number; hz: number; // half-extents (local)
  cos: number; sin: number;           // cos/sin of the yaw
}

/** A non-box primitive (cylinder / sphere / wedge), collided to match its shape
 * rather than its enclosing box. Cylinders/spheres ignore yaw (symmetric in XZ);
 * wedges use it to orient the slope. X/Z tilt still falls back to an AABB. */
interface ShapeCollider {
  kind: "cylinder" | "sphere" | "wedge";
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
  cos: number; sin: number;
}

export class CollisionWorld {
  readonly boxes: AABB[];
  /** Y-rotated boxes, collided as oriented boxes (not their enclosing AABB). */
  readonly obbs: OBBY[];
  /** Cylinders / spheres / wedges, collided to their actual silhouette. */
  readonly shapes: ShapeCollider[];
  private pads: PadZone[];
  private ramps: RampZone[];
  /** Moving platforms + their current-frame AABBs (recomputed each move()). */
  private platforms: MovingPlatform[];
  private dynBoxes: AABB[] = [];
  /** Static boxes + current dynamic platform boxes — what movement collides against. */
  private collBoxes: AABB[];
  /** Hazard volumes (damage zones). */
  private hazards: { aabb: AABB; dps: number }[];
  /** Match-clock time (ms) used to position moving platforms. */
  private time = 0;

  constructor(map: GameMap) {
    this.boxes = [];
    this.obbs = [];
    this.shapes = [];
    for (const b of map.boxes) {
      const r = b.rot;
      const tilted = !!r && (Math.abs(r.x) > 1e-4 || Math.abs(r.z) > 1e-4);
      // Non-box primitives get shape-accurate collision (unless X/Z-tilted, which
      // falls back to the enclosing AABB as before).
      if (b.shape && b.shape !== "box" && !tilted) {
        const yaw = r ? r.y : 0;
        this.shapes.push({
          kind: b.shape as ShapeCollider["kind"],
          cx: b.pos.x, cy: b.pos.y, cz: b.pos.z,
          hx: b.size.x / 2, hy: b.size.y / 2, hz: b.size.z / 2,
          cos: Math.cos(yaw), sin: Math.sin(yaw),
        });
        continue;
      }
      // Pure Y rotation → oriented box. No rotation (or X/Z rotation) → AABB
      // (X/Z tilt still falls back to the enclosing AABB, as before).
      if (r && Math.abs(r.x) < 1e-4 && Math.abs(r.z) < 1e-4 && Math.abs(r.y) > 1e-4) {
        this.obbs.push({
          cx: b.pos.x, cy: b.pos.y, cz: b.pos.z,
          hx: b.size.x / 2, hy: b.size.y / 2, hz: b.size.z / 2,
          cos: Math.cos(r.y), sin: Math.sin(r.y),
        });
      } else {
        this.boxes.push(boxToAABB(b));
      }
    }
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
    this.platforms = (map.platforms ?? []).slice();
    this.hazards = (map.hazards ?? []).map((h) => ({
      aabb: {
        minX: h.pos.x - h.size.x / 2, minY: h.pos.y - h.size.y / 2, minZ: h.pos.z - h.size.z / 2,
        maxX: h.pos.x + h.size.x / 2, maxY: h.pos.y + h.size.y / 2, maxZ: h.pos.z + h.size.z / 2,
      },
      dps: h.dps,
    }));
    this.collBoxes = this.boxes;
  }

  /** Set the synced match-clock time (ms) used to position moving platforms. */
  setTime(ms: number) { this.time = ms; }

  /** Recompute the current-frame AABB for each moving platform. */
  private updateDynBoxes() {
    if (!this.platforms.length) { this.collBoxes = this.boxes; return; }
    this.dynBoxes = this.platforms.map((p) => {
      const c = platformPosAt(p, this.time);
      const hx = p.size.x / 2, hy = p.size.y / 2, hz = p.size.z / 2;
      return { minX: c.x - hx, minY: c.y - hy, minZ: c.z - hz, maxX: c.x + hx, maxY: c.y + hy, maxZ: c.z + hz };
    });
    this.collBoxes = this.boxes.concat(this.dynBoxes);
  }

  /** Total damage-per-second of every hazard zone the player capsule overlaps. */
  hazardDps(pos: Vec3, radius: number, height: number): number {
    let dps = 0;
    for (const h of this.hazards) if (this.overlaps(pos, radius, height, h.aabb)) dps += h.dps;
    return dps;
  }

  /** Surface height of a ramp under `pos`, or null if not over any ramp. When
   * several ramps overlap (e.g. a staircase of ramps, or footprints widened by
   * the edge margin), return the highest surface so seams don't snap you down. */
  rampGround(pos: Vec3): number | null {
    const m = 0.25; // margin prevents gap-glitches at ramp edge transitions
    let best: number | null = null;
    for (const r of this.ramps) {
      if (pos.x < r.minX - m || pos.x > r.maxX + m || pos.z < r.minZ - m || pos.z > r.maxZ + m) continue;
      let t: number; // 0 at low edge, 1 at high edge
      if (r.dir === 0) t = (pos.x - r.minX) / (r.maxX - r.minX);
      else if (r.dir === 1) t = (r.maxX - pos.x) / (r.maxX - r.minX);
      else if (r.dir === 2) t = (pos.z - r.minZ) / (r.maxZ - r.minZ);
      else t = (r.maxZ - pos.z) / (r.maxZ - r.minZ);
      const y = r.baseY + r.height * (t < 0 ? 0 : t > 1 ? 1 : t);
      if (best === null || y > best) best = y;
    }
    return best;
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
    stepHeight: number = STEP_HEIGHT,
  ): { grounded: boolean; hitWall: boolean } {
    // Position moving platforms for this frame, then collide against them too.
    this.updateDynBoxes();
    // Sub-step so high speed (bhop, dash, jump pads, blink) can't tunnel
    // through walls or the floor in a single frame.
    const maxDisp = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(maxDisp / (radius * 0.75))));
    const sdt = dt / steps;
    let grounded = false;
    let hitWall = false;
    for (let s = 0; s < steps; s++) {
      const r = this.stepAxes(pos, vel, radius, height, sdt, stepHeight);
      grounded = grounded || r.grounded;
      hitWall = hitWall || r.hitWall;
    }
    return { grounded, hitWall };
  }

  private stepAxes(
    pos: Vec3, vel: Vec3, radius: number, height: number, dt: number, stepHeight: number,
  ): { grounded: boolean; hitWall: boolean } {
    let grounded = false;
    let hitWall = false;

    // Pre-move snapshot + original horizontal intent (used for the step-up retry).
    const sx = pos.x, sy = pos.y, sz = pos.z;
    const ovx = vel.x, ovz = vel.z;
    const movedHoriz = (ovx * ovx + ovz * ovz) > 1e-8;

    // --- Horizontal resolution (X then Z) ---
    hitWall = this.moveAxisX(pos, vel, radius, height, dt);
    hitWall = this.moveAxisZ(pos, vel, radius, height, dt) || hitWall;

    // --- Step-up ---
    // If a wall stopped us while we were walking (not jumping up), retry the
    // same horizontal move lifted by one step height. If that clears the
    // obstacle, settle onto the step's top surface. This removes the "invisible
    // wall" at the top of ramps / platform seams and lets you walk up low
    // ledges smoothly instead of being stopped dead or snapped on top.
    if (hitWall && movedHoriz && vel.y <= 0.1) {
      const fx = pos.x, fz = pos.z, fvx = vel.x, fvz = vel.z;
      const flatProgress = (fx - sx) * (fx - sx) + (fz - sz) * (fz - sz);

      pos.x = sx; pos.y = sy + stepHeight; pos.z = sz;
      vel.x = ovx; vel.z = ovz;
      this.moveAxisX(pos, vel, radius, height, dt);
      this.moveAxisZ(pos, vel, radius, height, dt);
      const stepProgress = (pos.x - sx) * (pos.x - sx) + (pos.z - sz) * (pos.z - sz);

      if (stepProgress > flatProgress + 1e-4 && !this.overlapsAny(pos, radius, height)) {
        // We cleared the obstacle up high — drop onto the step's top surface.
        let groundY = sy, found = false;
        for (const b of this.collBoxes) {
          if (
            pos.x - radius < b.maxX && pos.x + radius > b.minX &&
            pos.z - radius < b.maxZ && pos.z + radius > b.minZ &&
            b.maxY <= sy + stepHeight + 1e-3 && b.maxY >= sy - 1e-3 &&
            (!found || b.maxY > groundY)
          ) { groundY = b.maxY; found = true; }
        }
        if (found) { pos.y = groundY; grounded = true; } else pos.y = sy;
        hitWall = false; // we climbed it rather than bonking into it
      } else {
        // The lift didn't help (a real wall) — keep the blocked result.
        pos.x = fx; pos.y = sy; pos.z = fz; vel.x = fvx; vel.z = fvz;
      }
    }

    // --- Y axis ---
    pos.y += vel.y * dt;
    for (const b of this.collBoxes) {
      if (!this.overlaps(pos, radius, height, b)) continue;
      if (vel.y <= 0) {
        pos.y = b.maxY;
        grounded = true;
      } else {
        pos.y = b.minY - height;
      }
      vel.y = 0;
    }

    // --- Oriented (Y-rotated) boxes ---
    for (const o of this.obbs) {
      const r = this.resolveOBB(pos, vel, radius, height, o, stepHeight);
      grounded = grounded || r.grounded;
      hitWall = hitWall || r.hitWall;
    }

    // --- Shape primitives (cylinder / sphere / wedge) ---
    for (const sc of this.shapes) {
      const r = sc.kind === "cylinder" ? this.resolveCylinder(pos, vel, radius, height, sc, stepHeight)
        : sc.kind === "sphere" ? this.resolveSphere(pos, vel, radius, height, sc)
          : this.resolveWedge(pos, vel, radius, height, sc, stepHeight);
      grounded = grounded || r.grounded;
      hitWall = hitWall || r.hitWall;
    }

    return { grounded, hitWall };
  }

  /** Player capsule vs an upright (elliptical→circular) cylinder. */
  private resolveCylinder(
    pos: Vec3, vel: Vec3, radius: number, height: number, sc: ShapeCollider, step: number,
  ): { grounded: boolean; hitWall: boolean } {
    const feet = pos.y, head = pos.y + height;
    if (head <= sc.cy - sc.hy || feet >= sc.cy + sc.hy) return { grounded: false, hitWall: false };
    const rc = (sc.hx + sc.hz) / 2; // circular approximation of the XZ ellipse
    const dx = pos.x - sc.cx, dz = pos.z - sc.cz;
    const d = Math.hypot(dx, dz);
    const horizPen = rc + radius - d;
    if (horizPen <= 0) return { grounded: false, hitWall: false };

    const penUp = sc.cy + sc.hy - feet;
    const penDown = head - (sc.cy - sc.hy);
    const canStep = penUp <= step && vel.y <= 0.5;
    if (canStep && penUp <= horizPen && penUp <= penDown) {
      pos.y = sc.cy + sc.hy;
      if (vel.y < 0) vel.y = 0;
      return { grounded: true, hitWall: false };
    }
    if (penDown <= horizPen) {
      pos.y = sc.cy - sc.hy - height;
      if (vel.y > 0) vel.y = 0;
      return { grounded: false, hitWall: false };
    }
    const nx = d < 1e-6 ? 1 : dx / d, nz = d < 1e-6 ? 0 : dz / d;
    pos.x += nx * horizPen;
    pos.z += nz * horizPen;
    const vn = vel.x * nx + vel.z * nz;
    if (vn < 0) { vel.x -= vn * nx; vel.z -= vn * nz; }
    return { grounded: false, hitWall: true };
  }

  /** Player capsule vs a sphere (ellipsoid approximated by its mean radius):
   *  push out along the line from the sphere centre to the nearest point on the
   *  player's vertical axis, so you can round it off and stand on its top. */
  private resolveSphere(
    pos: Vec3, vel: Vec3, radius: number, height: number, sc: ShapeCollider,
  ): { grounded: boolean; hitWall: boolean } {
    const R = (sc.hx + sc.hy + sc.hz) / 3;
    const feet = pos.y, head = pos.y + height;
    const qy = Math.max(feet, Math.min(head, sc.cy)); // closest axis point in Y
    const dx = pos.x - sc.cx, dy = qy - sc.cy, dz = pos.z - sc.cz;
    const d = Math.hypot(dx, dy, dz);
    const pen = R + radius - d;
    if (pen <= 0) return { grounded: false, hitWall: false };
    const nx = d < 1e-6 ? 0 : dx / d;
    const ny = d < 1e-6 ? 1 : dy / d;
    const nz = d < 1e-6 ? 0 : dz / d;
    pos.x += nx * pen;
    pos.y += ny * pen;
    pos.z += nz * pen;
    const vn = vel.x * nx + vel.y * ny + vel.z * nz;
    if (vn < 0) { vel.x -= vn * nx; vel.y -= vn * ny; vel.z -= vn * nz; }
    const grounded = ny > 0.5;
    if (grounded && vel.y < 0) vel.y = 0;
    return { grounded, hitWall: Math.abs(ny) < 0.5 };
  }

  /** Player capsule vs a wedge (right-triangular prism). The hypotenuse is a
   *  walkable slope rising toward local -x; the other faces act as walls. */
  private resolveWedge(
    pos: Vec3, vel: Vec3, radius: number, height: number, sc: ShapeCollider, step: number,
  ): { grounded: boolean; hitWall: boolean } {
    const feet = pos.y, head = pos.y + height;
    if (head <= sc.cy - sc.hy || feet >= sc.cy + sc.hy) return { grounded: false, hitWall: false };

    // World → local XZ (same convention as resolveOBB).
    const rx = pos.x - sc.cx, rz = pos.z - sc.cz;
    const lx = rx * sc.cos - rz * sc.sin;
    const lz = rx * sc.sin + rz * sc.cos;

    const clx = lx < -sc.hx ? -sc.hx : lx > sc.hx ? sc.hx : lx;
    const clz = lz < -sc.hz ? -sc.hz : lz > sc.hz ? sc.hz : lz;
    const ddx = lx - clx, ddz = lz - clz;
    const distSq = ddx * ddx + ddz * ddz;
    const inside = distSq < 1e-8;
    if (!inside && distSq >= radius * radius) return { grounded: false, hitWall: false };

    // Slope surface height at the player's x: full height at local -x, zero at +x.
    const surfY = sc.cy - sc.hy * (clx / sc.hx);
    if (feet > surfY + 0.05) return { grounded: false, hitWall: false }; // above the slope

    const penUp = surfY - feet;
    const penDown = head - (sc.cy - sc.hy);

    let nlx: number, nlz: number, horizPen: number;
    if (inside) {
      const dxp = sc.hx - lx, dxn = lx + sc.hx, dzp = sc.hz - lz, dzn = lz + sc.hz;
      const m = Math.min(dxp, dxn, dzp, dzn);
      if (m === dxp) { nlx = 1; nlz = 0; horizPen = dxp + radius; }
      else if (m === dxn) { nlx = -1; nlz = 0; horizPen = dxn + radius; }
      else if (m === dzp) { nlx = 0; nlz = 1; horizPen = dzp + radius; }
      else { nlx = 0; nlz = -1; horizPen = dzn + radius; }
    } else {
      const dist = Math.sqrt(distSq);
      nlx = ddx / dist; nlz = ddz / dist;
      horizPen = radius - dist;
    }

    const canStep = penUp <= step && penUp >= -0.06 && vel.y <= 0.5;
    if (canStep && penUp <= horizPen && penUp <= penDown) {
      pos.y = surfY;
      if (vel.y < 0) vel.y = 0;
      return { grounded: true, hitWall: false };
    }
    if (penDown <= horizPen && penDown >= 0) {
      pos.y = sc.cy - sc.hy - height;
      if (vel.y > 0) vel.y = 0;
      return { grounded: false, hitWall: false };
    }
    const wx = nlx * sc.cos + nlz * sc.sin;
    const wz = -nlx * sc.sin + nlz * sc.cos;
    pos.x += wx * horizPen;
    pos.z += wz * horizPen;
    const vn = vel.x * wx + vel.z * wz;
    if (vn < 0) { vel.x -= vn * wx; vel.z -= vn * wz; }
    return { grounded: false, hitWall: true };
  }

  /** Move along X and resolve box overlaps. Returns true if a wall was hit.
   * Pushes out toward the nearer face even when `vel.x` is ~0 so the capsule
   * can never stay embedded (an embedding is what used to get snapped onto a
   * box top by the Y axis, teleporting/launching the player). */
  private moveAxisX(pos: Vec3, vel: Vec3, radius: number, height: number, dt: number): boolean {
    pos.x += vel.x * dt;
    let hit = false;
    for (const b of this.collBoxes) {
      if (!this.overlaps(pos, radius, height, b)) continue;
      if (vel.x > 0) pos.x = b.minX - radius;
      else if (vel.x < 0) pos.x = b.maxX + radius;
      else pos.x = (pos.x - b.minX < b.maxX - pos.x) ? b.minX - radius : b.maxX + radius;
      vel.x = 0;
      hit = true;
    }
    return hit;
  }

  /** Move along Z and resolve box overlaps (see {@link moveAxisX}). */
  private moveAxisZ(pos: Vec3, vel: Vec3, radius: number, height: number, dt: number): boolean {
    pos.z += vel.z * dt;
    let hit = false;
    for (const b of this.collBoxes) {
      if (!this.overlaps(pos, radius, height, b)) continue;
      if (vel.z > 0) pos.z = b.minZ - radius;
      else if (vel.z < 0) pos.z = b.maxZ + radius;
      else pos.z = (pos.z - b.minZ < b.maxZ - pos.z) ? b.minZ - radius : b.maxZ + radius;
      vel.z = 0;
      hit = true;
    }
    return hit;
  }

  private overlapsAny(pos: Vec3, radius: number, height: number): boolean {
    for (const b of this.collBoxes) if (this.overlaps(pos, radius, height, b)) return true;
    for (const sc of this.shapes) if (this.overlapsShape(pos, radius, height, sc)) return true;
    return false;
  }

  /** Cheap solid test of the player capsule against a shape (for step-up clearance). */
  private overlapsShape(pos: Vec3, radius: number, height: number, sc: ShapeCollider): boolean {
    const feet = pos.y, head = pos.y + height;
    if (head <= sc.cy - sc.hy || feet >= sc.cy + sc.hy) return false;
    if (sc.kind === "sphere") {
      const R = (sc.hx + sc.hy + sc.hz) / 3;
      const qy = Math.max(feet, Math.min(head, sc.cy));
      return Math.hypot(pos.x - sc.cx, qy - sc.cy, pos.z - sc.cz) < R + radius;
    }
    const rx = pos.x - sc.cx, rz = pos.z - sc.cz;
    const lx = rx * sc.cos - rz * sc.sin;
    const lz = rx * sc.sin + rz * sc.cos;
    if (sc.kind === "cylinder") {
      const rc = (sc.hx + sc.hz) / 2;
      return Math.hypot(rx, rz) < rc + radius;
    }
    // wedge: inside the XZ footprint (expanded) and below the slope surface.
    if (lx < -sc.hx - radius || lx > sc.hx + radius || lz < -sc.hz - radius || lz > sc.hz + radius) return false;
    const clx = lx < -sc.hx ? -sc.hx : lx > sc.hx ? sc.hx : lx;
    return feet <= sc.cy - sc.hy * (clx / sc.hx) + 0.05;
  }

  /**
   * Push the player capsule out of a Y-rotated box. The player is treated as a
   * vertical cylinder (radius in XZ, `height` in Y), which stays a circle under
   * rotation, so we resolve in the box's local frame and pick the shallowest
   * penetration axis (up / down / horizontal-along-face).
   */
  private resolveOBB(
    pos: Vec3, vel: Vec3, radius: number, height: number, o: OBBY, step: number,
  ): { grounded: boolean; hitWall: boolean } {
    const feet = pos.y, head = pos.y + height;
    if (head <= o.cy - o.hy || feet >= o.cy + o.hy) return { grounded: false, hitWall: false };

    // World → local XZ. Must match the renderer, which orients the box with
    // THREE.makeRotationY(yaw): local→world is (c·lx + s·lz, -s·lx + c·lz), so
    // the inverse (world→local) is (c·rx − s·rz, s·rx + c·rz).
    const rx = pos.x - o.cx, rz = pos.z - o.cz;
    const lx = rx * o.cos - rz * o.sin;
    const lz = rx * o.sin + rz * o.cos;

    const clx = lx < -o.hx ? -o.hx : lx > o.hx ? o.hx : lx;
    const clz = lz < -o.hz ? -o.hz : lz > o.hz ? o.hz : lz;
    const ddx = lx - clx, ddz = lz - clz;
    const distSq = ddx * ddx + ddz * ddz;
    const inside = distSq < 1e-8;
    if (!inside && distSq >= radius * radius) return { grounded: false, hitWall: false };

    const penUp = (o.cy + o.hy) - feet;   // raise feet onto the top
    const penDown = head - (o.cy - o.hy); // drop head below the bottom

    // Horizontal push-out direction + depth in local space.
    let nlx: number, nlz: number, horizPen: number;
    if (inside) {
      const dxp = o.hx - lx, dxn = lx + o.hx, dzp = o.hz - lz, dzn = lz + o.hz;
      const m = Math.min(dxp, dxn, dzp, dzn);
      if (m === dxp) { nlx = 1; nlz = 0; horizPen = dxp + radius; }
      else if (m === dxn) { nlx = -1; nlz = 0; horizPen = dxn + radius; }
      else if (m === dzp) { nlx = 0; nlz = 1; horizPen = dzp + radius; }
      else { nlx = 0; nlz = -1; horizPen = dzn + radius; }
    } else {
      const dist = Math.sqrt(distSq);
      nlx = ddx / dist; nlz = ddz / dist;
      horizPen = radius - dist;
    }

    // Resolve along the shallowest axis. "Up" (stepping onto the top) is only a
    // candidate for small steps and when not jumping up, so grazing a tall
    // angled wall pushes you out sideways instead of teleporting you on top.
    const canStep = penUp <= step && vel.y <= 0.5;
    if (canStep && penUp <= horizPen && penUp <= penDown) {
      pos.y = o.cy + o.hy;
      if (vel.y < 0) vel.y = 0;
      return { grounded: true, hitWall: false };
    }
    if (penDown <= horizPen) {
      pos.y = o.cy - o.hy - height;
      if (vel.y > 0) vel.y = 0;
      return { grounded: false, hitWall: false };
    }
    // Local push direction → world (renderer's local→world orientation).
    const wx = nlx * o.cos + nlz * o.sin;
    const wz = -nlx * o.sin + nlz * o.cos;
    pos.x += wx * horizPen;
    pos.z += wz * horizPen;
    const vn = vel.x * wx + vel.z * wz;
    if (vn < 0) { vel.x -= vn * wx; vel.z -= vn * wz; }
    return { grounded: false, hitWall: true };
  }

  /** Does the segment from `a` to `b` hit any solid box? (line-of-sight test) */
  segmentBlocked(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    this.updateDynBoxes(); // platforms block sightlines at their current position
    const steps = Math.ceil(len / 0.5);
    for (const box of this.collBoxes) {
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
    // Y-rotated boxes: test each sample point inside the oriented box (so the
    // empty corners of the enclosing AABB no longer block shots / sightlines).
    for (const o of this.obbs) {
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const py = a.y + dy * t;
        if (py <= o.cy - o.hy || py >= o.cy + o.hy) continue;
        const rx = (a.x + dx * t) - o.cx, rz = (a.z + dz * t) - o.cz;
        const lx = rx * o.cos - rz * o.sin;
        const lz = rx * o.sin + rz * o.cos;
        if (lx > -o.hx && lx < o.hx && lz > -o.hz && lz < o.hz) return true;
      }
    }
    // Shape primitives: sample points against the actual silhouette.
    for (const sc of this.shapes) {
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const px = a.x + dx * t, py = a.y + dy * t, pz = a.z + dz * t;
        if (py <= sc.cy - sc.hy || py >= sc.cy + sc.hy) {
          if (sc.kind !== "sphere") continue;
        }
        if (sc.kind === "sphere") {
          const R = (sc.hx + sc.hy + sc.hz) / 3;
          if (Math.hypot(px - sc.cx, py - sc.cy, pz - sc.cz) < R) return true;
          continue;
        }
        const rx = px - sc.cx, rz = pz - sc.cz;
        const lx = rx * sc.cos - rz * sc.sin;
        const lz = rx * sc.sin + rz * sc.cos;
        if (sc.kind === "cylinder") {
          const rc = (sc.hx + sc.hz) / 2;
          if (Math.hypot(rx, rz) < rc) return true;
        } else { // wedge
          if (lx > -sc.hx && lx < sc.hx && lz > -sc.hz && lz < sc.hz &&
              py - sc.cy < -sc.hy * (lx / sc.hx)) return true;
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
