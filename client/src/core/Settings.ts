export interface Settings {
  /** Mouse look sensitivity multiplier. */
  sensitivity: number;
  /** Multiplier applied on top while scoped (sniper ADS). */
  scopedSens: number;
  /** Internal render resolution tier. */
  quality: "low" | "medium" | "high";
  /** Frame cap (0 = unlimited). Stand-in for vsync/refresh selection. */
  fpsCap: number;
  /** Show the FPS counter. */
  showFps: boolean;
  /** Background music volume (0–1). */
  musicVolume: number;
  /** Whether background music is enabled. */
  musicEnabled: boolean;
}

export const QUALITY_HEIGHT: Record<Settings["quality"], number> = {
  low: 240,
  medium: 360,
  high: 540,
};

const DEFAULTS: Settings = {
  sensitivity: 1,
  scopedSens: 0.6,
  quality: "medium",
  fpsCap: 0,
  showFps: false,
  musicVolume: 0.5,
  musicEnabled: true,
};

const KEY = "drunkr.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

/** Live, shared settings object. Mutate it and call `saveSettings()`. */
export const settings: Settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
