import * as THREE from "three";
import { MOVE } from "@drunkr/shared";

/**
 * Cosmetic catalogue — all unlocked. Weapon skins are colour palettes applied
 * to the procedurally-built gun models (first-person in `Weapon` and
 * third-person in `RemotePlayers`). Accessories are small meshes worn on the
 * avatar; some emit particles (driven from the game loop).
 *
 * The server only stores/echoes the chosen ids as opaque strings — all visual
 * meaning lives here on the client.
 */

/** Selectable avatar skin hues (0..1), shown as swatches in the Locker. */
export const SKIN_HUES = [0.0, 0.08, 0.13, 0.33, 0.5, 0.58, 0.75, 0.85];

export interface WeaponSkin {
  /** Main body / receiver colour. */
  body: number;
  /** Emissive tint of the body. */
  emissive: number;
  /** Accent (neon strip / lens) colour. */
  accent: number;
  /** Dark metal parts. */
  metal: number;
  /** Bright steel parts. */
  steel: number;
  /** Glowing core colour. */
  glow: number;
}

export const WEAPON_SKINS: Record<string, WeaponSkin> = {
  default: { body: 0x16182a, emissive: 0x18e0ff, accent: 0xff2d9b, metal: 0x14161d, steel: 0x39414f, glow: 0x18e0ff },
  gold:    { body: 0x2a2410, emissive: 0xffcf3a, accent: 0xffd23b, metal: 0x3a2f12, steel: 0x8a6a2a, glow: 0xffcf3a },
  crimson: { body: 0x2a0e14, emissive: 0xff2d4b, accent: 0xff5d6e, metal: 0x240a0e, steel: 0x6a2730, glow: 0xff2d4b },
  toxic:   { body: 0x12220e, emissive: 0x6dff3a, accent: 0xb6ff3b, metal: 0x14240f, steel: 0x3a6a27, glow: 0x6dff3a },
  void:    { body: 0x140a24, emissive: 0x9b5dff, accent: 0xc78bff, metal: 0x120a24, steel: 0x4a2a6a, glow: 0x9b5dff },
  ice:     { body: 0x16222a, emissive: 0xbfe6ff, accent: 0xffffff, metal: 0x1a2630, steel: 0x5a7a8a, glow: 0xbfe6ff },
};

export const WEAPON_SKIN_LIST: { id: string; label: string }[] = [
  { id: "default", label: "Neon (default)" },
  { id: "gold", label: "Gold" },
  { id: "crimson", label: "Crimson" },
  { id: "toxic", label: "Toxic" },
  { id: "void", label: "Void" },
  { id: "ice", label: "Ice" },
];

export function weaponSkin(id?: string): WeaponSkin {
  return WEAPON_SKINS[id ?? "default"] ?? WEAPON_SKINS.default;
}

/** Material roles a Locker palette exposes, in array order. */
export const SKIN_PARTS: { key: keyof WeaponSkin; label: string }[] = [
  { key: "body", label: "Frame" },
  { key: "emissive", label: "Frame Glow" },
  { key: "accent", label: "Accent / Trim" },
  { key: "metal", label: "Grips & Mag" },
  { key: "steel", label: "Barrel" },
  { key: "glow", label: "Energy / Core" },
];

/** Weapons whose skins can be customised in the Locker. */
export const SKINNABLE_WEAPONS: { id: string; label: string }[] = [
  { id: "ak", label: "AK-44" },
  { id: "sniper", label: "LVR-50" },
  { id: "shotgun", label: "DB-12" },
  { id: "katana", label: "Katana" },
];

/** Compact palette as broadcast / stored: [body,emissive,accent,metal,steel,glow]. */
export type Palette = number[];

export function skinToArr(s: WeaponSkin): Palette {
  return [s.body, s.emissive, s.accent, s.metal, s.steel, s.glow];
}

export function arrToSkin(a?: Palette | null): WeaponSkin | null {
  if (!a || a.length < 6) return null;
  return { body: a[0], emissive: a[1], accent: a[2], metal: a[3], steel: a[4], glow: a[5] };
}

export interface LockerData {
  /** weaponId → custom palette (absent = use the default skin). */
  skins: Record<string, Palette>;
  accessory: string;
}

const LOCKER_KEY = "drunkr.locker";

export function loadLocker(): LockerData {
  try {
    const raw = localStorage.getItem(LOCKER_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<LockerData>;
      return { skins: d.skins ?? {}, accessory: d.accessory ?? "none" };
    }
  } catch { /* ignore */ }
  return { skins: {}, accessory: localStorage.getItem("drunkr.accessory") ?? "none" };
}

export function saveLocker(d: LockerData) {
  try { localStorage.setItem(LOCKER_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

/** Resolve the skin for a weapon: the Locker's custom palette, or the default. */
export function resolveWeaponSkin(weaponId: string): WeaponSkin {
  return arrToSkin(loadLocker().skins[weaponId]) ?? WEAPON_SKINS.default;
}

export interface Accessory {
  label: string;
  /** Build the worn mesh (positioned relative to the avatar's feet at y=0).
   *  `color` is the player's hue, for tinting. Return null for "none". */
  build: (color: THREE.Color) => THREE.Object3D | null;
  /** If set, the game loop emits particles of this colour above the head. */
  particle?: number;
}

const HEAD_Y = MOVE.height * 0.92;

export const ACCESSORIES: Record<string, Accessory> = {
  none: { label: "None", build: () => null },

  halo: {
    label: "Halo",
    build: () => {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(0.26, 0.035, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0xffd23b, emissive: 0xffcf3a, emissiveIntensity: 1.4 }),
      );
      m.rotation.x = Math.PI / 2;
      m.position.y = HEAD_Y + 0.42;
      return m;
    },
  },

  horns: {
    label: "Horns",
    build: (color) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x12111a, emissive: color, emissiveIntensity: 0.4, roughness: 0.6 });
      for (const sx of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), mat);
        horn.position.set(sx * 0.16, HEAD_Y + 0.22, 0);
        horn.rotation.z = sx * -0.4;
        g.add(horn);
      }
      return g;
    },
  },

  antenna: {
    label: "Antenna",
    build: (color) => {
      const g = new THREE.Group();
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6),
        new THREE.MeshStandardMaterial({ color: 0x222634, metalness: 0.7, roughness: 0.4 }),
      );
      rod.position.y = HEAD_Y + 0.3;
      g.add(rod);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 10, 10),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.8 }),
      );
      bulb.position.y = HEAD_Y + 0.48;
      g.add(bulb);
      return g;
    },
  },

  wings: {
    label: "Wings",
    build: (color) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: 0x101426, emissive: color, emissiveIntensity: 0.7, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide,
      });
      for (const sx of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), mat);
        wing.position.set(sx * 0.34, MOVE.height * 0.58, -0.18);
        wing.rotation.set(0.2, sx * -0.7, sx * 0.3);
        g.add(wing);
      }
      return g;
    },
  },

  crown: {
    label: "Spark Crown",
    particle: 0xffcf3a,
    build: () => {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xffd23b, emissive: 0xffcf3a, emissiveIntensity: 1.4 });
      const n = 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.13, 6), mat);
        spike.position.set(Math.cos(a) * 0.2, HEAD_Y + 0.3, Math.sin(a) * 0.2);
        g.add(spike);
      }
      return g;
    },
  },
};

export const ACCESSORY_LIST: { id: string; label: string }[] =
  Object.entries(ACCESSORIES).map(([id, a]) => ({ id, label: a.label }));

/** Head-height world offset where a particle accessory should emit. */
export const ACCESSORY_EMIT_Y = HEAD_Y + 0.4;
