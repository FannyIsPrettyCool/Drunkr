/** Server simulation tick rate (Hz). */
export const TICK_RATE = 60;
/** How often the server broadcasts world snapshots to clients (Hz). */
export const SNAPSHOT_RATE = 20;
/** How often each client sends its state to the server (Hz). */
export const CLIENT_SEND_RATE = 30;

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
  },
};

export const DEFAULT_WEAPON = "ak";
export const WEAPON_IDS = Object.keys(WEAPONS);
