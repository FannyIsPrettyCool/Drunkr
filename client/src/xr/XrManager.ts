import * as THREE from "three";

/**
 * WebXR support for the immersive-VR path. Owns the XR session, the motion
 * controllers, and the VR control scheme, and exposes the same movement-intent
 * surface the desktop `Input` does so the game loop can treat them alike.
 *
 * Camera model: the camera lives inside `rig` (see Renderer). The headset drives
 * the camera's local pose; we position the rig at the player's feet and rotate
 * it with snap-turn (bodyYaw). "Where you look" (head world yaw) is fed back to
 * the player simulation each frame so locomotion is head-relative.
 *
 * WebXR DOM types aren't in our lib set, so session/input-source/gamepad objects
 * are intentionally loosely typed.
 */

export interface XrCallbacks {
  /** Session started — set up VR mode (gun-in-hand, audio, HUD). */
  onEnter: () => void;
  /** Session ended — restore the desktop path. */
  onExit: () => void;
  /** The right controller is ready; mount the weapon in it. */
  onRightHand: (controller: THREE.Object3D) => void;
  onReload: () => void;
  /** Cycle to the next weapon (no number keys in VR). */
  onSwitchCycle: () => void;
  onAbility: (slot: "F" | "C") => void;
}

/** Thumbstick deadzone and snap-turn step. */
const DEADZONE = 0.2;
const SNAP_TURN = Math.PI / 4;
const MAX_VIGNETTE = 0.55;

// xr-standard gamepad button indices (Quest/Touch and most 6DoF controllers).
const BTN_TRIGGER = 0;
const BTN_GRIP = 1;
const BTN_STICK = 3;
const BTN_PRIMARY = 4; // A / X
const BTN_SECONDARY = 5; // B / Y

type Controller = { obj: THREE.Object3D; hand: "left" | "right" | "none" };

export class XrManager {
  presenting = false;

  private bodyYaw = 0;
  private controllers: Controller[] = [];
  private rightObj: THREE.Object3D | null = null;
  private leftObj: THREE.Object3D | null = null;
  private leftMarker: THREE.Object3D | null = null;

  // Polled control state (read by the game loop).
  private mv = { x: 0, z: 0 };
  private _jump = false;
  private _crouch = false;
  private _fire = false;
  private _use = false;
  private _scores = false;

  // Rising-edge latches for one-shot actions.
  private prev: Record<string, boolean> = {};

  private vignette: THREE.Mesh;
  private vignetteTarget = 0;
  private vignetteOpacity = 0;
  private button: HTMLButtonElement | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private rig: THREE.Group,
    private camera: THREE.PerspectiveCamera,
    private cb: XrCallbacks,
  ) {
    const xr = this.renderer.xr;
    xr.enabled = true;
    // Proactively move the GL context onto the XR-compatible GPU now (at game
    // start), so entering a session later doesn't trigger a context-losing GPU
    // switch. Complements the xrCompatible flag set at context creation.
    const gl = this.renderer.getContext() as { makeXRCompatible?: () => Promise<void> };
    gl.makeXRCompatible?.().catch(() => { /* no XR device / already compatible */ });
    try {
      xr.setReferenceSpaceType("local-floor");
    } catch {
      /* older runtimes default to local; height will just be off a bit */
    }
    // Headset resolution = native (1.0). Don't reduce it — keep this variable out
    // of the rendering path while we get display working.
    (xr as unknown as { setFramebufferScaleFactor?: (n: number) => void }).setFramebufferScaleFactor?.(1.0);

    // Two controllers, parented to the rig so they move with the player.
    for (let i = 0; i < 2; i++) {
      const obj = xr.getController(i);
      this.rig.add(obj);
      const entry: Controller = { obj, hand: "none" };
      const anyObj = obj as unknown as { addEventListener: (t: string, cb: (e: { data?: { handedness?: string } }) => void) => void };
      anyObj.addEventListener("connected", (e) => {
        entry.hand = (e.data?.handedness as Controller["hand"]) ?? "none";
        this.assignHands();
      });
      anyObj.addEventListener("disconnected", () => {
        entry.hand = "none";
        this.assignHands();
      });
      this.controllers.push(entry);
    }

    xr.addEventListener("sessionstart", () => {
      this.presenting = true;
      this.bodyYaw = 0;
      this.rig.rotation.set(0, 0, 0);
      const attrs = this.renderer.getContext().getContextAttributes?.();
      console.log("[VR] session start — xrCompatible:", attrs?.xrCompatible,
        "isPresenting:", (xr as unknown as { isPresenting?: boolean }).isPresenting);
      // Verify which compositing path three actually chose. A real baseLayer with
      // sane dimensions = the classic XRWebGLLayer path (what we want). "NONE"
      // means three is on the XRProjectionLayer path despite our request.
      const sess = (xr as unknown as {
        getSession?: () => { renderState?: { baseLayer?: { framebufferWidth?: number; framebufferHeight?: number; framebuffer?: unknown }; layers?: unknown[] } } | null;
      }).getSession?.();
      const bl = sess?.renderState?.baseLayer;
      console.log("[VR] baseLayer:", bl
        ? { w: bl.framebufferWidth, h: bl.framebufferHeight, hasFB: !!bl.framebuffer }
        : "NONE — projection-layer path", "layers:", sess?.renderState?.layers?.length ?? 0);
      if (this.button) this.button.textContent = "EXIT VR";
      this.cb.onEnter();
    });
    xr.addEventListener("sessionend", () => {
      this.presenting = false;
      this.vignetteOpacity = 0;
      (this.vignette.material as THREE.Material).opacity = 0;
      this.vignette.visible = false;
      if (this.button) this.button.textContent = "ENTER VR";
      this.cb.onExit();
    });

    this.setupButton();

    // Comfort vignette: an annulus that darkens the periphery during locomotion.
    this.vignette = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 3.0, 48),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      }),
    );
    this.vignette.position.set(0, 0, -0.6);
    this.vignette.renderOrder = 999;
    this.vignette.visible = false;
    this.camera.add(this.vignette);
  }

  /**
   * Add an "ENTER VR" button (only when immersive-VR is supported). We request
   * the session ourselves instead of using three's VRButton because VRButton
   * hard-codes the `layers` feature, which makes three use the XRProjectionLayer
   * path — that fails to composite on some SteamVR/Chrome builds (a black headset
   * even though frames render). Omitting `layers` keeps three on the classic,
   * widely-compatible XRWebGLLayer path.
   */
  private setupButton() {
    const xrNav = (navigator as unknown as {
      xr?: { isSessionSupported?: (m: string) => Promise<boolean> };
    }).xr;
    xrNav?.isSessionSupported?.("immersive-vr").then((ok) => {
      if (!ok) return;
      const b = document.createElement("button");
      b.id = "VRButton";
      b.textContent = "ENTER VR";
      Object.assign(b.style, {
        position: "absolute", bottom: "20px", left: "calc(50% - 60px)", width: "120px",
        padding: "12px 6px", border: "1px solid #18e0ff", borderRadius: "4px",
        background: "rgba(5,6,12,0.6)", color: "#18e0ff",
        font: "bold 13px monospace", letterSpacing: "0.12em", textAlign: "center",
        cursor: "pointer", zIndex: "999",
      } as Partial<CSSStyleDeclaration>);
      b.onclick = () => void this.toggleSession();
      document.body.appendChild(b);
      this.button = b;
    }).catch(() => { /* no XR */ });
  }

  private async toggleSession() {
    const xr = this.renderer.xr as unknown as {
      getSession?: () => { end?: () => void } | null;
      setSession?: (s: unknown) => Promise<void>;
    };
    if (this.presenting) {
      xr.getSession?.()?.end?.();
      return;
    }
    const xrNav = (navigator as unknown as {
      xr?: { requestSession?: (m: string, o?: unknown) => Promise<unknown> };
    }).xr;
    if (!xrNav?.requestSession) return;
    try {
      // Switch the drawing buffer to full resolution before presenting. The
      // desktop uses a tiny low-res buffer (CSS-upscaled pixelation), which is an
      // unusual setup that can desync the XR layer framebuffer / mirror. Safe to
      // call here — the session isn't presenting yet, so setSize isn't blocked.
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      // No `layers` — forces three's classic XRWebGLLayer compositing path.
      const session = await xrNav.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"],
      });
      await xr.setSession?.(session);
    } catch (e) {
      console.warn("[VR] requestSession failed", e);
    }
  }

  /** Decide which controller is the gun hand and wire up laser + left marker. */
  private assignHands() {
    const right = this.controllers.find((c) => c.hand === "right")
      ?? this.controllers.find((c) => c.hand === "none");
    const left = this.controllers.find((c) => c.hand === "left")
      ?? this.controllers.find((c) => c !== right && c.hand === "none");

    if (right && right.obj !== this.rightObj) {
      this.rightObj = right.obj;
      this.addAimLaser(right.obj);
      this.cb.onRightHand(right.obj);
    }
    if (left && left.obj !== this.leftObj) {
      this.leftObj = left.obj;
      this.addLeftMarker(left.obj);
    }
  }

  private addAimLaser(obj: THREE.Object3D) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x18e0ff, transparent: true, opacity: 0.5,
    }));
    line.scale.z = 40;
    obj.add(line);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2d9b }),
    );
    dot.position.set(0, 0, -3);
    obj.add(dot);
  }

  private addLeftMarker(obj: THREE.Object3D) {
    if (this.leftMarker) this.leftMarker.removeFromParent();
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x16182a, emissive: 0x18e0ff, emissiveIntensity: 0.5 }),
    );
    obj.add(m);
    this.leftMarker = m;
  }

  // --- per-frame ------------------------------------------------------------

  /** Read controller state once per frame. Call before LocalPlayer.update. */
  poll(dt: number) {
    const session = (this.renderer.xr as unknown as { getSession?: () => XrSession | null }).getSession?.();
    let leftGp: XrGamepad | null = null;
    let rightGp: XrGamepad | null = null;
    if (session) {
      for (const src of session.inputSources) {
        if (!src.gamepad) continue;
        if (src.handedness === "left") leftGp = src.gamepad;
        else if (src.handedness === "right") rightGp = src.gamepad;
        else if (!rightGp) rightGp = src.gamepad;
        else if (!leftGp) leftGp = src.gamepad;
      }
    }

    // Locomotion: left stick (head-relative once Game feeds head yaw to LocalPlayer).
    const [lx, ly] = this.stick(leftGp);
    this.mv.x = Math.abs(lx) > DEADZONE ? lx : 0;
    this.mv.z = Math.abs(ly) > DEADZONE ? ly : 0;

    // Snap turn: right stick X, edge-triggered so one flick = one increment.
    const [rx] = this.stick(rightGp);
    if (Math.abs(rx) > 0.7) {
      if (!this.prev.snap) {
        this.bodyYaw -= Math.sign(rx) * SNAP_TURN;
        this.prev.snap = true;
      }
    } else if (Math.abs(rx) < 0.3) {
      this.prev.snap = false;
    }
    this.rig.rotation.y = this.bodyYaw;

    // Held buttons.
    this._fire = this.btn(rightGp, BTN_TRIGGER);     // right trigger
    this._jump = this.btn(rightGp, BTN_PRIMARY);     // right A — hold for bhop
    this._crouch = this.btn(leftGp, BTN_TRIGGER);    // left trigger — hold to crouch/slide
    this._use = this.gripFirm(leftGp);               // left grip squeeze — bomb plant/defuse
    this._scores = this.btn(leftGp, BTN_STICK);      // left stick press — scoreboard

    // One-shot edges. Abilities are on the face buttons (a real mechanical
    // press), NOT the force-sensitive grips: resting your hand on an Index
    // controller squeezes the grip enough to fire them otherwise. Grips are used
    // only for infrequent actions and require a firm squeeze (see gripFirm).
    if (this.edge("abilF", this.btn(leftGp, BTN_PRIMARY))) this.cb.onAbility("F");     // left A
    if (this.edge("abilC", this.btn(rightGp, BTN_SECONDARY))) this.cb.onAbility("C");  // right B
    if (this.edge("reload", this.btn(leftGp, BTN_SECONDARY))) this.cb.onReload();      // left B
    if (this.edge("switch", this.gripFirm(rightGp))) this.cb.onSwitchCycle();          // right grip

    this.diagnostics(leftGp, rightGp);

    // Vignette ease toward the locomotion target.
    this.vignetteOpacity += (this.vignetteTarget - this.vignetteOpacity) * Math.min(1, 10 * dt);
    (this.vignette.material as THREE.Material).opacity = this.vignetteOpacity;
    this.vignette.visible = this.vignetteOpacity > 0.02;
  }

  /** The gun-hand controller (aim source for grenades/abilities), if connected. */
  get aimSource(): THREE.Object3D | null {
    return this.rightObj;
  }

  /** Drive the comfort vignette from normalized move speed (0..1). */
  setVignette(speed01: number) {
    this.vignetteTarget = Math.min(1, Math.max(0, speed01)) * MAX_VIGNETTE;
  }

  private stick(gp: XrGamepad | null): [number, number] {
    if (!gp) return [0, 0];
    const a = gp.axes;
    // xr-standard puts the thumbstick at axes[2]/[3]; fall back to [0]/[1].
    if (a.length >= 4) return [a[2] ?? 0, a[3] ?? 0];
    return [a[0] ?? 0, a[1] ?? 0];
  }

  private btn(gp: XrGamepad | null, i: number): boolean {
    return gp?.buttons?.[i]?.pressed ?? false;
  }

  /** A firm grip squeeze (force past a threshold) so a resting hand won't fire. */
  private gripFirm(gp: XrGamepad | null): boolean {
    return (gp?.buttons?.[BTN_GRIP]?.value ?? 0) > 0.85;
  }

  /**
   * Periodic [VR] console diagnostics (visible in the desktop DevTools console).
   * draw-calls > 0 means the scene is rendering; `cam`/`rig` tell us the camera
   * is in the map; `presenting` confirms the headset session is live.
   */
  private diagFrame = 0;
  private diagnostics(leftGp: XrGamepad | null, rightGp: XrGamepad | null) {
    if ((this.diagFrame++ % 120) !== 0) return;
    const cam = new THREE.Vector3();
    this.camera.getWorldPosition(cam);
    const xr = this.renderer.xr as unknown as { isPresenting?: boolean };
    console.log("[VR]", {
      presenting: xr.isPresenting,
      drawCalls: this.renderer.info.render.calls,
      cam: cam.toArray().map((n) => +n.toFixed(1)),
      rig: this.rig.position.toArray().map((n) => +n.toFixed(1)),
      pads: { left: !!leftGp, right: !!rightGp },
    });
  }

  private edge(key: string, pressed: boolean): boolean {
    const fired = pressed && !this.prev[key];
    this.prev[key] = pressed;
    return fired;
  }

  // --- desktop-Input-compatible surface (read by the game loop) -------------

  moveAxis(): { x: number; z: number } {
    return { x: this.mv.x, z: this.mv.z };
  }
  get jumping(): boolean { return this._jump; }
  get crouching(): boolean { return this._crouch; }
  get firing(): boolean { return this._fire; }
  get ads(): boolean { return false; }
  get useHeld(): boolean { return this._use; }
  get showScores(): boolean { return this._scores; }
  get locked(): boolean { return this.presenting; }
  consumeMouse(): { dx: number; dy: number } { return { dx: 0, dy: 0 }; }
}

// Minimal local shapes for the WebXR objects we touch.
interface XrGamepad { axes: number[]; buttons: { pressed: boolean; value: number }[]; }
interface XrInputSource { handedness: string; gamepad: XrGamepad | null; }
interface XrSession { inputSources: Iterable<XrInputSource>; }
