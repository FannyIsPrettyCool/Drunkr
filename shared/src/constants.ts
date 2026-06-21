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
  /** Air acceleration applied along the wish direction. Higher = air-strafing
   * redirects (and builds speed) faster, so good strafe timing is rewarded. */
  airAccel: 20,
  /**
   * Air speed cap: the most the air-strafe accelerate can add *along the wish
   * direction*. Keeping this small is the trick behind bhop — strafing turns
   * the wish dir perpendicular to your velocity, so you keep gaining speed. The
   * bigger this is the more each well-timed strafe adds (skill reward).
   */
  airCap: 1.8,
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
  /** Speed multiplier while crouch-walking (slower than standing). */
  crouchSpeedMul: 0.5,
  /** Collision capsule radius. */
  radius: 0.4,
  /** Total player height (feet to crown). */
  height: 1.8,
  /** Knife-in-air thrust: while airborne with the katana out you accelerate
   * along your current heading (rewards aggressive knife movement), up to a
   * higher air speed than other weapons allow. */
  knifeAirAccel: 14,
  knifeAirMax: 28,
  /** Normal step-up height (walk up small ledges without jumping). */
  stepHeight: 0.55,
  /** Crouch-jump step-up: while crouched in the air you tuck your legs and can
   * mantle onto ledges that are otherwise just out of reach (CS/Valorant-style
   * crouch-jump). */
  crouchStepHeight: 0.95,
};

/** Crouch-slide tuning. A slide commits your direction and bleeds momentum. */
export const SLIDE = {
  /** Minimum ground speed (m/s) needed to start a slide. */
  minSpeed: 6,
  /** Speed the slide snaps you to on initiation (a clear boost over run speed). */
  boost: 15,
  /** Slide ends once you decelerate below this. */
  endSpeed: 3.5,
  /** Slide friction — low so the slide keeps momentum and lasts. */
  friction: 1.3,
  /** Only a slight steer is allowed mid-slide (you're mostly committed). */
  steer: 1.2,
  /** Max slide duration (s) before it auto-ends. */
  duration: 1.5,
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
  durationMs: 600_000,
  /** Intermission + map vote duration (ms) between rounds. */
  intermissionMs: 15_000,
};

/** Bomb defusal mode constants. */
export const BOMB = {
  plantTime: 3.2,       // seconds to plant
  defuseTime: 5.0,      // seconds to defuse
  fuseMs: 40_000,       // ms until detonation after plant
  roundMs: 105_000,     // 1:45 round duration
  switchAt: 15,         // switch sides after this many rounds
  maxRounds: 30,
  explodeDamage: 500,   // one-hit kill
  explodeRadius: 60,    // units
  proximityRadius: 4,   // max distance to plant/defuse
};

// ---------------------------------------------------------------------------
// Classes & abilities
// ---------------------------------------------------------------------------

export type AbilityId =
  | "dash" | "updraft" | "invis" | "confusion" | "flash" | "frag"
  | "blink" | "fortify" | "shockwave" | "bloodlust" | "siphon"
  // New abilities (see the classes below).
  | "grapple" | "wallkick" | "slipstream" | "recall" | "timebubble"
  | "pull" | "reflect" | "repulse" | "decoy";

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
  bloodlust: { id: "bloodlust", name: "Bloodlust", cooldownMs: 11000, server: true },
  siphon: { id: "siphon", name: "Siphon", cooldownMs: 9000, server: true },
  // --- New abilities ---
  grapple: { id: "grapple", name: "Grapple", cooldownMs: 6000, server: false },
  wallkick: { id: "wallkick", name: "Wall Kick", cooldownMs: 2500, server: false },
  slipstream: { id: "slipstream", name: "Slipstream", cooldownMs: 7000, server: false },
  recall: { id: "recall", name: "Recall", cooldownMs: 12000, server: true },
  timebubble: { id: "timebubble", name: "Time Bubble", cooldownMs: 13000, server: true },
  pull: { id: "pull", name: "Pull", cooldownMs: 9000, server: true },
  reflect: { id: "reflect", name: "Reflect", cooldownMs: 10000, server: true },
  repulse: { id: "repulse", name: "Repulse", cooldownMs: 9000, server: true },
  decoy: { id: "decoy", name: "Decoy", cooldownMs: 12000, server: true },
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
  vampire: { id: "vampire", name: "Vampire", F: "bloodlust", C: "siphon" },
  // --- New classes ---
  slinger: { id: "slinger", name: "Slinger", F: "grapple", C: "dash" },
  skater: { id: "skater", name: "Skater", F: "wallkick", C: "slipstream" },
  vaulter: { id: "vaulter", name: "Vaulter", F: "dash", C: "blink" },
  chronos: { id: "chronos", name: "Chronos", F: "recall", C: "timebubble" },
  magnetar: { id: "magnetar", name: "Magnetar", F: "pull", C: "frag" },
  bulwark: { id: "bulwark", name: "Bulwark", F: "reflect", C: "repulse" },
  mirage: { id: "mirage", name: "Mirage", F: "decoy", C: "blink" },
  saboteur: { id: "saboteur", name: "Saboteur", F: "confusion", C: "flash" },
};
export const CLASS_IDS = Object.keys(CLASSES);
/** Classes the bots are allowed to roll (only those with bot-safe abilities —
 * the new movement abilities are client-driven and would no-op for a bot). */
export const BOT_CLASS_IDS = ["wind", "illusionist", "cyborg", "juggernaut", "phantom", "vampire"];
export const DEFAULT_CLASS = "wind";

export const INVIS = { durationMs: 3000, speedMul: 1.4 };
export const CONFUSION = { radius: 13 };
export const UPDRAFT = { vy: 13 };
export const BLINK = { dist: 11 };
/** Juggernaut Fortify: heal to full plus this much temporary overheal. */
export const FORTIFY = { overheal: 50 };
/**
 * Juggernaut Shockwave: a launch-then-slam. Casting flings you dramatically
 * forward + up; the AoE damage burst happens where you LAND (the slam), not on
 * takeoff — so it doubles as a gap-closer and a ground-pound.
 */
export const SHOCKWAVE = { radius: 8, damage: 70, launchForward: 17, launchUp: 12.5 };
/**
 * Vampire Bloodlust: a timed buff where the damage you deal heals you (lifesteal),
 * can briefly overheal, and you move a bit faster while it's active.
 */
export const BLOODLUST = { durationMs: 5000, lifestealPct: 0.6, maxOverheal: 40, speedMul: 1.15 };
/**
 * Vampire Siphon: an instant AoE life-drain around you — damages nearby enemies
 * and heals you per enemy hit (overheal up to maxOverheal).
 */
export const SIPHON = { radius: 9, damage: 40, healPerHit: 22, maxOverheal: 50 };

// --- New ability tuning ---
/** Slinger Grapple: hook a surface you're looking at and reel toward it. */
export const GRAPPLE = { range: 42, pull: 40, minDist: 2.5, durationMs: 650, up: 2 };
/** Skater Wall Kick: shove off a nearby wall while airborne. */
export const WALLKICK = { range: 1.5, push: 13, up: 7.5 };
/** Skater Slipstream: snap to a strong forward momentum burst along your heading. */
export const SLIPSTREAM = { boost: 27, up: 1.5 };
/** Chronos Recall: rewind to where you were a moment ago and heal a little. */
export const RECALL = { rewindMs: 2500, heal: 35 };
/** Chronos Time Bubble: slow enemies caught in the radius for a few seconds. */
export const TIMEBUBBLE = { radius: 12, mul: 0.45, durationMs: 2600 };
/** Magnetar Pull: yank nearby enemies toward you. */
export const PULL = { radius: 15, strength: 24, up: 4 };
/** Bulwark Reflect: brief window that bounces incoming damage back at attackers. */
export const REFLECT = { durationMs: 1200 };
/** Bulwark Repulse: launch nearby enemies away from you. */
export const REPULSE = { radius: 10, strength: 22, up: 7 };
/** Mirage Decoy: a holographic clone that sprints forward to draw fire. */
export const DECOY = { speed: 10, durationMs: 3500 };
export const GRENADE = {
  fuseMs: 1400,
  speed: 24,
  gravity: 20,
  /** Velocity retained after a bounce. */
  bounce: 0.5,
  radius: 0.25,
  flashRadius: 40,
  /** Full-blind duration; the white screen holds then fades over this. */
  flashBlindMs: 2500,
  fragRadius: 11,
  fragDamage: 130,
};

export const PLAYER = {
  maxHealth: 100,
  respawnDelayMs: 2000,
  /** Spawn-protection (invincibility) window after respawning. Drops instantly
   * the moment the protected player fires. */
  spawnProtectMs: 2500,
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
    reloadMs: 1300,
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
    reloadMs: 800,
    range: 320,
    spread: 0.0,
    headshotMul: 1.5,
    auto: false,
    scoped: true,
    zoomFov: 26,
    hipPenalty: 0.012,
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
    reloadMs: 1200,
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
    speedMul: 1.5,
    doubleJump: true,
    slot: 4,
  },
};

export const DEFAULT_WEAPON = "ak";
export const WEAPON_IDS = Object.keys(WEAPONS);
/** Weapons a player can carry/switch to (katana is always available via Q). */
export const LOADOUT_WEAPONS = ["ak", "sniper", "shotgun"];
