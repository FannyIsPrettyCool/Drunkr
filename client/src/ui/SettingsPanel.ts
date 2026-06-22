import {
  settings,
  saveSettings,
  KEY_ACTIONS,
  type KeyAction,
  type Settings,
} from "../core/Settings.js";

/** Live-effect hooks so audio/graphics changes apply immediately where the
 *  relevant instances exist (lobby has music only; the game has music + sfx). */
export interface SettingsHooks {
  onMusicEnabled?: (on: boolean) => void;
  onMusicVol?: (v: number) => void; // 0–1
  onSfxVol?: (v: number) => void; // 0–1
  onQuality?: (q: Settings["quality"]) => void;
}

/** Pretty-print a KeyboardEvent.code for the rebind UI. */
function keyLabel(code: string): string {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return code.slice(5);
  const map: Record<string, string> = {
    Space: "Space", ShiftLeft: "L-Shift", ShiftRight: "R-Shift",
    ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl", AltLeft: "L-Alt", AltRight: "R-Alt",
    CapsLock: "Caps", Tab: "Tab", Enter: "Enter", Backquote: "`",
  };
  return map[code] ?? code;
}

/**
 * Self-contained settings UI (sensitivity, audio, graphics, key rebinding) that
 * reads and writes the shared `settings` object. Rendered identically in the
 * lobby tab and the in-game pause menu; both instances stay consistent because
 * they share `settings` — `refresh()` repaints from it when a menu is shown.
 */
export class SettingsPanel {
  private root: HTMLElement;
  private hooks: SettingsHooks;
  /** Action currently waiting for a key press, or null. */
  private rebinding: KeyAction | null = null;
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(container: HTMLElement, hooks: SettingsHooks = {}) {
    this.root = container;
    this.hooks = hooks;
    this.root.classList.add("settings-panel");
    this.build();
    this.refresh();
  }

  private build() {
    const rebindRows = KEY_ACTIONS.map(
      (a) =>
        `<div class="sp-key-row" data-action="${a.id}">` +
        `<span class="sp-key-label">${a.label}</span>` +
        `<button type="button" class="sp-key-btn"></button>` +
        `</div>`,
    ).join("");

    this.root.innerHTML = `
      <div class="sp-cols">
        <div class="sp-col">
          <div class="sp-section">
            <div class="sp-section-label">SENSITIVITY</div>
            <label class="field">LOOK <span data-v="sens">1.00</span>
              <input type="range" data-c="sens" min="0.2" max="3" step="0.05" />
            </label>
            <label class="field">SCOPED <span data-v="scoped">0.60</span>
              <input type="range" data-c="scoped" min="0.2" max="1.5" step="0.05" />
            </label>
          </div>
          <div class="sp-section">
            <div class="sp-section-label">AUDIO</div>
            <label class="check"><input type="checkbox" data-c="music-on" /> Music</label>
            <label class="field">MUSIC <span data-v="music">50</span>%
              <input type="range" data-c="music-vol" min="0" max="100" step="5" />
            </label>
            <label class="field">SFX <span data-v="sfx">80</span>%
              <input type="range" data-c="sfx-vol" min="0" max="100" step="5" />
            </label>
          </div>
        </div>
        <div class="sp-col">
          <div class="sp-section">
            <div class="sp-section-label">GRAPHICS</div>
            <label class="field">QUALITY
              <select data-c="quality">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label class="field">FRAME RATE
              <select data-c="fps">
                <option value="0">Unlimited</option>
                <option value="144">144</option>
                <option value="120">120</option>
                <option value="60">60</option>
              </select>
            </label>
            <label class="check"><input type="checkbox" data-c="showfps" /> Show FPS counter</label>
          </div>
        </div>
      </div>

      <div class="sp-section sp-controls">
        <div class="sp-section-label">CONTROLS</div>
        <div class="sp-key-grid">${rebindRows}</div>
        <p class="hint">Click a binding, then press a key. Esc cancels.</p>
      </div>
    `;

    this.wire();
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private wire() {
    const sens = this.q<HTMLInputElement>('[data-c="sens"]');
    sens.addEventListener("input", () => {
      settings.sensitivity = Number(sens.value);
      this.q('[data-v="sens"]').textContent = settings.sensitivity.toFixed(2);
      saveSettings();
    });

    const scoped = this.q<HTMLInputElement>('[data-c="scoped"]');
    scoped.addEventListener("input", () => {
      settings.scopedSens = Number(scoped.value);
      this.q('[data-v="scoped"]').textContent = settings.scopedSens.toFixed(2);
      saveSettings();
    });

    const musicOn = this.q<HTMLInputElement>('[data-c="music-on"]');
    musicOn.addEventListener("change", () => {
      settings.musicEnabled = musicOn.checked;
      this.hooks.onMusicEnabled?.(settings.musicEnabled);
      saveSettings();
    });

    const musicVol = this.q<HTMLInputElement>('[data-c="music-vol"]');
    musicVol.addEventListener("input", () => {
      const v = Number(musicVol.value);
      this.q('[data-v="music"]').textContent = String(v);
      settings.musicVolume = v / 100;
      this.hooks.onMusicVol?.(settings.musicVolume);
      saveSettings();
    });

    const sfxVol = this.q<HTMLInputElement>('[data-c="sfx-vol"]');
    sfxVol.addEventListener("input", () => {
      const v = Number(sfxVol.value);
      this.q('[data-v="sfx"]').textContent = String(v);
      settings.sfxVolume = v / 100;
      this.hooks.onSfxVol?.(settings.sfxVolume);
      saveSettings();
    });

    const quality = this.q<HTMLSelectElement>('[data-c="quality"]');
    quality.addEventListener("change", () => {
      settings.quality = quality.value as Settings["quality"];
      this.hooks.onQuality?.(settings.quality);
      saveSettings();
    });

    const fps = this.q<HTMLSelectElement>('[data-c="fps"]');
    fps.addEventListener("change", () => {
      settings.fpsCap = Number(fps.value);
      saveSettings();
    });

    const showfps = this.q<HTMLInputElement>('[data-c="showfps"]');
    showfps.addEventListener("change", () => {
      settings.showFps = showfps.checked;
      saveSettings();
    });

    for (const row of this.root.querySelectorAll<HTMLElement>(".sp-key-row")) {
      const action = row.dataset.action as KeyAction;
      row.querySelector("button")!.addEventListener("click", () => this.startRebind(action));
    }
  }

  private startRebind(action: KeyAction) {
    this.cancelRebind();
    this.rebinding = action;
    const btn = this.root.querySelector<HTMLElement>(`.sp-key-row[data-action="${action}"] .sp-key-btn`)!;
    btn.classList.add("listening");
    btn.textContent = "press…";

    // Capture phase + stopImmediatePropagation so this swallows the key before
    // the game's own keydown handlers (reload, weapon switch, etc.) can react.
    this.captureHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code !== "Escape") {
        settings.keymap[action] = e.code;
        saveSettings();
      }
      this.cancelRebind();
      this.refresh();
    };
    window.addEventListener("keydown", this.captureHandler, true);
  }

  private cancelRebind() {
    if (this.captureHandler) {
      window.removeEventListener("keydown", this.captureHandler, true);
      this.captureHandler = null;
    }
    this.rebinding = null;
    for (const btn of this.root.querySelectorAll<HTMLElement>(".sp-key-btn.listening")) {
      btn.classList.remove("listening");
    }
  }

  /** Repaint every control from the current `settings` (call when shown). */
  refresh() {
    this.cancelRebind();
    const set = (sel: string, val: string) => { this.q<HTMLInputElement>(sel).value = val; };

    set('[data-c="sens"]', String(settings.sensitivity));
    this.q('[data-v="sens"]').textContent = settings.sensitivity.toFixed(2);
    set('[data-c="scoped"]', String(settings.scopedSens));
    this.q('[data-v="scoped"]').textContent = settings.scopedSens.toFixed(2);

    this.q<HTMLInputElement>('[data-c="music-on"]').checked = settings.musicEnabled;
    set('[data-c="music-vol"]', String(Math.round(settings.musicVolume * 100)));
    this.q('[data-v="music"]').textContent = String(Math.round(settings.musicVolume * 100));
    set('[data-c="sfx-vol"]', String(Math.round(settings.sfxVolume * 100)));
    this.q('[data-v="sfx"]').textContent = String(Math.round(settings.sfxVolume * 100));

    set('[data-c="quality"]', settings.quality);
    set('[data-c="fps"]', String(settings.fpsCap));
    this.q<HTMLInputElement>('[data-c="showfps"]').checked = settings.showFps;

    for (const row of this.root.querySelectorAll<HTMLElement>(".sp-key-row")) {
      const action = row.dataset.action as KeyAction;
      row.querySelector(".sp-key-btn")!.textContent = keyLabel(settings.keymap[action]);
    }
  }
}
