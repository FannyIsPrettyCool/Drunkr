import type { Vec3 } from "./math.js";

/**
 * Visual primitive for a {@link MapBox}. Collision matches the silhouette:
 * cylinders/spheres collide round, wedges as a sloped prism (see CollisionWorld).
 * X/Z-tilted shapes still fall back to the enclosing AABB.
 */
export type BoxShape = "box" | "cylinder" | "sphere" | "wedge";
export const BOX_SHAPES: readonly BoxShape[] = ["box", "cylinder", "sphere", "wedge"];

/** A box used for both rendering and collision. */
export interface MapBox {
  /** Center position. */
  pos: Vec3;
  /** Full size (width, height, depth). */
  size: Vec3;
  /** Hex color for the surface. */
  color: number;
  /** Optional neon emissive accent color. */
  emissive?: number;
  /** Optional Euler rotation (radians). Collision uses an enclosing AABB. */
  rot?: Vec3;
  /** Optional texture key (see TEXTURE_KEYS). "none" forces a flat color. */
  texture?: string;
  /** Optional visual primitive (default "box"). Collision stays AABB. */
  shape?: BoxShape;
}

/** An angled launch pad: standing on it sets your velocity to `launch`. */
export interface JumpPad {
  pos: Vec3;
  size: Vec3;
  /** Velocity (m/s) imparted when you step on it. */
  launch: Vec3;
  color: number;
  /** Optional Euler rotation (radians) — visual only. */
  rot?: Vec3;
}

/**
 * A walkable ramp. `pos` is the footprint center with `pos.y` the low-edge
 * surface height; `size` is the footprint (x, z) plus the rise height (y).
 * `dir` picks the high side: 0=+x, 1=-x, 2=+z, 3=-z.
 */
export interface Ramp {
  pos: Vec3;
  size: Vec3;
  dir: number;
  color: number;
  emissive?: number;
  texture?: string;
}

/** A coloured point light placed in the arena (purely visual). */
export interface MapLight {
  pos: Vec3;
  color: number;
  /** Light intensity (0..~5). */
  intensity: number;
  /** Falloff distance. */
  range: number;
}

/** A decorative particle emitter (client-side ambiance, no gameplay effect). */
export interface MapEmitter {
  pos: Vec3;
  color: number;
  /** Particles spawned per second. */
  rate: number;
  /** Emission velocity (direction + speed). */
  dir: Vec3;
}

/** A volume that damages players standing inside it. */
export interface HazardZone {
  pos: Vec3;
  size: Vec3;
  color: number;
  /** Damage per second applied to a player overlapping the box. */
  dps: number;
}

/**
 * A solid platform that patrols between `pos` and `pos + travel`, completing one
 * full there-and-back cycle every `period` seconds. Position is a deterministic
 * function of the synced match clock so client and server agree.
 */
export interface MovingPlatform {
  pos: Vec3;
  size: Vec3;
  color: number;
  /** Offset (added to pos) of the far end of the patrol. */
  travel: Vec3;
  /** Seconds for one full there-and-back cycle. */
  period: number;
  emissive?: number;
  texture?: string;
}

/** A bomb plant zone. */
export interface BombSite {
  id: "A" | "B";
  pos: Vec3;
  radius: number;
}

export interface GameMap {
  name: string;
  /** Half-extent of the playable floor on X/Z (square arena). */
  bounds: number;
  spawns: Vec3[];
  boxes: MapBox[];
  pads?: JumpPad[];
  ramps?: Ramp[];
  lights?: MapLight[];
  emitters?: MapEmitter[];
  hazards?: HazardZone[];
  platforms?: MovingPlatform[];
  /** CT-team spawn positions (bomb defusal mode). */
  spawnsCT?: Vec3[];
  /** Bomb plant zones (bomb defusal mode). */
  bombSites?: BombSite[];
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const PINK = 0xff2d9b;
const CYAN = 0x18e0ff;
const GREEN = 0x39ff8b;
const AMBER = 0xffb23d;

// Hazard / environmental accents (used by Mangrove + Aurora Fields).
const ACID = 0x8cff2e;   // glowing acid river
const TOXIC = 0x57e06a;  // drifting toxic gas
const VENOM = 0xff3b3b;  // danger red (maps to the walls_red texture)
const PLASMA = 0xc23bff;  // aurora plasma pool

const DARK = 0x12131c;
const SLATE = 0x1b1d2b;
const SLATE2 = 0x232639;
const SLATE3 = 0x2a2e45;

/** Perimeter floor + four neon walls for a square arena of half-extent `b`. */
function shell(b: number, h = 8): MapBox[] {
  const t = 1;
  const span = b * 2;
  return [
    { pos: v(0, -0.5, 0), size: v(span, 1, span), color: DARK },
    { pos: v(0, h / 2, -b), size: v(span, h, t), color: SLATE, emissive: PINK },
    { pos: v(0, h / 2, b), size: v(span, h, t), color: SLATE, emissive: PINK },
    { pos: v(-b, h / 2, 0), size: v(t, h, span), color: SLATE, emissive: CYAN },
    { pos: v(b, h / 2, 0), size: v(t, h, span), color: SLATE, emissive: CYAN },
  ];
}

/** Axis-aligned wall from (x1,z1) to (x2,z2). One of the axes must be equal. */
function wall(
  x1: number, z1: number, x2: number, z2: number,
  color = SLATE2, emissive?: number, h = 7,
): MapBox {
  const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
  const sx = Math.abs(x2 - x1) || 1;
  const sz = Math.abs(z2 - z1) || 1;
  return { pos: v(cx, h / 2, cz), size: v(sx, h, sz), color, emissive };
}

/**
 * "Neon Yard" — the flagship arena. A large symmetric box-map: a tall central
 * tower on a stepped plaza, flanking cover lanes, corner sniper towers with
 * ramps, and scattered crates. Cyberpunk palette of dark slate + neon edges.
 */
export const NEON_YARD: GameMap = {
  name: "Neon Yard",
  bounds: 56,
  spawns: [
    v(-48, 0, -48), v(48, 0, 48), v(-48, 0, 48), v(48, 0, -48),
    v(0, 0, -50), v(0, 0, 50), v(-50, 0, 0), v(50, 0, 0),
    v(-26, 0, -26), v(26, 0, 26), v(-26, 0, 26), v(26, 0, -26),
    v(0, 0, -22), v(0, 0, 22), v(-22, 0, 0), v(22, 0, 0),
  ],
  boxes: [
    ...shell(56, 10),

    // Central stepped plaza + tower (a strong mid landmark).
    { pos: v(0, 0.5, 0), size: v(22, 1, 22), color: SLATE2, emissive: CYAN },
    { pos: v(0, 1.5, 0), size: v(13, 1, 13), color: SLATE2, emissive: PINK },
    { pos: v(0, 5.5, 0), size: v(4, 11, 4), color: SLATE3, emissive: CYAN },
    { pos: v(0, 11.2, 0), size: v(7, 0.4, 7), color: SLATE3, emissive: PINK },
    // Walls around the plaza break long sightlines (with gaps).
    wall(-11, -7, -11, 7, SLATE2, CYAN, 3.5),
    wall(11, -7, 11, 7, SLATE2, CYAN, 3.5),
    wall(-7, 11, 7, 11, SLATE2, PINK, 3.5),
    wall(-7, -11, 7, -11, SLATE2, PINK, 3.5),

    // Ramps up onto the plaza.
    { pos: v(0, 0.5, 14), size: v(6, 1, 6), color: SLATE2, emissive: PINK },
    { pos: v(0, 0.5, -14), size: v(6, 1, 6), color: SLATE2, emissive: PINK },
    { pos: v(14, 0.5, 0), size: v(6, 1, 6), color: SLATE2, emissive: PINK },
    { pos: v(-14, 0.5, 0), size: v(6, 1, 6), color: SLATE2, emissive: PINK },

    // Mid-ring buildings (cover, climbable, block sightlines).
    { pos: v(-26, 2.5, -8), size: v(8, 5, 8), color: SLATE2, emissive: GREEN },
    { pos: v(26, 2.5, 8), size: v(8, 5, 8), color: SLATE2, emissive: GREEN },
    { pos: v(-8, 2.5, 26), size: v(8, 5, 8), color: SLATE2, emissive: AMBER },
    { pos: v(8, 2.5, -26), size: v(8, 5, 8), color: SLATE2, emissive: AMBER },
    { pos: v(-28, 1.5, 20), size: v(6, 3, 6), color: SLATE3, emissive: CYAN },
    { pos: v(28, 1.5, -20), size: v(6, 3, 6), color: SLATE3, emissive: CYAN },

    // Flank cover lanes (symmetric crates).
    { pos: v(-20, 1.25, -22), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(20, 1.25, 22), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(-22, 1.5, 4), size: v(2, 3, 8), color: SLATE2, emissive: GREEN },
    { pos: v(22, 1.5, -4), size: v(2, 3, 8), color: SLATE2, emissive: GREEN },

    // Corner sniper towers with access ramps.
    { pos: v(-44, 3, -44), size: v(12, 6, 12), color: SLATE2, emissive: AMBER },
    { pos: v(44, 3, 44), size: v(12, 6, 12), color: SLATE2, emissive: AMBER },
    { pos: v(44, 3, -44), size: v(12, 6, 12), color: SLATE2, emissive: PINK },
    { pos: v(-44, 3, 44), size: v(12, 6, 12), color: SLATE2, emissive: PINK },
    { pos: v(-38, 1, -34), size: v(6, 2, 4), color: SLATE2, emissive: AMBER },
    { pos: v(38, 1, 34), size: v(6, 2, 4), color: SLATE2, emissive: AMBER },
    { pos: v(38, 1, -34), size: v(6, 2, 4), color: SLATE2, emissive: PINK },
    { pos: v(-38, 1, 34), size: v(6, 2, 4), color: SLATE2, emissive: PINK },

    // Outer perimeter cover so spawns aren't fully exposed.
    { pos: v(-40, 1.5, 4), size: v(2, 3, 10), color: SLATE3, emissive: GREEN },
    { pos: v(40, 1.5, -4), size: v(2, 3, 10), color: SLATE3, emissive: GREEN },
    { pos: v(4, 1.5, 40), size: v(10, 3, 2), color: SLATE3, emissive: GREEN },
    { pos: v(-4, 1.5, -40), size: v(10, 3, 2), color: SLATE3, emissive: GREEN },
  ],
  // Walkable ramps up onto a corner tower and a mid-ring building.
  ramps: [
    ramp(-32, -44, 12, 8, 0, 6, 1, AMBER), // onto the NW corner tower (rises -x)
    ramp(-36, -8, 12, 6, 0, 5, 0, GREEN), // onto the NW mid building (rises +x)
  ],
  // Flat floor jump pads at the mid-edges, launching up and toward the center.
  pads: [
    { pos: v(-36, 0.1, 18), size: v(5, 0.2, 5), launch: v(11, 15, -7), color: CYAN },
    { pos: v(36, 0.1, -18), size: v(5, 0.2, 5), launch: v(-11, 15, 7), color: CYAN },
    { pos: v(18, 0.1, 36), size: v(5, 0.2, 5), launch: v(-7, 15, -11), color: PINK },
    { pos: v(-18, 0.1, -36), size: v(5, 0.2, 5), launch: v(7, 15, 11), color: PINK },
  ],
};

/**
 * "Overdrive" — a faster, more open map built around two raised bases at
 * opposite ends connected by a central lane with low cover, encouraging
 * long sightlines and bhop rushes down the middle.
 */
export const OVERDRIVE: GameMap = {
  name: "Overdrive",
  bounds: 40,
  spawns: [
    v(-34, 0, 0), v(34, 0, 0), v(-30, 0, -22), v(30, 0, 22),
    v(-30, 0, 22), v(30, 0, -22), v(0, 0, -34), v(0, 0, 34),
    v(-16, 0, 16), v(16, 0, -16), v(-16, 0, -16), v(16, 0, 16),
  ],
  boxes: [
    ...shell(40, 8),

    // Two raised bases (north/south ends on the X axis).
    { pos: v(-32, 1.5, 0), size: v(14, 3, 24), color: SLATE2, emissive: CYAN },
    { pos: v(32, 1.5, 0), size: v(14, 3, 24), color: SLATE2, emissive: PINK },
    // Base ramps toward center.
    { pos: v(-22, 0.75, 0), size: v(8, 1.5, 10), color: SLATE2, emissive: CYAN },
    { pos: v(22, 0.75, 0), size: v(8, 1.5, 10), color: SLATE2, emissive: PINK },
    // Base back walls (cover).
    { pos: v(-38, 3, 0), size: v(2, 6, 24), color: SLATE3, emissive: CYAN },
    { pos: v(38, 3, 0), size: v(2, 6, 24), color: SLATE3, emissive: PINK },

    // Central pillar cluster.
    { pos: v(0, 2, 0), size: v(3, 4, 3), color: SLATE3, emissive: GREEN },
    { pos: v(0, 1.25, 8), size: v(6, 2.5, 2), color: SLATE2, emissive: GREEN },
    { pos: v(0, 1.25, -8), size: v(6, 2.5, 2), color: SLATE2, emissive: GREEN },

    // Mid-lane cover, staggered.
    { pos: v(-12, 1, 12), size: v(3, 2, 3), color: SLATE3, emissive: AMBER },
    { pos: v(12, 1, -12), size: v(3, 2, 3), color: SLATE3, emissive: AMBER },
    { pos: v(-12, 1, -12), size: v(3, 2, 3), color: SLATE3, emissive: AMBER },
    { pos: v(12, 1, 12), size: v(3, 2, 3), color: SLATE3, emissive: AMBER },

    // Flank walls creating side routes.
    { pos: v(0, 2.5, 26), size: v(20, 5, 2), color: SLATE2, emissive: PINK },
    { pos: v(0, 2.5, -26), size: v(20, 5, 2), color: SLATE2, emissive: CYAN },
    { pos: v(-16, 1.5, 22), size: v(2, 3, 6), color: SLATE3, emissive: GREEN },
    { pos: v(16, 1.5, -22), size: v(2, 3, 6), color: SLATE3, emissive: GREEN },
  ],
};

/**
 * "Blacksite" — a tight indoor map: staggered baffle walls and side rooms form
 * a winding maze that breaks long sightlines and rewards corner play, while the
 * north and south ends open into clearings for aggressive, fast duels.
 */
export const BLACKSITE: GameMap = {
  name: "Blacksite",
  bounds: 36,
  spawns: [
    v(-30, 0, -32), v(30, 0, -32), v(-30, 0, 32), v(30, 0, 32),
    v(-32, 0, -8), v(32, 0, 8), v(0, 0, -8), v(0, 0, 8),
    v(-32, 0, 18), v(32, 0, -18), v(18, 0, 20), v(-18, 0, -20),
  ],
  boxes: [
    ...shell(36, 7),

    // Staggered horizontal baffles with offset doorways → zig-zag flow.
    wall(-36, -22, 6, -22, SLATE2, CYAN), //   gap on the right
    wall(-6, -10, 36, -10, SLATE2, PINK), //   gap on the left
    wall(-36, 2, -10, 2, SLATE2, CYAN), //     center gap (two segments)
    wall(8, 2, 36, 2, SLATE2, CYAN),
    wall(-6, 14, 36, 14, SLATE2, PINK), //     gap on the left
    wall(-36, 26, 6, 26, SLATE2, CYAN), //     gap on the right

    // Vertical dividers carving the corridors into rooms.
    wall(-12, -10, -12, 2, SLATE3, GREEN),
    wall(12, 2, 12, 14, SLATE3, GREEN),
    wall(-20, 14, -20, 26, SLATE3, AMBER),
    wall(20, -22, 20, -10, SLATE3, AMBER),
    // Pockets at the open ends for cover near spawns.
    wall(0, -36, 0, -29, SLATE3, PINK),
    wall(0, 29, 0, 36, SLATE3, CYAN),

    // Central control room (4 short walls leaving doorways on each side).
    wall(-7, -6, -2, -6, SLATE2, GREEN),
    wall(2, -6, 7, -6, SLATE2, GREEN),
    wall(-7, 6, -2, 6, SLATE2, GREEN),
    wall(2, 6, 7, 6, SLATE2, GREEN),
    wall(-7, -6, -7, -2, SLATE2, GREEN),
    wall(7, 2, 7, 6, SLATE2, GREEN),

    // Scattered low cover (crouch/peek) in corridors and clearings.
    { pos: v(-26, 1.25, -30), size: v(2.5, 2.5, 2.5), color: SLATE3, emissive: AMBER },
    { pos: v(26, 1.25, 30), size: v(2.5, 2.5, 2.5), color: SLATE3, emissive: AMBER },
    { pos: v(28, 1.25, -28), size: v(2.5, 2.5, 2.5), color: SLATE3, emissive: PINK },
    { pos: v(-28, 1.25, 28), size: v(2.5, 2.5, 2.5), color: SLATE3, emissive: PINK },
    { pos: v(0, 1, 0), size: v(2, 2, 2), color: SLATE3, emissive: CYAN },
    { pos: v(-30, 1, 10), size: v(2, 2, 2), color: SLATE3, emissive: GREEN },
    { pos: v(30, 1, -10), size: v(2, 2, 2), color: SLATE3, emissive: GREEN },
  ],
};

// --- Vertical maps ---------------------------------------------------------

/** A floor/platform whose top surface sits at `topY` (1 unit thick). */
function plat(cx: number, cz: number, w: number, d: number, topY: number, emissive?: number): MapBox {
  return { pos: v(cx, topY - 0.5, cz), size: v(w, 1, d), color: DARK, ...(emissive ? { emissive } : {}) };
}
/** A jump pad sitting on a surface at `topY`, launching up/inward. */
function pad(x: number, z: number, topY: number, lx: number, ly: number, lz: number, color: number): JumpPad {
  return { pos: v(x, topY + 0.1, z), size: v(4, 0.2, 4), launch: v(lx, ly, lz), color };
}

/** A walkable ramp: footprint (w×l), rising `height` from `baseY` toward `dir`. */
function ramp(cx: number, cz: number, w: number, l: number, baseY: number, height: number, dir: number, emissive?: number): Ramp {
  return { pos: v(cx, baseY, cz), size: v(w, height, l), dir, color: SLATE2, ...(emissive ? { emissive } : {}) };
}

/** An upright cylinder "tank/pillar": radius `r`, height `h`, base sitting at `baseY`. */
function tank(cx: number, cz: number, r: number, h: number, baseY: number, color: number, emissive?: number): MapBox {
  return { pos: v(cx, baseY + h / 2, cz), size: v(r * 2, h, r * 2), color, shape: "cylinder", ...(emissive ? { emissive } : {}) };
}
/** A sphere "reactor/orb" of radius `r` centered at (cx, cy, cz). */
function orb(cx: number, cy: number, cz: number, r: number, color: number, emissive?: number): MapBox {
  return { pos: v(cx, cy, cz), size: v(r * 2, r * 2, r * 2), color, shape: "sphere", ...(emissive ? { emissive } : {}) };
}

/**
 * "Spire" — a small, intensely vertical tower: four stacked platforms reached
 * by jump pads, with a sniper perch at the top. Falling drops you a floor.
 */
export const SPIRE: GameMap = {
  name: "Spire",
  bounds: 22,
  spawns: [
    v(-18, 0, -18), v(18, 0, 18), v(18, 0, -18), v(-18, 0, 18),
    v(-10, 8, 10), v(10, 8, -10), v(0, 16, 8), v(0, 24, 0),
  ],
  boxes: [
    ...shell(22, 34),
    // Floor 1
    plat(0, 0, 30, 30, 8, CYAN),
    wall(-15, 8, -15, 8, SLATE2, CYAN, 2.5), // low rails (cover)
    { pos: v(0, 9, -15), size: v(30, 2.5, 1), color: SLATE2, emissive: CYAN },
    { pos: v(0, 9, 15), size: v(30, 2.5, 1), color: SLATE2, emissive: CYAN },
    { pos: v(7, 9.5, 0), size: v(3, 3, 3), color: SLATE3, emissive: PINK },
    // Floor 2
    plat(0, 0, 22, 22, 16, PINK),
    { pos: v(-11, 17, 0), size: v(1, 2.5, 22), color: SLATE2, emissive: PINK },
    { pos: v(11, 17, 0), size: v(1, 2.5, 22), color: SLATE2, emissive: PINK },
    { pos: v(-6, 17.5, 6), size: v(3, 3, 3), color: SLATE3, emissive: GREEN },
    // Floor 3 (top perch)
    plat(0, 0, 13, 13, 24, AMBER),
    { pos: v(0, 25.5, 0), size: v(3, 5, 3), color: SLATE3, emissive: AMBER },
  ],
  // Pads up: ground→F1, F1→F2, F2→F3
  pads: [
    pad(-18, 18, 0, 5, 20, -5, CYAN),
    pad(18, -18, 0, -5, 20, 5, CYAN),
    pad(-9, 9, 8, 4, 20, -4, PINK),
    pad(9, -9, 8, -4, 20, 4, PINK),
    pad(8, 0, 16, -3, 19, 0, AMBER),
  ],
};

/**
 * "Atrium" — a medium 3-storey building with an open central void. Perimeter
 * balconies on each floor, connected by pads; long sightlines down the atrium.
 */
export const ATRIUM: GameMap = {
  name: "Atrium",
  bounds: 36,
  spawns: [
    v(-30, 0, -30), v(30, 0, 30), v(30, 0, -30), v(-30, 0, 30),
    v(-28, 8, 0), v(28, 8, 0), v(0, 16, -28), v(0, 16, 28),
    v(-28, 16, 0), v(28, 16, 0),
  ],
  boxes: [
    ...shell(36, 28),
    // central pillar all the way up
    { pos: v(0, 13, 0), size: v(5, 26, 5), color: SLATE3, emissive: GREEN },
    // Floor 2 balconies (ring with open center), top at y=8, walkway depth 9
    plat(0, -28, 72, 9, 8, CYAN), plat(0, 28, 72, 9, 8, CYAN),
    plat(-28, 0, 9, 56, 8, PINK), plat(28, 0, 9, 56, 8, PINK),
    // Floor 3 balconies, narrower, top at y=16
    plat(0, -28, 72, 7, 16, AMBER), plat(0, 28, 72, 7, 16, AMBER),
    plat(-28, 0, 7, 56, 16, AMBER), plat(28, 0, 7, 56, 16, AMBER),
    // Cover crates on the balconies
    { pos: v(-20, 9, -28), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(20, 9, 28), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(-28, 17, 12), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
    { pos: v(28, 17, -12), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
  ],
  // Walkable ramps from the ground up to the floor-2 balconies.
  ramps: [
    ramp(0, -14.5, 6, 18, 0, 8, 3, CYAN), // up to north balcony (rises -z)
    ramp(0, 14.5, 6, 18, 0, 8, 2, PINK), // up to south balcony (rises +z)
  ],
  // Pads: ground→F2, F2→F3
  pads: [
    pad(-30, 18, 0, 0, 21, -8, CYAN),
    pad(30, -18, 0, 0, 21, 8, CYAN),
    pad(18, -30, 0, -8, 21, 0, PINK),
    pad(-18, 30, 0, 8, 21, 0, PINK),
    pad(-28, 10, 8, 0, 20, -6, AMBER),
    pad(28, -10, 8, 0, 20, 6, AMBER),
  ],
};

/**
 * "Skyhaven" — a large rooftops map: tall building blocks of varying heights
 * with bridges and pads between them, over a ground floor you can fall back to.
 */
export const SKYHAVEN: GameMap = {
  name: "Skyhaven",
  bounds: 55,
  spawns: [
    v(-46, 0, -46), v(46, 0, 46), v(46, 0, -46), v(-46, 0, 46),
    v(-30, 12, -30), v(30, 12, 30), v(0, 18, 0), v(-30, 12, 30),
    v(30, 12, -30), v(0, 0, -48), v(0, 0, 48), v(-48, 0, 0),
  ],
  boxes: [
    ...shell(55, 10),
    // Building blocks (solid towers) of varying heights — rooftops to fight on.
    { pos: v(-30, 6, -30), size: v(18, 12, 18), color: SLATE2, emissive: CYAN },
    { pos: v(30, 9, 30), size: v(18, 18, 18), color: SLATE2, emissive: PINK },
    { pos: v(30, 6, -30), size: v(16, 12, 16), color: SLATE2, emissive: AMBER },
    { pos: v(-30, 7.5, 30), size: v(16, 15, 16), color: SLATE2, emissive: GREEN },
    { pos: v(0, 9, 0), size: v(14, 18, 14), color: SLATE3, emissive: PINK }, // central spire
    // Sky-bridges between rooftops
    { pos: v(-15, 12, -30), size: v(12, 1, 5), color: DARK, emissive: CYAN },
    { pos: v(15, 18, 30), size: v(12, 1, 5), color: DARK, emissive: PINK },
    { pos: v(30, 12, 0), size: v(5, 1, 12), color: DARK, emissive: AMBER },
    { pos: v(-30, 15, 0), size: v(5, 1, 12), color: DARK, emissive: GREEN },
    // Rooftop cover
    { pos: v(-30, 13, -30), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(30, 19, 30), size: v(3, 2.5, 3), color: SLATE3, emissive: PINK },
    { pos: v(0, 19, 0), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
  ],
  // Pads from the ground up to the rooftops
  pads: [
    pad(-46, 0, 0, 8, 22, 8, CYAN),
    pad(46, 0, 0, -8, 26, -8, PINK),
    pad(0, -46, 0, 0, 22, 8, AMBER),
    pad(0, 46, 0, 0, 22, -8, GREEN),
    pad(-14, 12, -30, 8, 18, 4, PINK), // bridge to central spire
  ],
};

const SAND   = 0xd4b896;
const SANDDK = 0xab8c60;
const CRATE  = 0x8b6e45;
const SITE_F = 0xe0b820;
const FLOORD = 0x5a4830;

/**
 * "Dust II" — a simplified replica of the classic bomb-defusal map.
 * Two corridors (Long A east, B Tunnels west) connect T spawn (south)
 * to bomb sites A (northeast) and B (northwest). A mid area with the
 * iconic mid-box and a Short-A connector round out the flow.
 */
export const DUST2: GameMap = {
  name: "Dust II",
  bounds: 52,
  // T spawns (south) — also used as FFA spawns when combined with CT spawns.
  spawns: [
    v(-8, 0, 46), v(6, 0, 44), v(20, 0, 46), v(34, 0, 44), v(44, 0, 46),
    v(-36, 0, -44), v(-24, 0, -46), v(-12, 0, -44), v(0, 0, -46), v(-48, 0, -44),
  ],
  spawnsCT: [
    v(-36, 0, -44), v(-24, 0, -46), v(-12, 0, -44), v(0, 0, -46), v(-48, 0, -44),
  ],
  bombSites: [
    { id: "A", pos: v(40, 0, -36), radius: 12 },
    { id: "B", pos: v(-40, 0, -40), radius: 12 },
  ],
  boxes: [
    // ---- Outer shell (sandy) ----
    { pos: v(0, -0.5, 0), size: v(104, 1, 104), color: FLOORD },
    { pos: v(0, 4, -52), size: v(104, 8, 1), color: SAND },
    { pos: v(0, 4, 52), size: v(104, 8, 1), color: SAND },
    { pos: v(-52, 4, 0), size: v(1, 8, 104), color: SAND },
    { pos: v(52, 4, 0), size: v(1, 8, 104), color: SAND },

    // ---- A Site (northeast) ----
    { pos: v(40, 0.05, -36), size: v(22, 0.1, 24), color: SITE_F },       // site floor
    { pos: v(32, 1.5, -46), size: v(6, 3, 5), color: CRATE },             // CT-side box
    { pos: v(47, 1.5, -32), size: v(5, 3, 6), color: CRATE },             // T-side box
    { pos: v(40, 1.5, -26), size: v(5, 3, 4), color: CRATE },             // corner cover

    // ---- Long A corridor (east) ----
    { pos: v(27, 3.5, 2), size: v(2, 7, 48), color: SAND },               // inner wall (z=-22 to 26)
    { pos: v(30, 1.5, -20), size: v(4, 3, 4), color: CRATE },             // Long peek box
    { pos: v(44, 1.5, 16), size: v(5, 3, 4), color: CRATE },              // T corner cover

    // ---- B Site (northwest) ----
    { pos: v(-40, 0.05, -40), size: v(22, 0.1, 20), color: SITE_F },      // site floor
    { pos: v(-32, 1.5, -46), size: v(6, 3, 5), color: CRATE },            // CT-side box
    { pos: v(-47, 1.5, -34), size: v(5, 3, 5), color: CRATE },            // T-side box
    { pos: v(-40, 1.5, -28), size: v(5, 3, 4), color: CRATE },            // corner cover

    // ---- B Tunnels corridor (west) ----
    { pos: v(-27, 3.5, 0), size: v(2, 7, 52), color: SAND },              // inner wall (z=-26 to 26)
    { pos: v(-40, 3.5, 14), size: v(22, 7, 3), color: SANDDK },           // tunnel divider
    { pos: v(-32, 1.5, 4), size: v(5, 3, 5), color: CRATE },              // tunnel mid cover
    { pos: v(-44, 1.5, 22), size: v(5, 3, 4), color: CRATE },             // T entrance cover

    // ---- Mid area ----
    { pos: v(0, 3, -3), size: v(12, 6, 10), color: SAND },                // iconic mid box
    { pos: v(17, 3.5, -27), size: v(2, 7, 10), color: SAND },             // Short A wall (z=-22 to -32)
    { pos: v(20, 1.5, -22), size: v(5, 3, 4), color: CRATE },             // Short A corner box

    // ---- CT mid area ----
    { pos: v(-11, 3.5, -29), size: v(2, 7, 14), color: SAND },            // left CT mid wall
    { pos: v(11, 3.5, -29), size: v(2, 7, 14), color: SAND },             // right CT mid wall
    { pos: v(-4, 1.5, -42), size: v(5, 3, 4), color: CRATE },             // CT spawn cover L
    { pos: v(6, 1.5, -40), size: v(4, 3, 4), color: CRATE },              // CT spawn cover R

    // ---- T spawn area ----
    { pos: v(-4, 3.5, 22), size: v(20, 7, 2), color: SAND },              // south mid separator
    { pos: v(18, 1.5, 44), size: v(5, 3, 4), color: CRATE },              // T spawn center box
    { pos: v(-14, 1.5, 42), size: v(4, 3, 4), color: CRATE },             // T spawn left box
  ],
};

/**
 * "Mangrove" — a giant walled-off research lab where the experiments got loose.
 * A river of acid runs the length of the complex in a sunken channel, crossed by
 * a flush bridge, two moving-platform ferries and a chain of unstable floating
 * slabs. Four containment wings (two of them flooded with toxic gas) ring the
 * channel on the ground floor; a full catwalk level rings the central void above,
 * and two elevator-fed control perches overlook it all. Big, vertical, hostile.
 */
export const MANGROVE: GameMap = {
  name: "Mangrove",
  bounds: 70,
  spawns: [
    // Safe rooms (the gas-free wing on each side).
    v(-50, 0, 50), v(-58, 0, 40), v(50, 0, -50), v(58, 0, -40),
    // Mid halls flanking the bridge.
    v(-16, 0, -8), v(16, 0, 8), v(-16, 0, 8), v(16, 0, -8),
    // Floor-2 catwalks.
    v(-63, 8, 0), v(63, 8, 0), v(0, 8, -64), v(0, 8, 64),
    // Control perches.
    v(-63, 16, -60), v(63, 16, 60),
  ],
  boxes: [
    // ---- Perimeter (giant lab walls, three storeys tall) ----
    { pos: v(0, 11, -70), size: v(140, 22, 1), color: SLATE, emissive: GREEN },
    { pos: v(0, 11, 70), size: v(140, 22, 1), color: SLATE, emissive: GREEN },
    { pos: v(-70, 11, 0), size: v(1, 22, 140), color: SLATE, emissive: VENOM },
    { pos: v(70, 11, 0), size: v(1, 22, 140), color: SLATE, emissive: VENOM },

    // ---- Ground floor: two wings split by the acid channel (x in [-7,7]) ----
    plat(-38.5, 0, 63, 140, 0, GREEN),
    plat(38.5, 0, 63, 140, 0, AMBER),
    { pos: v(0, -4.5, 0), size: v(14, 1, 140), color: 0x0c2417 }, // acid-channel bed

    // Flush bridge across the channel + low rails.
    plat(0, 0, 18, 6, 0, CYAN),
    { pos: v(0, 1, -3), size: v(18, 2, 0.4), color: SLATE2, emissive: CYAN },
    { pos: v(0, 1, 3), size: v(18, 2, 0.4), color: SLATE2, emissive: CYAN },

    // Unstable floating slabs — parkour across the acid at staggered heights.
    { pos: v(-3, 1.2, -22), size: v(3.6, 0.5, 3.6), color: SLATE3, emissive: CYAN },
    { pos: v(3, 2.4, -16), size: v(3, 0.5, 3), color: SLATE3, emissive: PINK },
    { pos: v(-2, 1.6, -10), size: v(3.6, 0.5, 3.6), color: SLATE3, emissive: CYAN },
    { pos: v(3, 1.2, 22), size: v(3.6, 0.5, 3.6), color: SLATE3, emissive: PINK },
    { pos: v(-3, 2.4, 16), size: v(3, 0.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(2, 1.6, 10), size: v(3.6, 0.5, 3.6), color: SLATE3, emissive: PINK },

    // ---- Containment rooms (walls with offset doorways) ----
    // NW (Room A — toxic).
    wall(-70, -26, -46, -26, SLATE2, GREEN), wall(-34, -26, -7, -26, SLATE2, GREEN),
    wall(-22, -70, -22, -50, SLATE2, GREEN), wall(-22, -40, -22, -26, SLATE2, GREEN),
    // SW (Room B — clear).
    wall(-70, 26, -46, 26, SLATE2, GREEN), wall(-34, 26, -7, 26, SLATE2, GREEN),
    wall(-22, 50, -22, 70, SLATE2, GREEN), wall(-22, 26, -22, 40, SLATE2, GREEN),
    // NE (Room C — clear).
    wall(7, -26, 30, -26, SLATE2, AMBER), wall(42, -26, 70, -26, SLATE2, AMBER),
    wall(22, -70, 22, -54, SLATE2, AMBER), wall(22, -44, 22, -26, SLATE2, AMBER),
    // SE (Room D — toxic).
    wall(7, 26, 30, 26, SLATE2, AMBER), wall(42, 26, 70, 26, SLATE2, AMBER),
    wall(22, 26, 22, 44, SLATE2, AMBER), wall(22, 54, 22, 70, SLATE2, AMBER),

    // ---- Props: containment tanks (cylinders) + reactor orbs (spheres) ----
    tank(-60, -58, 1.8, 5, 0, SLATE3, GREEN), tank(-40, -62, 1.5, 5, 0, SLATE3, CYAN),
    orb(-44, 3, -44, 3.2, SLATE3, VENOM),
    tank(-60, 58, 1.8, 5, 0, SLATE3, GREEN), tank(-38, 62, 1.5, 5, 0, SLATE3, CYAN),
    orb(-46, 3, 46, 3, SLATE3, GREEN),
    tank(60, -58, 1.8, 5, 0, SLATE3, AMBER), tank(38, -62, 1.5, 5, 0, SLATE3, AMBER),
    orb(46, 3, -46, 3, SLATE3, PINK),
    tank(60, 58, 1.8, 5, 0, SLATE3, AMBER), tank(38, 62, 1.5, 5, 0, SLATE3, PINK),
    orb(44, 3, 44, 3.2, SLATE3, AMBER),
    // Pipe-stacks rising to the catwalk level (vertical landmarks + cover).
    tank(-24, -50, 1.6, 8, 0, SLATE3, CYAN), tank(24, 50, 1.6, 8, 0, SLATE3, PINK),
    tank(-24, 50, 1.6, 8, 0, SLATE3, GREEN), tank(24, -50, 1.6, 8, 0, SLATE3, AMBER),
    // Mid-hall low cover.
    { pos: v(-15, 1.25, -2), size: v(3, 2.5, 3), color: SLATE3, emissive: VENOM },
    { pos: v(15, 1.25, 2), size: v(3, 2.5, 3), color: SLATE3, emissive: VENOM },

    // ---- Floor 2: catwalk ring around the central void (top y=8) ----
    plat(0, -64, 140, 10, 8, GREEN), plat(0, 64, 140, 10, 8, GREEN),
    plat(-63, 0, 12, 116, 8, AMBER), plat(63, 0, 12, 116, 8, AMBER),
    plat(-12, 0, 9, 116, 8, CYAN), plat(12, 0, 9, 116, 8, CYAN),
    plat(-37, -40, 50, 7, 8, AMBER), plat(-37, 40, 50, 7, 8, AMBER), plat(-37, 0, 50, 7, 8, AMBER),
    plat(37, -40, 50, 7, 8, AMBER), plat(37, 40, 50, 7, 8, AMBER), plat(37, 0, 50, 7, 8, AMBER),
    plat(0, 0, 17, 7, 8, PINK), // central catwalk bridge over the void
    // Void-edge rails (gaps left near the crossings).
    { pos: v(-7.2, 9, -32), size: v(0.4, 2, 38), color: SLATE2, emissive: VENOM },
    { pos: v(-7.2, 9, 32), size: v(0.4, 2, 38), color: SLATE2, emissive: VENOM },
    { pos: v(7.2, 9, -32), size: v(0.4, 2, 38), color: SLATE2, emissive: VENOM },
    { pos: v(7.2, 9, 32), size: v(0.4, 2, 38), color: SLATE2, emissive: VENOM },
    // Floor-2 cover.
    { pos: v(-50, 9.25, -20), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
    { pos: v(-50, 9.25, 20), size: v(3, 2.5, 3), color: SLATE3, emissive: GREEN },
    { pos: v(50, 9.25, -20), size: v(3, 2.5, 3), color: SLATE3, emissive: GREEN },
    { pos: v(50, 9.25, 20), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
    { pos: v(-37, 10.5, -20), size: v(0.8, 5, 12), color: SLATE2, emissive: GREEN },
    { pos: v(37, 10.5, 20), size: v(0.8, 5, 12), color: SLATE2, emissive: GREEN },

    // ---- Floor 3: control perches (top y=16), reached by ramps off the catwalk ----
    plat(-63, -60, 12, 16, 16, CYAN), plat(63, 60, 12, 16, 16, PINK),
    { pos: v(-63, 17, -52), size: v(12, 2, 0.5), color: SLATE2, emissive: CYAN }, // perch front rails
    { pos: v(63, 17, 52), size: v(12, 2, 0.5), color: SLATE2, emissive: PINK },
    { pos: v(-63, 18.5, -67.5), size: v(12, 5, 0.5), color: SLATE2, emissive: CYAN }, // back walls vs perimeter
    { pos: v(63, 18.5, 67.5), size: v(12, 5, 0.5), color: SLATE2, emissive: PINK },
  ],
  ramps: [
    // Ground → floor-2 perimeter catwalk, one per wing.
    ramp(-50, -20, 14, 9, 0, 8, 1, AMBER),
    ramp(50, 20, 14, 9, 0, 8, 0, AMBER),
    // Floor-2 catwalk → floor-3 control perch.
    ramp(-63, -44, 10, 16, 8, 8, 3, CYAN),
    ramp(63, 44, 10, 16, 8, 8, 2, PINK),
  ],
  pads: [
    // Emergency vents — blast you up out of the acid channel.
    pad(-3, -16, -4, -12, 19, 2, GREEN),
    pad(3, 16, -4, 12, 19, -2, AMBER),
    // Ground → floor-2 (inner catwalks), alternate routes.
    pad(-12, -50, 0, 0, 23, 8, CYAN),
    pad(12, 50, 0, 0, 23, -8, PINK),
  ],
  hazards: [
    { pos: v(0, -2.3, 0), size: v(13.5, 3.4, 138), color: ACID, dps: 32 }, // the acid river
    { pos: v(-46, 1.6, -48), size: v(40, 3.2, 38), color: TOXIC, dps: 7 }, // Room A gas
    { pos: v(46, 1.6, 48), size: v(40, 3.2, 38), color: TOXIC, dps: 7 }, // Room D gas
    { pos: v(-15, 1.2, -12), size: v(5, 3, 5), color: VENOM, dps: 18 }, // leaking-pipe traps
    { pos: v(15, 1.2, 12), size: v(5, 3, 5), color: VENOM, dps: 18 },
    { pos: v(-63, 9.6, 40), size: v(10, 3, 28), color: TOXIC, dps: 7 }, // catwalk leak
  ],
  platforms: [
    // Sliding blast-walls — moving cover that keeps re-cutting the wing sightlines.
    { pos: v(-40, 2.5, -8), size: v(6, 5, 0.8), color: SLATE2, travel: v(0, 0, 18), period: 9, emissive: GREEN },
    { pos: v(40, 2.5, 8), size: v(6, 5, 0.8), color: SLATE2, travel: v(0, 0, -18), period: 9, emissive: AMBER },
    // Gates patrolling along the acid channel (block cross-river shots).
    { pos: v(0, 1.6, -22), size: v(13, 3, 0.8), color: SLATE2, travel: v(0, 0, -16), period: 10, emissive: CYAN },
    { pos: v(0, 1.6, 22), size: v(13, 3, 0.8), color: SLATE2, travel: v(0, 0, 16), period: 10, emissive: PINK },
  ],
  lights: [
    { pos: v(-46, 5, -48), color: TOXIC, intensity: 3, range: 32 },
    { pos: v(46, 5, 48), color: TOXIC, intensity: 3, range: 32 },
    { pos: v(0, 2.5, -30), color: ACID, intensity: 2.6, range: 26 },
    { pos: v(0, 2.5, 0), color: ACID, intensity: 2.6, range: 26 },
    { pos: v(0, 2.5, 30), color: ACID, intensity: 2.6, range: 26 },
    { pos: v(-44, 6, -44), color: VENOM, intensity: 2, range: 22 },
    { pos: v(46, 6, -46), color: PINK, intensity: 2, range: 22 },
    { pos: v(-46, 6, 46), color: GREEN, intensity: 2, range: 22 },
    { pos: v(44, 6, 44), color: AMBER, intensity: 2, range: 22 },
    { pos: v(-63, 18, -58), color: CYAN, intensity: 2.6, range: 24 },
    { pos: v(63, 18, 58), color: CYAN, intensity: 2.6, range: 24 },
  ],
  emitters: [
    { pos: v(-46, 0.6, -48), color: TOXIC, rate: 22, dir: v(0, 2.4, 0) },
    { pos: v(46, 0.6, 48), color: TOXIC, rate: 22, dir: v(0, 2.4, 0) },
    { pos: v(0, -0.6, -30), color: ACID, rate: 30, dir: v(0, 1.6, 0) },
    { pos: v(0, -0.6, 0), color: ACID, rate: 30, dir: v(0, 1.6, 0) },
    { pos: v(0, -0.6, 30), color: ACID, rate: 30, dir: v(0, 1.6, 0) },
    { pos: v(-15, 0.6, -12), color: VENOM, rate: 18, dir: v(0, 2, 0) },
    { pos: v(15, 0.6, 12), color: VENOM, rate: 18, dir: v(0, 2, 0) },
  ],
};

/**
 * "Aurora Fields" — a huge open sky-arena built for movement. A central spire
 * climbs in tiers to an apex sniper perch; four floating islands hang over the
 * corners, linked back to the spire by drifting platforms you ride across the
 * void. The field between is an obstacle slalom of pillars and floating orbs to
 * weave through at speed, while the open cardinal lanes are left clear for
 * no-scopes. Plenty of room to breathe — plenty to crash into if you misjudge.
 */
export const AURORA: GameMap = {
  name: "Aurora Fields",
  bounds: 80,
  spawns: [
    v(-64, 0, 0), v(64, 0, 0), v(0, 0, -64), v(0, 0, 64),
    v(-44, 0, -44), v(44, 0, 44), v(-44, 0, 44), v(44, 0, -44),
    v(58, 10, 58), v(-58, 10, 58), v(58, 10, -58), v(-58, 10, -58),
    v(8, 0, 8), v(0, 7, 2),
  ],
  boxes: [
    ...shell(80, 12),

    // ---- Central spire: a ramp-climbed ziggurat to a high apex perch ----
    { pos: v(0, 3.5, 0), size: v(6, 7, 6), color: SLATE3, emissive: CYAN },                     // core column (y0-7)
    { pos: v(0, 6.5, 0), size: v(12, 1, 12), color: DARK, emissive: GREEN, shape: "cylinder" }, // mid disc (top y7, r6)
    { pos: v(0, 9, -15), size: v(4, 4, 4), color: SLATE3, emissive: PINK },                      // apex support
    { pos: v(0, 11.5, -15), size: v(11, 1, 11), color: DARK, emissive: AMBER },                  // apex perch (top y12)
    { pos: v(0, 13.4, -15), size: v(1.4, 2.8, 1.4), color: SLATE3, emissive: PINK },             // apex beacon
    orb(0, 15.2, -15, 1.4, SLATE3, CYAN),

    // ---- Four floating corner islands (top y=10) + sub-perches (top y=14) ----
    { pos: v(58, 9.5, 58), size: v(24, 1, 24), color: DARK, emissive: PINK },
    { pos: v(63, 13.5, 63), size: v(9, 1, 9), color: DARK, emissive: AMBER },
    { pos: v(-58, 9.5, 58), size: v(24, 1, 24), color: DARK, emissive: CYAN },
    { pos: v(-63, 13.5, 63), size: v(9, 1, 9), color: DARK, emissive: GREEN },
    { pos: v(58, 9.5, -58), size: v(24, 1, 24), color: DARK, emissive: GREEN },
    { pos: v(63, 13.5, -63), size: v(9, 1, 9), color: DARK, emissive: AMBER },
    { pos: v(-58, 9.5, -58), size: v(24, 1, 24), color: DARK, emissive: AMBER },
    { pos: v(-63, 13.5, -63), size: v(9, 1, 9), color: DARK, emissive: CYAN },
    // Outer rails so a miss drops you inward (toward the action), not off-world.
    { pos: v(70, 11, 58), size: v(0.6, 2, 24), color: SLATE2, emissive: PINK },
    { pos: v(58, 11, 70), size: v(24, 2, 0.6), color: SLATE2, emissive: PINK },
    { pos: v(-70, 11, 58), size: v(0.6, 2, 24), color: SLATE2, emissive: CYAN },
    { pos: v(-58, 11, 70), size: v(24, 2, 0.6), color: SLATE2, emissive: CYAN },
    { pos: v(70, 11, -58), size: v(0.6, 2, 24), color: SLATE2, emissive: GREEN },
    { pos: v(58, 11, -70), size: v(24, 2, 0.6), color: SLATE2, emissive: GREEN },
    { pos: v(-70, 11, -58), size: v(0.6, 2, 24), color: SLATE2, emissive: AMBER },
    { pos: v(-58, 11, -70), size: v(24, 2, 0.6), color: SLATE2, emissive: AMBER },
    // Island cover (kept clear of the sub-perch ramps).
    tank(52, 52, 1.8, 3.5, 10, SLATE3, CYAN), { pos: v(52, 11.25, 64), size: v(3, 2.5, 3), color: SLATE3, emissive: GREEN },
    tank(-52, 52, 1.8, 3.5, 10, SLATE3, PINK), { pos: v(-52, 11.25, 64), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
    tank(52, -52, 1.8, 3.5, 10, SLATE3, AMBER), { pos: v(52, 11.25, -64), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    tank(-52, -52, 1.8, 3.5, 10, SLATE3, GREEN), { pos: v(-52, 11.25, -64), size: v(3, 2.5, 3), color: SLATE3, emissive: PINK },

    // ---- Mid-field slalom: pillars + floating orbs (weave through at speed) ----
    // +x lane
    tank(22, 0, 1.4, 6, 0, SLATE3, CYAN), tank(36, 5, 1.4, 6, 0, SLATE2, PINK), tank(36, -5, 1.4, 6, 0, SLATE2, GREEN), tank(46, 0, 1.8, 9, 0, SLATE3, AMBER), orb(30, 11, 0, 2.4, SLATE3, CYAN),
    // -x lane
    tank(-22, 0, 1.4, 6, 0, SLATE3, CYAN), tank(-36, 5, 1.4, 6, 0, SLATE2, PINK), tank(-36, -5, 1.4, 6, 0, SLATE2, GREEN), tank(-46, 0, 1.8, 9, 0, SLATE3, AMBER), orb(-30, 11, 0, 2.4, SLATE3, CYAN),
    // +z lane
    tank(0, 22, 1.4, 6, 0, SLATE3, PINK), tank(5, 36, 1.4, 6, 0, SLATE2, CYAN), tank(-5, 36, 1.4, 6, 0, SLATE2, AMBER), tank(0, 46, 1.8, 9, 0, SLATE3, GREEN), orb(0, 11, 30, 2.4, SLATE3, PINK),
    // -z lane
    tank(0, -22, 1.4, 6, 0, SLATE3, PINK), tank(5, -36, 1.4, 6, 0, SLATE2, CYAN), tank(-5, -36, 1.4, 6, 0, SLATE2, AMBER), tank(0, -46, 1.8, 9, 0, SLATE3, GREEN), orb(0, 11, -30, 2.4, SLATE3, PINK),
    // Off-axis floating orbs (aerial slalom).
    orb(20, 7, 12, 2.4, SLATE3, PINK), orb(12, 10, 20, 2.2, SLATE3, CYAN),
    orb(-20, 7, 12, 2.4, SLATE3, CYAN), orb(-12, 10, 20, 2.2, SLATE3, PINK),
    orb(20, 7, -12, 2.4, SLATE3, GREEN), orb(12, 10, -20, 2.2, SLATE3, AMBER),
    orb(-20, 7, -12, 2.4, SLATE3, AMBER), orb(-12, 10, -20, 2.2, SLATE3, GREEN),
    // Low ground cover near the spire.
    { pos: v(13, 1.25, 13), size: v(3, 2.5, 3), color: SLATE3, emissive: GREEN },
    { pos: v(-13, 1.25, 13), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(13, 1.25, -13), size: v(3, 2.5, 3), color: SLATE3, emissive: AMBER },
    { pos: v(-13, 1.25, -13), size: v(3, 2.5, 3), color: SLATE3, emissive: PINK },
  ],
  ramps: [
    // Spire climb: ground → mid disc (y7) → apex perch (y12).
    ramp(0, 13, 12, 14, 0, 7, 3, GREEN),
    ramp(0, -6.5, 8, 7, 7, 5, 3, AMBER),
    // Ground → each corner island (lands on the inner edge).
    ramp(38, 58, 16, 10, 0, 10, 0, PINK), ramp(-38, 58, 16, 10, 0, 10, 1, CYAN),
    ramp(38, -58, 16, 10, 0, 10, 0, GREEN), ramp(-38, -58, 16, 10, 0, 10, 1, AMBER),
    // Island → its sub-perch.
    ramp(63, 54, 8, 9, 10, 4, 2, AMBER), ramp(-63, 54, 8, 9, 10, 4, 2, GREEN),
    ramp(63, -54, 8, 9, 10, 4, 3, AMBER), ramp(-63, -54, 8, 9, 10, 4, 3, CYAN),
  ],
  pads: [
    // Fast launches from the ground up to each corner island (skip the ramp).
    pad(42, 42, 0, 11, 24, 11, PINK),
    pad(-42, 42, 0, -11, 24, 11, CYAN),
    pad(42, -42, 0, 11, 24, -11, GREEN),
    pad(-42, -42, 0, -11, 24, -11, AMBER),
  ],
  hazards: [
    { pos: v(28, 0.4, 0), size: v(7, 1, 7), color: PLASMA, dps: 16 },
    { pos: v(-28, 0.4, 0), size: v(7, 1, 7), color: PLASMA, dps: 16 },
    { pos: v(0, 0.4, 28), size: v(7, 1, 7), color: PLASMA, dps: 16 },
    { pos: v(0, 0.4, -28), size: v(7, 1, 7), color: PLASMA, dps: 16 },
  ],
  platforms: [
    // Drifting blocks crossing the lanes mid-air — obstacles to juke around.
    { pos: v(30, 6, -10), size: v(3.5, 3.5, 3.5), color: SLATE2, travel: v(0, 0, 20), period: 8, emissive: CYAN },
    { pos: v(-30, 6, 10), size: v(3.5, 3.5, 3.5), color: SLATE2, travel: v(0, 0, -20), period: 8, emissive: PINK },
    { pos: v(-10, 6, 30), size: v(3.5, 3.5, 3.5), color: SLATE2, travel: v(20, 0, 0), period: 8, emissive: GREEN },
    { pos: v(10, 6, -30), size: v(3.5, 3.5, 3.5), color: SLATE2, travel: v(-20, 0, 0), period: 8, emissive: AMBER },
  ],
  lights: [
    { pos: v(0, 4, 0), color: CYAN, intensity: 2.5, range: 26 },
    { pos: v(0, 8, 0), color: GREEN, intensity: 2.5, range: 24 },
    { pos: v(0, 13, -15), color: AMBER, intensity: 2.2, range: 22 },
    { pos: v(58, 12, 58), color: PINK, intensity: 2.6, range: 30 },
    { pos: v(-58, 12, 58), color: CYAN, intensity: 2.6, range: 30 },
    { pos: v(58, 12, -58), color: GREEN, intensity: 2.6, range: 30 },
    { pos: v(-58, 12, -58), color: AMBER, intensity: 2.6, range: 30 },
    { pos: v(30, 5, 0), color: CYAN, intensity: 1.8, range: 20 },
    { pos: v(-30, 5, 0), color: PINK, intensity: 1.8, range: 20 },
    { pos: v(0, 5, 30), color: GREEN, intensity: 1.8, range: 20 },
    { pos: v(0, 5, -30), color: AMBER, intensity: 1.8, range: 20 },
    { pos: v(-74, 9, 0), color: CYAN, intensity: 2, range: 40 },
    { pos: v(74, 9, 0), color: PINK, intensity: 2, range: 40 },
    { pos: v(0, 9, -74), color: GREEN, intensity: 2, range: 40 },
    { pos: v(0, 9, 74), color: AMBER, intensity: 2, range: 40 },
  ],
  emitters: [
    { pos: v(-76, 1, -76), color: CYAN, rate: 26, dir: v(0, 7, 0) },
    { pos: v(76, 1, 76), color: PINK, rate: 26, dir: v(0, 7, 0) },
    { pos: v(76, 1, -76), color: GREEN, rate: 26, dir: v(0, 7, 0) },
    { pos: v(-76, 1, 76), color: AMBER, rate: 26, dir: v(0, 7, 0) },
    { pos: v(0, 1, -78), color: CYAN, rate: 22, dir: v(0, 8, 0) },
    { pos: v(0, 1, 78), color: PINK, rate: 22, dir: v(0, 8, 0) },
    { pos: v(-78, 1, 0), color: GREEN, rate: 22, dir: v(0, 8, 0) },
    { pos: v(78, 1, 0), color: AMBER, rate: 22, dir: v(0, 8, 0) },
    { pos: v(0, 13, -15), color: CYAN, rate: 16, dir: v(0, 3, 0) },
    { pos: v(58, 10, 58), color: PINK, rate: 12, dir: v(0, 3, 0) },
    { pos: v(-58, 10, 58), color: CYAN, rate: 12, dir: v(0, 3, 0) },
    { pos: v(58, 10, -58), color: GREEN, rate: 12, dir: v(0, 3, 0) },
    { pos: v(-58, 10, -58), color: AMBER, rate: 12, dir: v(0, 3, 0) },
  ],
};

export const MAPS: Record<string, GameMap> = {
  neon_yard: NEON_YARD,
  overdrive: OVERDRIVE,
  blacksite: BLACKSITE,
  spire: SPIRE,
  atrium: ATRIUM,
  skyhaven: SKYHAVEN,
  mangrove: MANGROVE,
  aurora: AURORA,
  dust2: DUST2,
};
