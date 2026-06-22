import { settings } from "../core/Settings.js";

/**
 * Keyboard + mouse input with pointer lock. Tracks held keys and accumulates
 * mouse-look deltas to be consumed once per frame. Key bindings are read live
 * from `settings.keymap` so the rebind UI takes effect immediately.
 */
export class Input {
  private keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  /** Accumulated wheel delta, converted into discrete notches. */
  private wheelAccum = 0;
  locked = false;

  onShoot: (() => void) | null = null;
  onReload: (() => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Weapon switch request by id. */
  onSwitch: ((weapon: string) => void) | null = null;
  /** Scroll-wheel weapon cycle: +1 = next, -1 = previous. */
  onCycle: ((dir: 1 | -1) => void) | null = null;
  /** Ability key (F = primary, C = secondary). */
  onAbility: ((slot: "F" | "C") => void) | null = null;
  /** Inspect-weapon key (local cosmetic animation). */
  onInspect: (() => void) | null = null;

  private mouseDown = false;
  private rightDown = false;

  /** Live keymap binding for an action. */
  private key(action: keyof typeof settings.keymap): string {
    return settings.keymap[action];
  }

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      // Tab would focus the next DOM element and drop pointer lock — swallow it.
      if (e.code === "Tab") { e.preventDefault(); return; }
      const km = settings.keymap;
      if (e.code === km.reload) this.onReload?.();
      if (e.code === km.weapon1) this.onSwitch?.("ak");
      if (e.code === km.weapon2) this.onSwitch?.("sniper");
      if (e.code === km.weapon3) this.onSwitch?.("shotgun");
      if (e.code === km.melee) this.onSwitch?.("katana");
      if (e.code === km.abilityF && !e.repeat) this.onAbility?.("F");
      if (e.code === km.abilityC && !e.repeat) this.onAbility?.("C");
      if (e.code === km.inspect && !e.repeat) this.onInspect?.();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    // Right-click aims down sights; suppress the context menu.
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
      if (!this.locked) {
        this.mouseDown = false;
        this.rightDown = false;
        this.keys.clear(); // don't let held keys (e.g. CapsLock) stick
      }
      // Drop any accumulated look delta so re-locking doesn't snap the view.
      this.mouseDX = 0;
      this.mouseDY = 0;
    });
    // If the window loses focus we never get keyup; clear everything.
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseDown = false;
      this.rightDown = false;
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      // Pointer-lock occasionally emits a huge bogus delta (on re-lock, alt-tab,
      // OS pointer warp). Drop those so the view doesn't snap to a new place.
      if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    // Scroll wheel cycles weapons. Accumulate so trackpads (many tiny deltas)
    // and notched wheels both produce one switch per "notch".
    document.addEventListener("wheel", (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheelAccum += e.deltaY;
      const NOTCH = 40;
      while (Math.abs(this.wheelAccum) >= NOTCH) {
        const dir: 1 | -1 = this.wheelAccum > 0 ? 1 : -1;
        this.wheelAccum -= dir * NOTCH;
        this.onCycle?.(dir);
      }
    }, { passive: false });

    document.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.rightDown = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.rightDown = false;
    });
  }

  requestLock() {
    // unadjustedMovement bypasses OS pointer acceleration — without it Firefox
    // applies acceleration to pointer-lock deltas, causing jitter vs Chromium.
    this.canvas.requestPointerLock({ unadjustedMovement: true })
      .catch(() => this.canvas.requestPointerLock());
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  get firing(): boolean {
    return this.mouseDown;
  }

  /** Aiming down sights (right mouse held). */
  get ads(): boolean {
    return this.rightDown && this.locked;
  }

  /** Movement intent in local space: x = strafe, z = forward. */
  moveAxis(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.isDown(this.key("moveForward"))) z -= 1;
    if (this.isDown(this.key("moveBack"))) z += 1;
    if (this.isDown(this.key("moveLeft"))) x -= 1;
    if (this.isDown(this.key("moveRight"))) x += 1;
    return { x, z };
  }

  get jumping(): boolean {
    return this.isDown(this.key("jump"));
  }

  get crouching(): boolean {
    // Honour the bound crouch key; still accept the other Shift for comfort.
    return this.isDown(this.key("crouch")) || this.isDown("ShiftRight");
  }

  get useHeld(): boolean {
    return this.isDown(this.key("use"));
  }

  get showScores(): boolean {
    return this.keys.has(this.key("scoreboard"));
  }

  /** Returns and clears the accumulated mouse delta. */
  consumeMouse(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}
