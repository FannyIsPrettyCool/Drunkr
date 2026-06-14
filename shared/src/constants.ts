/** Server simulation tick rate (Hz). */
export const TICK_RATE = 60;
/** How often the server broadcasts world snapshots to clients (Hz). */
export const SNAPSHOT_RATE = 33;
/** How often each client sends its state to the server (Hz). */
export const CLIENT_SEND_RATE = 33;

/**
 * Movement tuning (units = meters). The model is Quake/Source style:
 * friction + accelerate on the ground, a capped air-strafe accelerate in the
 * air. This is what makes bunny-hopping and air-strafing possible.
 */
export const MOVE = {
  /** Target horizontal ground speed (m/s). */
  speed: 9,
  /** Ground acceleration (higher = snappier). */
  groundAccel: 11,
  /** Air acceleration applied along the wish direction. */
  airAccel: 14,
  /**
   * Air speed cap: the most the air-strafe accelerate can add *along the wish
   * direction*. Keeping this small is the trick behind bhop — strafing turns
   * the wish dir perpendicular to your velocity, so you keep gaining speed.
   */
  airCap: 1.2,
  /**
   * Ground friction (per second). High so the player stops crisply on the
   * ground (no ice) — momentum is only kept in the air / on bhop landings.
   */
  friction: 12,
  /** Speed below which friction uses this as its control value (snappy stops). */
  stopSpeed: 4,
  gravity: 26,
  jumpVelocity: 8.2,
  /** Eye height above the player's feet. */
  eyeHeight: 1.6,
  /** Eye height while crouching. */
  crouchEyeHeight: 1.0,
  /** Collision capsule radius. */
  radius: 0.4,
  /** Total player height (feet to crown). */
  height: 1.8,
};

/** Crouch-slide tuning. A slide commits your direction and bleeds momentum. */
export const SLIDE = {
  /** Minimum ground speed (m/s) needed to start a slide. */
  minSpeed: 7,
  /** Speed the slide snaps you to on initiation (gives a small boost). */
  boost: 13,
  /** Slide ends once you decelerate below this. */
  endSpeed: 5,
  /** Slide friction — low (keeps momentum) but enough to gradually slow you. */
  friction: 4.5,
  /** Only a slight steer is allowed mid-slide (you're mostly committed). */
  steer: 1.2,
  /** Max slide duration (s) before it auto-ends. */
  duration: 1.1,
};

/** Dash ability tuning. */
export const DASH = {
  /** Horizontal burst speed (m/s). */
  speed: 18,
  cooldownMs: 4000,
};

/** Server match settings. */
export const MATCH = {
  /** Round length (ms). Highest kills at time wins; then it restarts. */
  durationMs: 10 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Classes & abilities
// ---------------------------------------------------------------------------

export type AbilityId =
  | "dash" | "updraft" | "invis" | "confusion" | "flash" | "frag"
  | "blink" | "fortify" | "shockwave";

export interface AbilityDef {
  id: AbilityId;
  name: string;
  cooldownMs: number;
  /** True if the server must process it (vs a purely client-side movement). */
  server: boolean;
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  dash: { id: "dash", name: "Dash", cooldownMs: DASH.cooldownMs, server: false },
  updraft: { id: "updraft", name: "Updraft", cooldownMs: 5000, server: false },
  invis: { id: "invis", name: "Cloak", cooldownMs: 15000, server: true },
  confusion: { id: "confusion", name: "Confuse", cooldownMs: 12000, server: true },
  flash: { id: "flash", name: "Flash", cooldownMs: 9000, server: true },
  frag: { id: "frag", name: "Frag", cooldownMs: 13000, server: true },
  blink: { id: "blink", name: "Blink", cooldownMs: 6000, server: false },
  fortify: { id: "fortify", name: "Fortify", cooldownMs: 12000, server: true },
  shockwave: { id: "shockwave", name: "Shockwave", cooldownMs: 10000, server: true },
};

export interface ClassDef {
  id: string;
  name: string;
  /** Primary (F) and secondary (C) ability ids. */
  F: AbilityId;
  C: AbilityId;
}

export const CLASSES: Record<string, ClassDef> = {
  wind: { id: "wind", name: "Wind Master", F: "dash", C: "updraft" },
  illusionist: { id: "illusionist", name: "Illusionist", F: "invis", C: "confusion" },
  cyborg: { id: "cyborg", name: "Cyborg", F: "flash", C: "frag" },
  juggernaut: { id: "juggernaut", name: "Juggernaut", F: "fortify", C: "shockwave" },
  phantom: { id: "phantom", name: "Phantom", F: "blink", C: "invis" },
};
export const CLASS_IDS = Object.keys(CLASSES);
export const DEFAULT_CLASS = "wind";

export const INVIS = { durationMs: 3000, speedMul: 1.4 };
export const CONFUSION = { radius: 13 };
export const UPDRAFT = { vy: 13 };
export const BLINK = { dist: 11 };
/** Juggernaut Fortify: heal to full plus this much temporary overheal. */
export const FORTIFY = { overheal: 50 };
/** Juggernaut Shockwave: AoE damage burst around you (+ a small self-leap). */
export const SHOCKWAVE = { radius: 7, damage: 65, selfVy: 9 };
export const GRENADE = {
  fuseMs: 1400,
  speed: 24,
  gravity: 20,
  /** Velocity retained after a bounce. */
  bounce: 0.5,
  radius: 0.25,
  flashRadius: 26,
  /** Full-blind duration; the white screen holds then fades over this. */
  flashBlindMs: 3000,
  fragRadius: 11,
  fragDamage: 130,
};

export const PLAYER = {
  maxHealth: 100,
  respawnDelayMs: 2000,
};

/** Weapon definitions. */
export interface WeaponDef {
  id: string;
  name: string;
  damage: number;
  /** Rounds per minute. */
  fireRate: number;
  magazine: number;
  reloadMs: number;
  /** Max effective range (m) for the hitscan ray. */
  range: number;
  /** Random spread cone half-angle in radians when hip-firing. */
  spread: number;
  /** Headshot damage multiplier. */
  headshotMul: number;
  /** Full-auto (hold to fire) vs semi-auto (one shot per click). */
  auto: boolean;
  /** Has a scope: aiming down sights zooms the view. */
  scoped?: boolean;
  /** Vertical FOV (degrees) while scoped. */
  zoomFov?: number;
  /** Extra spread applied when firing a scoped weapon from the hip. */
  hipPenalty?: number;
  /** Pellets fired per shot (shotgun). Each is an independent ray. */
  pellets?: number;
  /** Impulse (m/s) applied to the shooter opposite the aim dir (rocket-jump). */
  selfKnockback?: number;
  /** Melee weapon: short range, swing instead of hitscan tracer. */
  melee?: boolean;
  /** Movement speed multiplier while this weapon is equipped. */
  speedMul?: number;
  /** Grants an extra mid-air jump while equipped. */
  doubleJump?: boolean;
  /** Switch slot / hotkey hint. */
  slot: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  // The default full-auto assault rifle.
  ak: {
    id: "ak",
    name: "AK-44",
    damage: 24,
    fireRate: 600,
    magazine: 30,
    reloadMs: 1600,
    range: 220,
    spread: 0.013,
    headshotMul: 2.0,
    auto: true,
    slot: 1,
  },
  // Lever-action scoped sniper: one shot, one kill.
  sniper: {
    id: "sniper",
    name: "LVR-50",
    damage: 110,
    fireRate: 55,
    magazine: 1,
    reloadMs: 1100,
    range: 320,
    spread: 0.0,
    headshotMul: 1.5,
    auto: false,
    scoped: true,
    zoomFov: 26,
    hipPenalty: 0.08,
    slot: 2,
  },
  // Double-barrel shotgun: a wall of pellets up close, and the recoil throws
  // you — aim at your feet to rocket-jump, or in front to dash back.
  shotgun: {
    id: "shotgun",
    name: "DB-12",
    damage: 17,
    fireRate: 170,
    magazine: 2,
    reloadMs: 1500,
    range: 34,
    spread: 0.085,
    headshotMul: 1.25,
    auto: false,
    pellets: 9,
    selfKnockback: 17,
    slot: 3,
  },
  // Neon katana: a melee one-shot that makes you faster and grants a double
  // jump — a pure movement/assassination tool.
  katana: {
    id: "katana",
    name: "NEON-EDGE",
    damage: 200,
    fireRate: 130,
    magazine: 0,
    reloadMs: 0,
    range: 3.4,
    spread: 0,
    headshotMul: 1,
    auto: false,
    melee: true,
    speedMul: 1.35,
    doubleJump: true,
    slot: 4,
  },
};

export const DEFAULT_WEAPON = "ak";
export const WEAPON_IDS = Object.keys(WEAPONS);
/** Weapons a player can carry/switch to (katana is always available via Q). */
export const LOADOUT_WEAPONS = ["ak", "sniper", "shotgun"];
