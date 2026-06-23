import { MOVE, type GameMap } from "@drunkr/shared";

/** An enemy the game has resolved this frame: where it is + whether it's in sight. */
export interface MinimapEnemy {
  id: number;
  x: number;
  z: number;
  /** In the vision cone AND not occluded by a wall right now. */
  visible: boolean;
}

interface Blip { x: number; z: number; t: number; }

/** Distance from (ox,oz) along unit dir (dx,dz) to the first entry into an axis
 * -aligned rect, or `maxT` if it isn't hit within that range (2D slab test). */
function rayRectDist(
  ox: number, oz: number, dx: number, dz: number,
  w: { minX: number; maxX: number; minZ: number; maxZ: number }, maxT: number,
): number {
  let tmin = 0, tmax = maxT;
  if (Math.abs(dx) < 1e-9) {
    if (ox < w.minX || ox > w.maxX) return maxT;
  } else {
    let t1 = (w.minX - ox) / dx, t2 = (w.maxX - ox) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return maxT;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < w.minZ || oz > w.maxZ) return maxT;
  } else {
    let t1 = (w.minZ - oz) / dz, t2 = (w.maxZ - oz) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return maxT;
  }
  return tmin > 0 ? tmin : 0;
}

/**
 * Top-down radar centred on the local player. Map walls are drawn as a static
 * footprint; enemies only appear while they're in the player's vision cone, and
 * linger at their last-seen spot for a short memory window after they break
 * sight (so a target ducking behind cover doesn't blink out instantly).
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private radius: number;
  /** World units from centre to the rim (the zoom level). */
  private worldRadius = 60;
  /** Pixels per world unit. */
  private scale: number;
  private map: GameMap | null = null;
  /** id → last-seen position + timestamp (the 0.5 s sight memory). */
  private seen = new Map<number, Blip>();
  private memoryMs = 500;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? (document.getElementById("minimap") as HTMLCanvasElement);
    this.ctx = this.canvas.getContext("2d")!;
    this.size = this.canvas.width;
    this.radius = this.size / 2;
    this.scale = this.radius / this.worldRadius;
  }

  setMap(map: GameMap) {
    this.map = map;
    this.seen.clear();
  }

  /**
   * @param px,pz   local player position (world XZ)
   * @param py      local player feet height (to ignore other floors' geometry)
   * @param yaw     local player yaw (heading)
   * @param enemies every live enemy with its current visibility
   */
  update(px: number, py: number, pz: number, yaw: number, enemies: MinimapEnemy[], now: number) {
    // Refresh / expire the sight memory.
    for (const e of enemies) if (e.visible) this.seen.set(e.id, { x: e.x, z: e.z, t: now });
    for (const [id, b] of this.seen) if (now - b.t > this.memoryMs) this.seen.delete(id);

    const ctx = this.ctx, r = this.radius, s = this.scale, wr = this.worldRadius;
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = "#080a12";
    ctx.fillRect(0, 0, this.size, this.size);

    // Gather in-range walls once, reused for both the sight-blocking cone
    // raycast and the wall rendering below. Only keep geometry that straddles
    // the player's own body band — this both drops floor/ceiling slabs and, on
    // vertical maps, hides other floors' walls (which were cluttering the radar
    // and wrongly blocking the cone above/below the player).
    const bandLow = py + 0.5, bandHigh = py + MOVE.height;
    const walls: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
    if (this.map) {
      for (const b of this.map.boxes) {
        const hy = b.size.y / 2;
        if (b.pos.y + hy <= bandLow || b.pos.y - hy >= bandHigh) continue;
        const hw = b.size.x / 2, hd = b.size.z / 2;
        if (Math.abs(b.pos.x - px) - hw > wr || Math.abs(b.pos.z - pz) - hd > wr) continue;
        walls.push({ minX: b.pos.x - hw, maxX: b.pos.x + hw, minZ: b.pos.z - hd, maxZ: b.pos.z + hd });
      }
    }

    // Player heading on the map (forward = (-sin yaw, -cos yaw)).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const heading = Math.atan2(fz, fx);

    // Vision cone as a 2D visibility polygon: fire a fan of rays across the cone
    // and stop each at the first wall it meets, so the cone is blocked by cover.
    const half = (52 * Math.PI) / 180;
    const RAYS = 44;
    ctx.beginPath();
    ctx.moveTo(r, r);
    for (let i = 0; i <= RAYS; i++) {
      const a = heading - half + (2 * half) * (i / RAYS);
      const dx = Math.cos(a), dz = Math.sin(a);
      let dist = wr;
      for (const w of walls) {
        const t = rayRectDist(px, pz, dx, dz, w, dist);
        if (t < dist) dist = t;
      }
      ctx.lineTo(r + dx * dist * s, r + dz * dist * s);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(24,224,255,0.12)";
    ctx.fill();

    // Walls on top so their edges stay crisp over the cone tint.
    ctx.fillStyle = "#27325c";
    for (const w of walls) {
      ctx.fillRect(r + (w.minX - px) * s, r + (w.minZ - pz) * s, (w.maxX - w.minX) * s, (w.maxZ - w.minZ) * s);
    }

    // Enemy blips (anything seen within the memory window), fading as it ages.
    for (const b of this.seen.values()) {
      const dx = b.x - px, dz = b.z - pz;
      if (Math.hypot(dx, dz) > wr) continue;
      ctx.globalAlpha = Math.max(0, 1 - (now - b.t) / this.memoryMs);
      ctx.fillStyle = "#ff2d5e";
      ctx.beginPath();
      ctx.arc(r + dx * s, r + dz * s, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Player arrow at centre, pointing along the heading.
    ctx.translate(r, r);
    ctx.rotate(heading + Math.PI / 2);
    ctx.fillStyle = "#18e0ff";
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Rim.
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(24,224,255,0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
