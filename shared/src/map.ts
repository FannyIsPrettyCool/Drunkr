import type { Vec3 } from "./math.js";

/** An axis-aligned box used for both rendering and collision. */
export interface MapBox {
  /** Center position. */
  pos: Vec3;
  /** Full size (width, height, depth). */
  size: Vec3;
  /** Hex color for the surface. */
  color: number;
  /** Optional neon emissive accent color. */
  emissive?: number;
}

export interface GameMap {
  name: string;
  /** Half-extent of the playable floor on X/Z (square arena). */
  bounds: number;
  spawns: Vec3[];
  boxes: MapBox[];
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const PINK = 0xff2d9b;
const CYAN = 0x18e0ff;
const GREEN = 0x39ff8b;
const AMBER = 0xffb23d;

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
  bounds: 45,
  spawns: [
    v(-38, 0, -38), v(38, 0, 38), v(-38, 0, 38), v(38, 0, -38),
    v(0, 0, -40), v(0, 0, 40), v(-40, 0, 0), v(40, 0, 0),
  ],
  boxes: [
    ...shell(45, 9),

    // Central stepped plaza + tower.
    { pos: v(0, 0.5, 0), size: v(20, 1, 20), color: SLATE2, emissive: CYAN },
    { pos: v(0, 1.5, 0), size: v(12, 1, 12), color: SLATE2, emissive: PINK },
    { pos: v(0, 5, 0), size: v(4, 10, 4), color: SLATE3, emissive: CYAN },
    { pos: v(0, 10.2, 0), size: v(6, 0.4, 6), color: SLATE3, emissive: PINK },

    // Ramps up onto the plaza (low steps).
    { pos: v(0, 0.5, 13), size: v(6, 1, 6), color: SLATE2, emissive: PINK },
    { pos: v(0, 0.5, -13), size: v(6, 1, 6), color: SLATE2, emissive: PINK },
    { pos: v(13, 0.5, 0), size: v(6, 1, 6), color: SLATE2, emissive: PINK },
    { pos: v(-13, 0.5, 0), size: v(6, 1, 6), color: SLATE2, emissive: PINK },

    // Flank cover lanes (symmetric crates).
    { pos: v(-18, 1.25, -10), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(18, 1.25, 10), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(-10, 1.25, -18), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(10, 1.25, 18), size: v(3, 2.5, 3), color: SLATE3, emissive: CYAN },
    { pos: v(-22, 1.5, 6), size: v(2, 3, 8), color: SLATE2, emissive: GREEN },
    { pos: v(22, 1.5, -6), size: v(2, 3, 8), color: SLATE2, emissive: GREEN },
    { pos: v(6, 1.5, -22), size: v(8, 3, 2), color: SLATE2, emissive: GREEN },
    { pos: v(-6, 1.5, 22), size: v(8, 3, 2), color: SLATE2, emissive: GREEN },

    // Corner sniper towers with access ramps.
    { pos: v(-34, 2, -34), size: v(10, 4, 10), color: SLATE2, emissive: AMBER },
    { pos: v(34, 2, 34), size: v(10, 4, 10), color: SLATE2, emissive: AMBER },
    { pos: v(-30, 1, -26), size: v(6, 2, 4), color: SLATE2, emissive: AMBER },
    { pos: v(30, 1, 26), size: v(6, 2, 4), color: SLATE2, emissive: AMBER },

    // Mid scattered low cover.
    { pos: v(-14, 0.75, 14), size: v(4, 1.5, 4), color: SLATE3, emissive: PINK },
    { pos: v(14, 0.75, -14), size: v(4, 1.5, 4), color: SLATE3, emissive: PINK },
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

export const MAPS: Record<string, GameMap> = {
  neon_yard: NEON_YARD,
  overdrive: OVERDRIVE,
  blacksite: BLACKSITE,
};
