/** Rebindable gameplay actions. Values stored in `keymap` are KeyboardEvent.code. */
export type KeyAction =
  | "moveForward" | "moveBack" | "moveLeft" | "moveRight"
  | "jump" | "crouch" | "reload"
  | "weapon1" | "weapon2" | "weapon3" | "melee"
  | "abilityF" | "abilityC"
  | "inspect"
  | "chat" | "scoreboard" | "use";

/** Display order + human labels for the rebind UI. */
export const KEY_ACTIONS: { id: KeyAction; label: string }[] = [
  { id: "moveForward", label: "Move Forward" },
  { id: "moveBack", label: "Move Back" },
  { id: "moveLeft", label: "Move Left" },
  { id: "moveRight", label: "Move Right" },
  { id: "jump", label: "Jump" },
  { id: "crouch", label: "Crouch / Slide" },
  { id: "reload", label: "Reload" },
  { id: "weapon1", label: "Weapon 1 (AK)" },
  { id: "weapon2", label: "Weapon 2 (Sniper)" },
  { id: "weapon3", label: "Weapon 3 (Shotgun)" },
  { id: "melee", label: "Melee (Katana)" },
  { id: "abilityF", label: "Ability F" },
  { id: "abilityC", label: "Ability C" },
  { id: "inspect", label: "Inspect Weapon" },
  { id: "chat", label: "Chat" },
  { id: "scoreboard", label: "Scoreboard" },
  { id: "use", label: "Use / Plant / Defuse" },
];

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
  /** Sound-effects volume (0–1). */
  sfxVolume: number;
  /** Action → KeyboardEvent.code bindings. */
  keymap: Record<KeyAction, string>;
}

export const DEFAULT_KEYMAP: Record<KeyAction, string> = {
  moveForward: "KeyW",
  moveBack: "KeyS",
  moveLeft: "KeyA",
  moveRight: "KeyD",
  jump: "Space",
  crouch: "ShiftLeft",
  reload: "KeyR",
  weapon1: "Digit1",
  weapon2: "Digit2",
  weapon3: "Digit3",
  melee: "KeyQ",
  abilityF: "KeyF",
  abilityC: "KeyC",
  inspect: "KeyT",
  chat: "KeyY",
  scoreboard: "CapsLock",
  use: "KeyE",
};

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
  sfxVolume: 0.8,
  keymap: { ...DEFAULT_KEYMAP },
};

const KEY = "drunkr.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      // Deep-merge keymap so new actions appear for existing users.
      return {
        ...DEFAULTS,
        ...saved,
        keymap: { ...DEFAULT_KEYMAP, ...(saved.keymap ?? {}) },
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS, keymap: { ...DEFAULT_KEYMAP } };
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
