import type { CollisionWorld } from "./collision.js";
import type { Vec3 } from "./math.js";

/** Vertical band (feet→head) a standing player occupies; obstacles intersecting
 * this band block a cell. The floor (top at y≈0) and high beams are ignored. */
const BODY_LO = 0.4;
const BODY_HI = 1.7;
/** Half-width kept clear around a cell centre so the capsule (r=0.4) fits. */
const CLEARANCE = 0.6;

interface Cell {
  c: number;
  r: number;
}

const NB = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];

/**
 * A 2D navigation grid built from a map's collision boxes, with A* pathfinding
 * and line-of-sight path smoothing. Used by the server's bots to route around
 * walls instead of walking straight into them.
 *
 * It models the ground plane only: walls/crates are obstacles, overhead
 * geometry (bridges, high platforms) is ignored. Fine collision is still
 * handled by `stepMovement`, so the path only needs to be roughly correct.
 */
interface HazBox { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; }

export class NavGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private originX: number;
  private originZ: number;
  private walk: Uint8Array;
  private world: CollisionWorld;
  private haz: HazBox[];

  constructor(
    world: CollisionWorld,
    bounds: number,
    hazards: { pos: Vec3; size: Vec3 }[] = [],
    cell = 1.5,
  ) {
    this.world = world;
    this.cell = cell;
    this.haz = hazards.map((h) => ({
      minX: h.pos.x - h.size.x / 2, maxX: h.pos.x + h.size.x / 2,
      minY: h.pos.y - h.size.y / 2, maxY: h.pos.y + h.size.y / 2,
      minZ: h.pos.z - h.size.z / 2, maxZ: h.pos.z + h.size.z / 2,
    }));
    this.originX = -bounds;
    this.originZ = -bounds;
    this.cols = Math.ceil((bounds * 2) / cell) + 1;
    this.rows = Math.ceil((bounds * 2) / cell) + 1;
    this.walk = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = this.originX + c * cell;
        const z = this.originZ + r * cell;
        this.walk[r * this.cols + c] = this.clearAt(x, z) ? 1 : 0;
      }
    }
  }

  /** Is a standing capsule at this world (x,z) clear of solid geometry and not in
   *  a hazard zone? Bots treat damage zones as unwalkable so A* routes around
   *  them and idle wander never picks a spot inside one. */
  clearAt(x: number, z: number): boolean {
    for (const b of this.world.boxes) {
      if (b.maxY <= BODY_LO || b.minY >= BODY_HI) continue; // floor / overhead
      if (
        x - CLEARANCE < b.maxX && x + CLEARANCE > b.minX &&
        z - CLEARANCE < b.maxZ && z + CLEARANCE > b.minZ
      ) return false;
    }
    if (this.haz.length && !this.hazardSafe(x, z)) return false;
    return true;
  }

  /** False if a bot standing at (x,z) would be inside a hazard. Floor-aware: a
   *  solid surface above a hazard (a bridge over acid) stays safe, while a hazard
   *  at the standing surface — or a floorless pit you'd fall into — does not. */
  private hazardSafe(x: number, z: number): boolean {
    let floorTop = -Infinity;
    for (const b of this.world.boxes) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (b.maxY > floorTop) floorTop = b.maxY;
    }
    if (floorTop === -Infinity) floorTop = 0;
    const bandLo = floorTop, bandHi = floorTop + 1.8;
    for (const h of this.haz) {
      if (x < h.minX || x > h.maxX || z < h.minZ || z > h.maxZ) continue;
      if (h.maxY > bandLo && h.minY < bandHi) return false;
    }
    return true;
  }

  private cellOf(x: number, z: number): Cell {
    return {
      c: Math.round((x - this.originX) / this.cell),
      r: Math.round((z - this.originZ) / this.cell),
    };
  }
  private worldOf(c: number, r: number): Vec3 {
    return { x: this.originX + c * this.cell, y: 0, z: this.originZ + r * this.cell };
  }
  private inBounds(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }
  private walkableCell(c: number, r: number): boolean {
    return this.inBounds(c, r) && this.walk[r * this.cols + c] === 1;
  }

  /** A random walkable world point (for idle wander). */
  randomPoint(): Vec3 {
    for (let i = 0; i < 40; i++) {
      const c = Math.floor(Math.random() * this.cols);
      const r = Math.floor(Math.random() * this.rows);
      if (this.walk[r * this.cols + c]) return this.worldOf(c, r);
    }
    return { x: 0, y: 0, z: 0 };
  }

  /** Nearest walkable cell to a world point (ring search), or null. */
  private nearestWalkable(x: number, z: number): Cell | null {
    const { c, r } = this.cellOf(x, z);
    if (this.walkableCell(c, r)) return { c, r };
    for (let rad = 1; rad <= 10; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
          if (this.walkableCell(c + dc, r + dr)) return { c: c + dc, r: r + dr };
        }
      }
    }
    return null;
  }

  /** Straight-line clearance between two world points at body level. */
  private clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / (this.cell * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.clearAt(ax + dx * t, az + dz * t)) return false;
    }
    return true;
  }

  /**
   * A* from `start` to `goal`, returned as a smoothed list of world waypoints
   * (the goal is the final point). Returns null if no route exists.
   */
  findPath(start: Vec3, goal: Vec3): Vec3[] | null {
    const s = this.nearestWalkable(start.x, start.z);
    const g = this.nearestWalkable(goal.x, goal.z);
    if (!s || !g) return null;
    const startIdx = s.r * this.cols + s.c;
    const goalIdx = g.r * this.cols + g.c;
    if (startIdx === goalIdx) return [{ x: goal.x, y: 0, z: goal.z }];

    const n = this.cols * this.rows;
    const gScore = new Float64Array(n).fill(Infinity);
    const fScore = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap: number[] = [];

    gScore[startIdx] = 0;
    fScore[startIdx] = this.h(s.c, s.r, g.c, g.r);
    this.heapPush(heap, fScore, startIdx);

    let found = false;
    while (heap.length) {
      const cur = this.heapPop(heap, fScore);
      if (cur === goalIdx) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.cols;
      const cr = (cur - cc) / this.cols;
      for (let i = 0; i < 8; i++) {
        const dc = NB[i * 2], dr = NB[i * 2 + 1];
        const nc = cc + dc, nr = cr + dr;
        if (!this.walkableCell(nc, nr)) continue;
        // No corner cutting: a diagonal needs both orthogonal cells open.
        if (dc !== 0 && dr !== 0 && (!this.walkableCell(cc + dc, cr) || !this.walkableCell(cc, cr + dr))) continue;
        const nidx = nr * this.cols + nc;
        if (closed[nidx]) continue;
        const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
        const tentative = gScore[cur] + step;
        if (tentative < gScore[nidx]) {
          gScore[nidx] = tentative;
          came[nidx] = cur;
          fScore[nidx] = tentative + this.h(nc, nr, g.c, g.r);
          this.heapPush(heap, fScore, nidx);
        }
      }
    }
    if (!found) return null;

    // Reconstruct cell path.
    const cells: number[] = [];
    for (let cur = goalIdx; cur !== -1; cur = came[cur]) cells.push(cur);
    cells.reverse();
    const pts: Vec3[] = cells.map((idx) => {
      const c = idx % this.cols;
      return this.worldOf(c, (idx - c) / this.cols);
    });
    pts[pts.length - 1] = { x: goal.x, y: 0, z: goal.z };
    return this.smooth(start, pts);
  }

  /** String-pulling: drop intermediate nodes that have clear line of sight. */
  private smooth(start: Vec3, pts: Vec3[]): Vec3[] {
    const out: Vec3[] = [];
    let ax = start.x, az = start.z;
    let i = 0;
    while (i < pts.length) {
      let j = i;
      for (let k = pts.length - 1; k >= i; k--) {
        if (this.clearLine(ax, az, pts[k].x, pts[k].z)) { j = k; break; }
      }
      out.push(pts[j]);
      ax = pts[j].x; az = pts[j].z;
      i = j + 1;
    }
    return out;
  }

  /** Octile-distance heuristic. */
  private h(c: number, r: number, gc: number, gr: number): number {
    const dc = Math.abs(c - gc), dr = Math.abs(r - gr);
    return dc + dr + (Math.SQRT2 - 2) * Math.min(dc, dr);
  }

  private heapPush(heap: number[], f: Float64Array, idx: number): void {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[heap[p]] <= f[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }
  private heapPop(heap: number[], f: Float64Array): number {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      const len = heap.length;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let sm = i;
        if (l < len && f[heap[l]] < f[heap[sm]]) sm = l;
        if (r < len && f[heap[r]] < f[heap[sm]]) sm = r;
        if (sm === i) break;
        const t = heap[sm]; heap[sm] = heap[i]; heap[i] = t;
        i = sm;
      }
    }
    return top;
  }
}
