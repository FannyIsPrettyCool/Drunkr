import * as THREE from "three";

/**
 * Wraps the Three.js renderer, scene and camera. The "pixelated" cyberpunk
 * look is achieved by rendering into a low internal resolution (the canvas
 * drawing buffer) and letting CSS upscale it with nearest-neighbour
 * (`image-rendering: pixelated`).
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /**
   * The player "rig": the camera lives inside this group. On desktop it stays
   * at the identity so the camera's local transform is its world transform
   * (unchanged behaviour). In VR the headset drives the camera's local pose and
   * we move/rotate this rig instead (feet position + snap-turn yaw).
   */
  readonly rig: THREE.Group;

  /** Target internal vertical resolution; lower = chunkier pixels. */
  private pixelHeight = 360;

  constructor(canvas: HTMLCanvasElement) {
    // Create the WebGL context up front as xr-compatible. Otherwise Three.js
    // makes a normal context and only calls makeXRCompatible() when entering VR,
    // which on multi-GPU machines (esp. with powerPreference "high-performance")
    // can leave frames rendering to a context the headset compositor never sees
    // — a black headset while controllers/input keep working. Fall back to the
    // default path if WebGL2 isn't available.
    const glAttrs = {
      antialias: false, alpha: false, depth: true, stencil: false,
      powerPreference: "high-performance", xrCompatible: true,
    } as WebGLContextAttributes;
    const gl = canvas.getContext("webgl2", glAttrs) as WebGL2RenderingContext | null;
    this.renderer = new THREE.WebGLRenderer(
      gl
        ? { canvas, context: gl }
        : { canvas, antialias: false, powerPreference: "high-performance" },
    );
    this.renderer.setPixelRatio(1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060c);
    // Distant atmospheric haze only — keep sightlines across the whole arena.
    this.scene.fog = new THREE.Fog(0x05060c, 120, 320);

    this.camera = new THREE.PerspectiveCamera(82, 1, 0.05, 1000);
    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    this.setupLights();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private setupLights() {
    const hemi = new THREE.HemisphereLight(0x4a6cff, 0x0a0612, 0.6);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xff5fc8, 0.8);
    key.position.set(20, 40, 10);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x18e0ff, 0.5);
    fill.position.set(-20, 25, -15);
    this.scene.add(fill);

    this.scene.add(new THREE.AmbientLight(0x202840, 0.6));
  }

  /** Change the internal render resolution (quality). */
  setPixelHeight(h: number) {
    this.pixelHeight = h;
    this.resize();
  }

  private resize() {
    // Three.js owns the framebuffer while a headset is presenting; setSize is a
    // no-op (and warns) then, so skip it.
    if (this.renderer.xr.isPresenting) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    const renderH = this.pixelHeight;
    const renderW = Math.round(renderH * aspect);

    // `false` keeps the CSS size at 100%, only the drawing buffer is low-res.
    this.renderer.setSize(renderW, renderH, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
