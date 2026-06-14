import type { MapBox } from "./map.js";
import type { Vec3 } from "./math.js";

/** Texture keys — files live at `/textures/<key>.png` in each web app. */
export const TEXTURE_KEYS = [
  "tiles",
  "walls_dark",
  "walls_green",
  "walls_orange",
  "walls_pink",
  "walls_red",
  "pads",
] as const;

/** Emissive accent color → matching colored wall texture. */
const EMISSIVE_TEX: Record<number, string> = {
  0xff2d9b: "walls_pink",
  0x39ff8b: "walls_green",
  0xffb23d: "walls_orange",
  0xff3b3b: "walls_red",
  // cyan has no dedicated texture — fall back to dark with the neon edge.
};

/**
 * Pick a texture for a box: explicit `texture` wins; otherwise auto-assign from
 * the emissive color (colored walls) or shape (flat = floor tiles, else dark).
 * Returns null for "none".
 */
export function textureForBox(b: MapBox): string | null {
  if (b.texture) return b.texture === "none" ? null : b.texture;
  if (b.emissive && EMISSIVE_TEX[b.emissive]) return EMISSIVE_TEX[b.emissive];
  const flat = b.size.y <= 1.5 && Math.min(b.size.x, b.size.z) >= 5;
  return flat ? "tiles" : "walls_dark";
}

const TILE = 5; // world units per texture repeat

/** UV repeat (x, y) so the texture tiles at a consistent world scale. */
export function textureRepeat(size: Vec3, key: string): [number, number] {
  if (key === "pads") return [Math.max(1, size.x / 4), Math.max(1, size.z / 4)];
  const floorLike = size.y <= 1.5 && Math.min(size.x, size.z) >= 5;
  const rx = floorLike ? size.x / TILE : Math.max(size.x, size.z) / TILE;
  const ry = floorLike ? size.z / TILE : size.y / TILE;
  return [Math.max(0.5, rx), Math.max(0.5, ry)];
}
