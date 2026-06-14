/**
 * Keyboard + mouse input with pointer lock. Tracks held keys and accumulates
 * mouse-look deltas to be consumed once per frame.
 */
export class Input {
  private keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  locked = false;

  onShoot: (() => void) | null = null;
  onReload: (() => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Weapon switch request by id. */
  onSwitch: ((weapon: string) => void) | null = null;
  /** Dash ability key. */
  onDash: (() => void) | null = null;

  private mouseDown = false;
  private rightDown = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "KeyR") this.onReload?.();
      if (e.code === "Digit1") this.onSwitch?.("ak");
      if (e.code === "Digit2") this.onSwitch?.("sniper");
      if (e.code === "Digit3") this.onSwitch?.("shotgun");
      if (e.code === "KeyQ") this.onSwitch?.("katana");
      if (e.code === "KeyF") this.onDash?.();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    // Right-click aims down sights; suppress the context menu.
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
      if (!this.locked) this.mouseDown = false;
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

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
    this.canvas.requestPointerLock();
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
    if (this.isDown("KeyW")) z -= 1;
    if (this.isDown("KeyS")) z += 1;
    if (this.isDown("KeyA")) x -= 1;
    if (this.isDown("KeyD")) x += 1;
    return { x, z };
  }

  get jumping(): boolean {
    return this.isDown("Space");
  }

  get crouching(): boolean {
    return this.isDown("ShiftLeft") || this.isDown("ShiftRight") || this.isDown("KeyC");
  }

  get showScores(): boolean {
    return this.isDown("Tab");
  }

  /** Returns and clears the accumulated mouse delta. */
  consumeMouse(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}
