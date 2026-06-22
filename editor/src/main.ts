import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  MAPS, textureForBox, TEXTURE_KEYS, platformPosAt,
  type GameMap, type MapBox, type JumpPad, type Ramp, type Vec3, type BoxShape,
  type MapLight, type MapEmitter, type HazardZone, type MovingPlatform,
} from "@drunkr/shared";
import { getTexture, applyBoxUV } from "./textures.js";

type Model = {
  name: string;
  bounds: number;
  spawns: Vec3[];
  boxes: MapBox[];
  pads: JumpPad[];
  ramps: Ramp[];
  lights: MapLight[];
  emitters: MapEmitter[];
  hazards: HazardZone[];
  platforms: MovingPlatform[];
};
type SelType = "box" | "pad" | "spawn" | "ramp" | "light" | "emitter" | "hazard" | "platform";
type SelObj = { type: SelType; index: number };
type Sel = SelObj | null;
type Mode = "translate" | "rotate" | "scale";
type PrebuiltData = { boxes: MapBox[]; pads: JumpPad[]; ramps: Ramp[] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const toNum = (s: string) => parseInt(s.slice(1), 16);
const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1000) / 1000;
const d2r = (d: number) => (d * Math.PI) / 180;
const r2d = (r: number) => Math.round((r * 180) / Math.PI);

/** Decompose a velocity vector into launch power + yaw/pitch (degrees). */
function yawPitchFromDir(v: Vec3): { yaw: number; pitch: number; speed: number } {
  const speed = Math.hypot(v.x, v.y, v.z);
  const pitch = speed > 1e-4 ? Math.asin(Math.max(-1, Math.min(1, v.y / speed))) : 0;
  return { yaw: r2d(Math.atan2(v.x, v.z)), pitch: r2d(pitch), speed: r2(speed) };
}
/** Build a velocity vector from launch power + yaw/pitch (degrees). */
function dirFromYawPitch(yawDeg: number, pitchDeg: number, speed: number): Vec3 {
  const yaw = d2r(yawDeg), pitch = d2r(pitchDeg);
  return {
    x: r2(speed * Math.cos(pitch) * Math.sin(yaw)),
    y: r2(speed * Math.sin(pitch)),
    z: r2(speed * Math.cos(pitch) * Math.cos(yaw)),
  };
}

// cyberpunk palette (mirrors shared/src/map.ts)
const DARK = 0x12131c, SLATE = 0x1b1d2b, SLATE2 = 0x232639, SLATE3 = 0x2a2e45;
const CYAN = 0x18e0ff, PINK = 0xff2d9b, GREEN = 0x39ff8b, AMBER = 0xffb23d, VIOLET = 0x9b5dff;

/** Visual primitive for a box (collision matches the silhouette — see shared BoxShape). */
function shapeGeometry(shape: BoxShape | undefined, size: Vec3): THREE.BufferGeometry {
  const { x: sx, y: sy, z: sz } = size;
  if (shape === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 24).scale(sx, sy, sz);
  if (shape === "sphere") return new THREE.SphereGeometry(0.5, 24, 16).scale(sx, sy, sz);
  if (shape === "wedge") {
    const s = new THREE.Shape();
    s.moveTo(-sx / 2, -sy / 2);
    s.lineTo(sx / 2, -sy / 2);
    s.lineTo(-sx / 2, sy / 2);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: sz, bevelEnabled: false });
    g.translate(0, 0, -sz / 2);
    return g;
  }
  return new THREE.BoxGeometry(sx, sy, sz);
}

class Editor {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private gizmo!: TransformControls;
  private raycaster = new THREE.Raycaster();
  private group = new THREE.Group();
  private outlines: THREE.Box3Helper[] = [];
  private picks: { obj: THREE.Object3D; type: SelObj }[] = [];
  private model: Model = blank();
  private selection: SelObj[] = [];

  // transform state
  private mode: Mode = "translate";
  private anchored = false; // scale grows symmetrically from the center (both ends)
  private shiftDown = false; // hold Shift while scaling → uniform on all axes
  private snap = true;
  private snapSize = 1;
  private drag: {
    mode: Mode; pPos: Vec3; pSize?: Vec3; pRotY: number;
    others: { sel: SelObj; pos: Vec3; size?: Vec3; rotY: number }[];
  } | null = null;

  // history
  private undoStack: Model[] = [];
  private redoStack: Model[] = [];

  private preview = new PrebuiltPreview();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.scene.background = new THREE.Color(0x0a0c14);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    this.camera.position.set(40, 50, 60);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value;
      if (e.value) this.beginDrag();
      else this.afterDrag(); // rebuild + reattach when the drag ends
    });
    this.gizmo.addEventListener("objectChange", () => this.writeBack());
    this.scene.add(this.gizmo.getHelper());
    this.applySnap();

    this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x101018, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(30, 60, 20);
    this.scene.add(dir);
    this.scene.add(this.group);

    this.resize();
    addEventListener("resize", () => this.resize());
    this.bindUI(canvas);
    this.build();
    this.loop();
  }

  // ---- selection helpers --------------------------------------------------
  private primary(): Sel { return this.selection.length ? this.selection[this.selection.length - 1] : null; }
  private isSelected(s: SelObj) { return this.selection.some((o) => o.type === s.type && o.index === s.index); }
  private selectedPicks() {
    return this.selection
      .map((s) => this.picks.find((p) => p.type.type === s.type && p.type.index === s.index))
      .filter((p): p is { obj: THREE.Object3D; type: SelObj } => !!p);
  }
  private pickFor(s: SelObj) { return this.picks.find((p) => p.type.type === s.type && p.type.index === s.index); }

  /** The data object for a selection (null for spawns, which are bare Vec3s). */
  private objFor(s: SelObj): { pos: Vec3; size?: Vec3; color?: number; emissive?: number; texture?: string } | null {
    const list = this.listOf(s.type);
    return s.type === "spawn" ? null : (list[s.index] as { pos: Vec3; size?: Vec3; color?: number });
  }
  /** The position vector for a selection (spawns are positioned directly). */
  private posRef(s: SelObj): Vec3 {
    return s.type === "spawn" ? this.model.spawns[s.index] : this.objFor(s)!.pos;
  }
  /** Y offset between a selection's mesh and its stored position. */
  private meshYOffset(s: SelObj): number {
    if (s.type === "spawn") return 1.2;
    if (s.type === "ramp") return this.model.ramps[s.index].size.y / 2 - 0.2;
    return 0;
  }
  /** Stored Y-rotation of a selection (only boxes carry rotation). */
  private rotYOf(s: SelObj): number {
    return s.type === "box" ? (this.model.boxes[s.index].rot?.y ?? 0) : 0;
  }

  // ---- scene build --------------------------------------------------------
  private build() {
    this.group.clear();
    this.picks = [];

    const grid = new THREE.GridHelper(this.model.bounds * 2, this.model.bounds, 0x2a3050, 0x161a2c);
    this.group.add(grid);

    this.model.boxes.forEach((b, index) => {
      const isBox = !b.shape || b.shape === "box";
      const geo = shapeGeometry(b.shape, b.size);
      const tex = textureForBox(b);
      let mat: THREE.MeshStandardMaterial;
      if (tex) {
        if (isBox) applyBoxUV(geo, b.size, tex);
        const t = getTexture(tex);
        mat = new THREE.MeshStandardMaterial({
          map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.18, roughness: 0.9, metalness: 0.05,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          color: b.color, emissive: b.emissive ?? 0x000000,
          emissiveIntensity: b.emissive ? 0.5 : 0, roughness: 0.8, metalness: 0.1,
        });
      }
      const m = new THREE.Mesh(geo, mat);
      m.position.set(b.pos.x, b.pos.y, b.pos.z);
      if (b.rot) m.rotation.set(b.rot.x, b.rot.y, b.rot.z);
      this.group.add(m);
      this.picks.push({ obj: m, type: { type: "box", index } });
    });

    this.model.pads.forEach((p, index) => {
      // Flat glowing square on the ground (no tilt — orientation lives in launch).
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z),
        new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.9 }),
      );
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      this.group.add(m);
      const lv = new THREE.Vector3(p.launch.x, p.launch.y, p.launch.z);
      const dir = lv.length() > 1e-3 ? lv.clone().normalize() : new THREE.Vector3(0, 1, 0);
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(p.pos.x, p.pos.y + 0.4, p.pos.z), 4, p.color);
      this.group.add(arrow);
      this.picks.push({ obj: m, type: { type: "pad", index } });
    });

    this.model.lights.forEach((l, index) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 12, 10),
        new THREE.MeshStandardMaterial({ color: l.color, emissive: l.color, emissiveIntensity: 1 }),
      );
      m.position.set(l.pos.x, l.pos.y, l.pos.z);
      this.group.add(m);
      const light = new THREE.PointLight(l.color, l.intensity, l.range, 2);
      m.add(light);
      this.picks.push({ obj: m, type: { type: "light", index } });
    });

    this.model.emitters.forEach((e, index) => {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.4),
        new THREE.MeshStandardMaterial({ color: e.color, emissive: e.color, emissiveIntensity: 0.9, wireframe: true }),
      );
      m.position.set(e.pos.x, e.pos.y, e.pos.z);
      this.group.add(m);
      const ev = new THREE.Vector3(e.dir.x, e.dir.y, e.dir.z);
      if (ev.length() > 1e-3) this.group.add(new THREE.ArrowHelper(ev.clone().normalize(), m.position.clone(), 2.5, e.color));
      this.picks.push({ obj: m, type: { type: "emitter", index } });
    });

    this.model.hazards.forEach((h, index) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(h.size.x, h.size.y, h.size.z),
        new THREE.MeshStandardMaterial({ color: h.color, emissive: h.color, emissiveIntensity: 0.6, transparent: true, opacity: 0.45 }),
      );
      m.position.set(h.pos.x, h.pos.y, h.pos.z);
      this.group.add(m);
      this.picks.push({ obj: m, type: { type: "hazard", index } });
    });

    this.model.platforms.forEach((p, index) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z),
        new THREE.MeshStandardMaterial({ color: p.color, emissive: p.emissive ?? p.color, emissiveIntensity: 0.4, roughness: 0.7, metalness: 0.15 }),
      );
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      this.group.add(m);
      // Dashed line showing the travel path to the far endpoint.
      const far = new THREE.Vector3(p.pos.x + p.travel.x, p.pos.y + p.travel.y, p.pos.z + p.travel.z);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([m.position.clone(), far]),
        new THREE.LineDashedMaterial({ color: p.emissive ?? 0x18e0ff, dashSize: 0.6, gapSize: 0.4 }),
      );
      line.computeLineDistances();
      this.group.add(line);
      this.picks.push({ obj: m, type: { type: "platform", index } });
    });

    this.model.ramps.forEach((r, index) => {
      const m = rampMesh(r, true);
      this.group.add(m);
      this.picks.push({ obj: m, type: { type: "ramp", index } });
    });

    this.model.spawns.forEach((s, index) => {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(0.8, 2.2, 6),
        new THREE.MeshStandardMaterial({ color: 0x39ff8b, emissive: 0x39ff8b, emissiveIntensity: 0.6 }),
      );
      m.position.set(s.x, s.y + 1.2, s.z);
      this.group.add(m);
      this.picks.push({ obj: m, type: { type: "spawn", index } });
    });

    this.refreshHighlight();
    this.attachGizmo();
    this.refreshList();
    this.refreshCounts();
  }

  /** Outline every selected object; the primary gets a brighter colour. */
  private refreshHighlight() {
    const picks = this.selectedPicks();
    while (this.outlines.length < picks.length) {
      const h = new THREE.Box3Helper(new THREE.Box3(), 0xffd33d);
      this.outlines.push(h);
      this.scene.add(h);
    }
    this.outlines.forEach((h, i) => {
      const p = picks[i];
      if (p) {
        h.visible = true;
        h.box.setFromObject(p.obj);
        (h.material as THREE.LineBasicMaterial).color.set(i === picks.length - 1 ? 0xffd33d : 0x18e0ff);
      } else h.visible = false;
    });
    // NOTE: do not refresh property inputs here — applyProps() rebuilds the
    // scene on every keystroke and we must not clobber the field being typed.
  }

  // ---- selection ----------------------------------------------------------
  private pick(x: number, y: number, additive: boolean) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.picks.map((p) => p.obj), false)[0];
    if (!hit) {
      if (!additive) this.select(null);
      return;
    }
    const e = this.picks.find((p) => p.obj === hit.object);
    if (e) this.select(e.type, additive);
  }

  /** Replace selection (or toggle it when additive/ctrl-click). */
  private select(s: Sel, additive = false) {
    if (!s) {
      if (!additive) this.selection = [];
    } else if (additive) {
      const i = this.selection.findIndex((o) => o.type === s.type && o.index === s.index);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(s);
    } else {
      this.selection = [s];
    }
    this.refreshHighlight();
    this.attachGizmo();
    this.refreshList();
    this.showProps(); // repopulate inputs only when the selection changes
  }

  private attachGizmo() {
    const prim = this.primary();
    const e = prim && this.pickFor(prim);
    if (e) this.gizmo.attach(e.obj);
    else this.gizmo.detach();
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.gizmo.setMode(mode);
    document.querySelectorAll<HTMLElement>(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  }

  private applySnap() {
    this.gizmo.setTranslationSnap(this.snap ? this.snapSize : null);
    this.gizmo.setRotationSnap(this.snap ? d2r(15) : null);
    this.gizmo.setScaleSnap(this.snap ? 0.25 : null);
  }

  // ---- transform write-back -----------------------------------------------
  private beginDrag() {
    const prim = this.primary();
    if (!prim) return;
    this.pushHistory();
    const o = this.objFor(prim);
    this.drag = {
      mode: this.mode,
      pPos: clone(this.posRef(prim)),
      pSize: o && o.size ? clone(o.size) : undefined,
      pRotY: this.rotYOf(prim),
      others: this.selection.filter((s) => s !== prim).map((s) => ({
        sel: s, pos: clone(this.posRef(s)),
        size: this.objFor(s)?.size ? clone(this.objFor(s)!.size!) : undefined,
        rotY: this.rotYOf(s),
      })),
    };
  }

  /** Write the dragged primary mesh's transform back into the data model. */
  private writeBack() {
    const prim = this.primary();
    const obj = this.gizmo.object as THREE.Mesh | undefined;
    if (!obj || !prim) return;
    if (prim.type === "spawn") {
      const s = this.model.spawns[prim.index];
      s.x = r2(obj.position.x); s.y = r2(obj.position.y - 1.2); s.z = r2(obj.position.z);
    } else if (prim.type === "ramp") {
      // The ramp mesh is a rotated/offset slab — only translate maps cleanly;
      // size/dir are edited in the panel.
      const r = this.model.ramps[prim.index];
      r.pos.x = r2(obj.position.x); r.pos.z = r2(obj.position.z);
      r.pos.y = r2(obj.position.y - r.size.y / 2 + 0.2);
    } else {
      const o = this.objFor(prim)!;
      o.pos.x = r2(obj.position.x); o.pos.y = r2(obj.position.y); o.pos.z = r2(obj.position.z);
      // Geometry was built at the drag-start size; gizmo scale multiplies it.
      if (o.size) {
        const geo = obj.geometry as THREE.BoxGeometry;
        const base = this.drag?.pSize ?? { x: geo.parameters?.width ?? o.size.x, y: geo.parameters?.height ?? o.size.y, z: geo.parameters?.depth ?? o.size.z };
        // Hold Shift while scaling → uniform on all axes (whichever handle you drag).
        if (this.mode === "scale" && this.shiftDown) {
          const sc = [obj.scale.x, obj.scale.y, obj.scale.z];
          const f = sc.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
          obj.scale.set(f, f, f);
        }
        o.size.x = Math.max(0.1, r2(base.x * obj.scale.x));
        o.size.y = Math.max(0.1, r2(base.y * obj.scale.y));
        o.size.z = Math.max(0.1, r2(base.z * obj.scale.z));
      }
      // Only boxes store rotation. Pads convert rotation into a launch direction
      // (handled on drag-end so the flat slab itself never tilts).
      if (prim.type === "box") {
        const b = this.model.boxes[prim.index];
        const e = obj.rotation;
        b.rot = e.x || e.y || e.z ? { x: r4(e.x), y: r4(e.y), z: r4(e.z) } : undefined;
      }
    }
    this.applyGroupTransform();
    this.showProps();
  }

  /** Apply the primary's drag delta to the rest of the selection (translate by
   *  the same offset, rotate/scale around the primary's pivot). */
  private applyGroupTransform() {
    const d = this.drag, prim = this.primary();
    if (!d || !prim || !d.others.length) return;
    const obj = this.gizmo.object as THREE.Mesh | undefined;
    if (!obj) return;
    const piv = d.pPos;
    const sync = (s: SelObj, ref: Vec3) => {
      const pick = this.pickFor(s);
      if (pick) pick.obj.position.set(ref.x, ref.y + this.meshYOffset(s), ref.z);
    };
    if (this.mode === "translate") {
      const np = this.posRef(prim);
      const dx = np.x - piv.x, dy = np.y - piv.y, dz = np.z - piv.z;
      for (const o of d.others) {
        const ref = this.posRef(o.sel);
        ref.x = r2(o.pos.x + dx); ref.y = r2(o.pos.y + dy); ref.z = r2(o.pos.z + dz);
        sync(o.sel, ref);
      }
    } else if (this.mode === "rotate") {
      const dyaw = obj.rotation.y - d.pRotY;
      const c = Math.cos(dyaw), s = Math.sin(dyaw);
      for (const o of d.others) {
        const ox = o.pos.x - piv.x, oz = o.pos.z - piv.z;
        // Match THREE.makeRotationY: x' = c·x + s·z, z' = −s·x + c·z.
        const ref = this.posRef(o.sel);
        ref.x = r2(piv.x + (c * ox + s * oz)); ref.y = o.pos.y; ref.z = r2(piv.z + (-s * ox + c * oz));
        if (o.sel.type === "box") {
          const b = this.model.boxes[o.sel.index];
          const ry = o.rotY + dyaw;
          b.rot = { x: b.rot?.x ?? 0, y: r4(ry), z: b.rot?.z ?? 0 };
          const pick = this.pickFor(o.sel); if (pick) pick.obj.rotation.y = ry;
        }
        sync(o.sel, ref);
      }
    } else { // scale
      const fx = obj.scale.x, fy = obj.scale.y, fz = obj.scale.z;
      for (const o of d.others) {
        const ref = this.posRef(o.sel);
        ref.x = r2(piv.x + (o.pos.x - piv.x) * fx);
        ref.y = r2(piv.y + (o.pos.y - piv.y) * fy);
        ref.z = r2(piv.z + (o.pos.z - piv.z) * fz);
        const od = this.objFor(o.sel);
        if (od?.size && o.size) {
          od.size.x = Math.max(0.1, r2(o.size.x * fx));
          od.size.y = Math.max(0.1, r2(o.size.y * fy));
          od.size.z = Math.max(0.1, r2(o.size.z * fz));
          const pick = this.pickFor(o.sel); if (pick) pick.obj.scale.set(fx, fy, fz);
        }
        sync(o.sel, ref);
      }
    }
  }

  /** Rotate a pad's launch vector about Y by `yaw` (the gizmo's turn). The slab
   *  stays flat — only the launch direction (and its arrow) changes. */
  private rotatePadLaunch(i: number, yaw: number) {
    const p = this.model.pads[i];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = p.launch.x, lz = p.launch.z;
    p.launch.x = r2(c * lx + s * lz);
    p.launch.z = r2(-s * lx + c * lz);
  }

  /** On scale end, optionally anchor the opposite face so one side stays put. */
  private afterDrag() {
    const prim = this.primary();
    if (this.drag && this.mode === "scale" && this.anchored && prim && this.drag.pSize &&
        (prim.type === "box" || prim.type === "pad")) {
      const o = this.objFor(prim);
      if (o?.size) {
        const ss = this.drag.pSize, sp = this.drag.pPos;
        o.pos.x = r2(sp.x + (o.size.x - ss.x) / 2);
        o.pos.y = r2(sp.y + (o.size.y - ss.y) / 2);
        o.pos.z = r2(sp.z + (o.size.z - ss.z) / 2);
      }
    }
    // Rotating a pad only turns where it launches you — bake it into the launch
    // vector and rebuild flat (the gizmo's rotation is discarded).
    if (this.drag && this.mode === "rotate" && prim?.type === "pad") {
      const obj = this.gizmo.object as THREE.Mesh | undefined;
      if (obj && Math.abs(obj.rotation.y) > 1e-4) this.rotatePadLaunch(prim.index, obj.rotation.y);
    }
    this.drag = null;
    this.build();
    this.showProps();
  }

  // ---- property panel -----------------------------------------------------
  private showProps() {
    const prim = this.primary();
    const props = $("props");
    if (!prim) { props.classList.add("hidden"); return; }
    props.classList.remove("hidden");
    const { type, index } = prim;
    $("prop-title").textContent = type.toUpperCase();
    const hint = $("multi-hint");
    if (this.selection.length > 1) {
      hint.classList.remove("hidden");
      hint.textContent = `+${this.selection.length - 1} more selected · edits apply to this one`;
    } else hint.classList.add("hidden");

    const sized = type !== "spawn" && type !== "light" && type !== "emitter";
    const colored = type !== "spawn";
    const solid = type === "box" || type === "ramp" || type === "platform"; // color + emissive + texture
    const toggle = (sel: string, on: boolean) =>
      $("props").querySelectorAll<HTMLElement>(sel).forEach((el) => el.classList.toggle("hidden", !on));
    toggle(".size-fields", sized);
    toggle(".color-fields", colored);
    toggle(".texture-fields", solid);
    toggle(".rot-fields", type === "box");
    toggle(".shape-fields", type === "box");
    toggle(".dir-fields", type === "ramp");
    toggle(".pad-fields", type === "pad");
    toggle(".light-fields", type === "light");
    toggle(".emitter-fields", type === "emitter");
    toggle(".hazard-fields", type === "hazard");
    toggle(".platform-fields", type === "platform");

    const pos = this.posRef(prim);
    setNum("p-px", pos.x); setNum("p-py", pos.y); setNum("p-pz", pos.z);

    if (sized) {
      const o = this.objFor(prim)!;
      setNum("p-sx", o.size!.x); setNum("p-sy", o.size!.y); setNum("p-sz", o.size!.z);
    }
    if (colored) ($("p-color") as HTMLInputElement).value = hex((this.objFor(prim) as { color: number }).color);
    if (type === "box") {
      const rot = this.model.boxes[index].rot;
      setNum("p-rx", r2d(rot?.x ?? 0)); setNum("p-ry", r2d(rot?.y ?? 0)); setNum("p-rz", r2d(rot?.z ?? 0));
    }
    if (solid) {
      const o = this.objFor(prim) as { emissive?: number; texture?: string; color: number };
      ($("p-emi-on") as HTMLInputElement).checked = o.emissive !== undefined;
      ($("p-emi") as HTMLInputElement).value = hex(o.emissive ?? o.color);
      ($("p-texture") as HTMLSelectElement).value = o.texture ?? "";
    }
    if (type === "box") ($("p-shape") as HTMLSelectElement).value = this.model.boxes[index].shape ?? "box";
    if (type === "pad") {
      const { yaw, pitch, speed } = yawPitchFromDir(this.model.pads[index].launch);
      setNum("p-str", speed); setNum("p-yaw", yaw); setNum("p-pitch", pitch);
    }
    if (type === "light") { const l = this.model.lights[index]; setNum("p-lint", l.intensity); setNum("p-lrange", l.range); }
    if (type === "emitter") {
      const e = this.model.emitters[index];
      const { yaw, pitch } = yawPitchFromDir(e.dir);
      setNum("p-erate", e.rate); setNum("p-eyaw", yaw); setNum("p-epitch", pitch);
    }
    if (type === "hazard") setNum("p-hdps", this.model.hazards[index].dps);
    if (type === "platform") {
      const p = this.model.platforms[index];
      setNum("p-tx", p.travel.x); setNum("p-ty", p.travel.y); setNum("p-tz", p.travel.z); setNum("p-period", p.period);
    }
    if (type === "ramp") ($("p-dir") as HTMLSelectElement).value = String(this.model.ramps[index].dir);
  }

  private applyProps() {
    const prim = this.primary();
    if (!prim) return;
    const { type, index } = prim;
    const sized = type !== "spawn" && type !== "light" && type !== "emitter";
    const colored = type !== "spawn";
    const solid = type === "box" || type === "ramp" || type === "platform";
    const pos = this.posRef(prim);
    pos.x = getNum("p-px"); pos.y = getNum("p-py"); pos.z = getNum("p-pz");
    if (sized) {
      const o = this.objFor(prim)!;
      o.size!.x = Math.max(0.1, getNum("p-sx"));
      o.size!.y = Math.max(0.1, getNum("p-sy"));
      o.size!.z = Math.max(0.1, getNum("p-sz"));
    }
    if (colored) (this.objFor(prim) as { color: number }).color = toNum(($("p-color") as HTMLInputElement).value);
    if (type === "box") {
      const b = this.model.boxes[index];
      const rx = d2r(getNum("p-rx")), ry = d2r(getNum("p-ry")), rz = d2r(getNum("p-rz"));
      b.rot = rx || ry || rz ? { x: r4(rx), y: r4(ry), z: r4(rz) } : undefined;
    }
    if (solid) {
      const o = this.objFor(prim) as { emissive?: number; texture?: string };
      o.emissive = ($("p-emi-on") as HTMLInputElement).checked ? toNum(($("p-emi") as HTMLInputElement).value) : undefined;
      o.texture = ($("p-texture") as HTMLSelectElement).value || undefined;
    }
    if (type === "box") {
      const sh = ($("p-shape") as HTMLSelectElement).value as BoxShape;
      this.model.boxes[index].shape = sh === "box" ? undefined : sh;
    }
    if (type === "pad") {
      this.model.pads[index].launch = dirFromYawPitch(getNum("p-yaw"), getNum("p-pitch"), Math.max(0, getNum("p-str")));
    }
    if (type === "light") {
      const l = this.model.lights[index];
      l.intensity = Math.max(0, getNum("p-lint")); l.range = Math.max(1, getNum("p-lrange"));
    }
    if (type === "emitter") {
      const e = this.model.emitters[index];
      const speed = Math.max(0.5, Math.hypot(e.dir.x, e.dir.y, e.dir.z));
      e.rate = Math.max(0, getNum("p-erate"));
      e.dir = dirFromYawPitch(getNum("p-eyaw"), getNum("p-epitch"), speed);
    }
    if (type === "hazard") this.model.hazards[index].dps = Math.max(0, getNum("p-hdps"));
    if (type === "platform") {
      const p = this.model.platforms[index];
      p.travel.x = getNum("p-tx"); p.travel.y = getNum("p-ty"); p.travel.z = getNum("p-tz");
      p.period = Math.max(0.2, getNum("p-period"));
    }
    if (type === "ramp") this.model.ramps[index].dir = Number(($("p-dir") as HTMLSelectElement).value) || 0;
    this.build();
  }

  // ---- toolbar actions ----------------------------------------------------
  private addBox(shape?: BoxShape) {
    this.pushHistory();
    this.model.boxes.push({ pos: v3(0, 2, 0), size: v3(4, 4, 4), color: SLATE3, emissive: CYAN, ...(shape ? { shape } : {}) });
    this.select({ type: "box", index: this.model.boxes.length - 1 });
    this.build();
  }
  private addPad() {
    this.pushHistory();
    this.model.pads.push({ pos: v3(0, 0.1, 0), size: v3(5, 0.2, 5), launch: v3(0, 15, 0), color: CYAN });
    this.select({ type: "pad", index: this.model.pads.length - 1 });
    this.build();
  }
  private addLight() {
    this.pushHistory();
    this.model.lights.push({ pos: v3(0, 6, 0), color: CYAN, intensity: 2, range: 24 });
    this.select({ type: "light", index: this.model.lights.length - 1 });
    this.build();
  }
  private addEmitter() {
    this.pushHistory();
    this.model.emitters.push({ pos: v3(0, 1, 0), color: PINK, rate: 24, dir: v3(0, 3, 0) });
    this.select({ type: "emitter", index: this.model.emitters.length - 1 });
    this.build();
  }
  private addHazard() {
    this.pushHistory();
    this.model.hazards.push({ pos: v3(0, 1, 0), size: v3(6, 2, 6), color: 0xff3344, dps: 25 });
    this.select({ type: "hazard", index: this.model.hazards.length - 1 });
    this.build();
  }
  private addPlatform() {
    this.pushHistory();
    this.model.platforms.push({ pos: v3(0, 2, 0), size: v3(5, 0.6, 5), color: SLATE3, travel: v3(0, 8, 0), period: 6, emissive: CYAN });
    this.select({ type: "platform", index: this.model.platforms.length - 1 });
    this.build();
  }
  private addSpawn() {
    this.pushHistory();
    this.model.spawns.push(v3(0, 0, 0));
    this.select({ type: "spawn", index: this.model.spawns.length - 1 });
    this.build();
  }

  private listOf(type: SelType): unknown[] {
    switch (type) {
      case "box": return this.model.boxes;
      case "pad": return this.model.pads;
      case "ramp": return this.model.ramps;
      case "light": return this.model.lights;
      case "emitter": return this.model.emitters;
      case "hazard": return this.model.hazards;
      case "platform": return this.model.platforms;
      default: return this.model.spawns;
    }
  }

  private duplicate() {
    if (!this.selection.length) return;
    this.pushHistory();
    const added: SelObj[] = [];
    for (const s of [...this.selection]) {
      const list = this.listOf(s.type) as unknown[];
      const copy = clone(list[s.index]);
      if (s.type === "spawn") (copy as Vec3).x += 3;
      else (copy as { pos: Vec3 }).pos.x += 3;
      list.push(copy);
      added.push({ type: s.type, index: list.length - 1 });
    }
    this.selection = added;
    this.build();
    this.showProps();
  }

  private del() {
    if (!this.selection.length) return;
    this.pushHistory();
    // Splice high indices first so earlier indices stay valid.
    const byType = new Map<SelObj["type"], number[]>();
    for (const s of this.selection) (byType.get(s.type) ?? byType.set(s.type, []).get(s.type)!).push(s.index);
    for (const [type, idx] of byType) {
      idx.sort((a, b) => b - a);
      const list = this.listOf(type) as unknown[];
      for (const i of idx) list.splice(i, 1);
    }
    this.selection = [];
    this.build();
    this.showProps();
  }

  /** Drop a prebuilt template centred on the current camera focus point. */
  private addPrebuilt(t: PrebuiltData) {
    this.pushHistory();
    const c = this.controls.target;
    const ox = this.snap ? Math.round(c.x / this.snapSize) * this.snapSize : Math.round(c.x);
    const oz = this.snap ? Math.round(c.z / this.snapSize) * this.snapSize : Math.round(c.z);
    const sel: SelObj[] = [];
    for (const b of t.boxes) { b.pos.x += ox; b.pos.z += oz; sel.push({ type: "box", index: this.model.boxes.push(b) - 1 }); }
    for (const r of t.ramps) { r.pos.x += ox; r.pos.z += oz; sel.push({ type: "ramp", index: this.model.ramps.push(r) - 1 }); }
    for (const p of t.pads) { p.pos.x += ox; p.pos.z += oz; sel.push({ type: "pad", index: this.model.pads.push(p) - 1 }); }
    this.selection = sel;
    this.build();
    this.showProps();
  }

  private nudge(dx: number, dy: number, dz: number) {
    if (!this.selection.length) return;
    this.pushHistory();
    const step = this.snap ? this.snapSize : 1;
    for (const s of this.selection) {
      const p = this.posRef(s);
      p.x = r2(p.x + dx * step); p.y = r2(p.y + dy * step); p.z = r2(p.z + dz * step);
    }
    this.build();
    this.showProps();
  }

  /** Select every object in the scene (Ctrl+A). */
  private selectAll() {
    const types: SelType[] = ["box", "pad", "ramp", "light", "emitter", "hazard", "platform", "spawn"];
    this.selection = types.flatMap((t) => this.listOf(t).map((_, index) => ({ type: t, index })));
    this.refreshHighlight();
    this.attachGizmo();
    this.refreshList();
    this.showProps();
  }

  private focusSelection() {
    const p = this.selectedPicks().pop();
    if (!p) return;
    const box = new THREE.Box3().setFromObject(p.obj);
    const c = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 6;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(Math.max(radius * 3, 12)));
  }

  // ---- history ------------------------------------------------------------
  private pushHistory() {
    const snap = clone(this.model);
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
    this.undoStack.push(snap);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  private undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(clone(this.model));
    this.model = this.undoStack.pop()!;
    this.selection = [];
    this.syncMapFields(); this.build(); this.showProps();
  }
  private redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(clone(this.model));
    this.model = this.redoStack.pop()!;
    this.selection = [];
    this.syncMapFields(); this.build(); this.showProps();
  }

  // ---- load / save --------------------------------------------------------
  private loadMap(map: GameMap) {
    this.model = {
      name: map.name, bounds: map.bounds,
      spawns: clone(map.spawns), boxes: clone(map.boxes), pads: clone(map.pads ?? []), ramps: clone(map.ramps ?? []),
      lights: clone(map.lights ?? []), emitters: clone(map.emitters ?? []),
      hazards: clone(map.hazards ?? []), platforms: clone(map.platforms ?? []),
    };
    this.selection = [];
    this.undoStack = []; this.redoStack = [];
    this.syncMapFields();
    this.build();
    this.showProps();
  }
  private exportJSON() {
    const out: GameMap = {
      name: this.model.name, bounds: this.model.bounds,
      spawns: this.model.spawns, boxes: this.model.boxes,
      ...(this.model.pads.length ? { pads: this.model.pads } : {}),
      ...(this.model.ramps.length ? { ramps: this.model.ramps } : {}),
      ...(this.model.lights.length ? { lights: this.model.lights } : {}),
      ...(this.model.emitters.length ? { emitters: this.model.emitters } : {}),
      ...(this.model.hazards.length ? { hazards: this.model.hazards } : {}),
      ...(this.model.platforms.length ? { platforms: this.model.platforms } : {}),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (this.model.name || "map").toLowerCase().replace(/\s+/g, "_") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  private importJSON(text: string) {
    try {
      this.loadMap(JSON.parse(text) as GameMap);
    } catch {
      alert("Invalid map JSON");
    }
  }

  // ---- UI -----------------------------------------------------------------
  private syncMapFields() {
    ($("m-name") as HTMLInputElement).value = this.model.name;
    ($("m-bounds") as HTMLInputElement).value = String(this.model.bounds);
  }
  private refreshCounts() {
    const m = this.model;
    const parts = [
      `${m.boxes.length} boxes`, `${m.pads.length} pads`,
      ...(m.ramps.length ? [`${m.ramps.length} ramps`] : []),
      ...(m.lights.length ? [`${m.lights.length} lights`] : []),
      ...(m.emitters.length ? [`${m.emitters.length} emitters`] : []),
      ...(m.hazards.length ? [`${m.hazards.length} hazards`] : []),
      ...(m.platforms.length ? [`${m.platforms.length} platforms`] : []),
      `${m.spawns.length} spawns`,
    ];
    $("counts").textContent = parts.join(" · ");
  }
  private refreshList() {
    const el = $("objlist");
    el.innerHTML = "";
    const add = (label: string, s: SelObj) => {
      const row = document.createElement("div");
      row.className = "obj-row" + (this.isSelected(s) ? " active" : "");
      row.textContent = label;
      row.onclick = (e) => this.select(s, e.ctrlKey || e.metaKey);
      el.appendChild(row);
    };
    this.model.boxes.forEach((b, i) => add(`${b.shape ?? "box"} ${i}`, { type: "box", index: i }));
    this.model.ramps.forEach((_, i) => add(`ramp ${i}`, { type: "ramp", index: i }));
    this.model.pads.forEach((_, i) => add(`pad ${i}`, { type: "pad", index: i }));
    this.model.lights.forEach((_, i) => add(`light ${i}`, { type: "light", index: i }));
    this.model.emitters.forEach((_, i) => add(`emitter ${i}`, { type: "emitter", index: i }));
    this.model.hazards.forEach((_, i) => add(`hazard ${i}`, { type: "hazard", index: i }));
    this.model.platforms.forEach((_, i) => add(`platform ${i}`, { type: "platform", index: i }));
    this.model.spawns.forEach((_, i) => add(`spawn ${i}`, { type: "spawn", index: i }));
  }

  private bindUI(canvas: HTMLCanvasElement) {
    // Click-select that ignores camera drags.
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.pick(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
      down = null;
    });

    $("add-box").onclick = () => this.addBox();
    ($("add-shape") as HTMLSelectElement).addEventListener("change", (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.value) this.addBox(sel.value as BoxShape);
      sel.value = "";
    });
    $("add-pad").onclick = () => this.addPad();
    $("add-light").onclick = () => this.addLight();
    $("add-emitter").onclick = () => this.addEmitter();
    $("add-hazard").onclick = () => this.addHazard();
    $("add-platform").onclick = () => this.addPlatform();
    $("add-spawn").onclick = () => this.addSpawn();
    document.querySelectorAll<HTMLElement>(".mode").forEach((b) =>
      (b.onclick = () => this.setMode(b.dataset.mode as Mode)));
    $("anchor").onclick = () => { this.anchored = !this.anchored; $("anchor").classList.toggle("active", this.anchored); };
    ($("snap-on") as HTMLInputElement).addEventListener("change", (e) => { this.snap = (e.target as HTMLInputElement).checked; this.applySnap(); });
    ($("snap-size") as HTMLInputElement).addEventListener("change", (e) => { this.snapSize = Math.max(0.1, Number((e.target as HTMLInputElement).value) || 1); this.applySnap(); });
    $("undo").onclick = () => this.undo();
    $("redo").onclick = () => this.redo();
    $("duplicate").onclick = () => this.duplicate();
    $("delete").onclick = () => this.del();
    $("export").onclick = () => this.exportJSON();
    $("import").onclick = () => ($("file") as HTMLInputElement).click();
    ($("file") as HTMLInputElement).addEventListener("change", (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) f.text().then((t) => this.importJSON(t));
    });
    ($("load-map") as HTMLSelectElement).addEventListener("change", (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (id && MAPS[id]) this.loadMap(MAPS[id]);
      else { this.model = blank(); this.selection = []; this.undoStack = []; this.redoStack = []; this.syncMapFields(); this.build(); this.showProps(); }
    });

    ($("m-name") as HTMLInputElement).addEventListener("input", (e) => (this.model.name = (e.target as HTMLInputElement).value));
    ($("m-bounds") as HTMLInputElement).addEventListener("change", (e) => {
      this.pushHistory();
      this.model.bounds = Math.max(8, Number((e.target as HTMLInputElement).value) || 40);
      this.build();
    });

    // Property inputs: live-apply on edit; snapshot once when a field gains focus.
    const numIds = [
      "p-px", "p-py", "p-pz", "p-sx", "p-sy", "p-sz", "p-rx", "p-ry", "p-rz",
      "p-str", "p-yaw", "p-pitch", "p-lint", "p-lrange", "p-erate", "p-eyaw", "p-epitch",
      "p-hdps", "p-tx", "p-ty", "p-tz", "p-period", "p-color", "p-emi", "p-emi-on",
    ];
    for (const id of numIds) $(id).addEventListener("input", () => this.applyProps());
    for (const id of [...numIds, "p-shape", "p-dir"]) $(id).addEventListener("focus", () => this.pushHistory());
    // Texture dropdown: "auto", "none", then each texture key.
    const texSel = $("p-texture") as HTMLSelectElement;
    for (const [val, label] of [["", "auto"], ["none", "none (color)"], ...TEXTURE_KEYS.map((k) => [k, k] as const)]) {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      texSel.appendChild(o);
    }
    texSel.addEventListener("focus", () => this.pushHistory());
    texSel.addEventListener("change", () => this.applyProps());
    ($("p-shape") as HTMLSelectElement).addEventListener("change", () => this.applyProps());
    ($("p-dir") as HTMLSelectElement).addEventListener("change", () => this.applyProps());

    // Prebuilt palette with hover 3D preview.
    const grid = $("prebuilt-grid");
    for (const tpl of PREBUILTS) {
      const btn = document.createElement("button");
      btn.className = "prebuilt";
      btn.textContent = tpl.name;
      btn.onmouseenter = () => this.preview.show(tpl.name, tpl.make(), btn.getBoundingClientRect());
      btn.onmouseleave = () => this.preview.hide();
      btn.onclick = () => { this.preview.hide(); this.addPrebuilt(tpl.make()); };
      grid.appendChild(btn);
    }

    // Track Shift globally so a scale drag can read it for uniform scaling.
    addEventListener("keydown", (e) => { if (e.key === "Shift") this.shiftDown = true; });
    addEventListener("keyup", (e) => { if (e.key === "Shift") this.shiftDown = false; });

    window.addEventListener("keydown", (e) => {
      const typing = document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes((document.activeElement as HTMLElement).tagName);
      if (typing) return; // let inputs handle their own keys (incl. native ctrl-z)
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.code === "KeyZ") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (ctrl && e.code === "KeyY") { e.preventDefault(); this.redo(); return; }
      if (ctrl && e.code === "KeyD") { e.preventDefault(); this.duplicate(); return; }
      if (ctrl && e.code === "KeyA") { e.preventDefault(); this.selectAll(); return; }
      if (e.code === "Escape") { this.select(null); return; }
      if (e.key === "Delete" || e.key === "Backspace") this.del();
      if (e.code === "KeyW") this.setMode("translate");
      if (e.code === "KeyE") this.setMode("rotate");
      if (e.code === "KeyR") this.setMode("scale");
      if (e.code === "KeyF") this.focusSelection();
      // Arrows nudge on X/Z; hold Shift to nudge vertically.
      if (e.code === "ArrowLeft") { e.preventDefault(); this.nudge(-1, 0, 0); }
      if (e.code === "ArrowRight") { e.preventDefault(); this.nudge(1, 0, 0); }
      if (e.code === "ArrowUp") { e.preventDefault(); this.nudge(0, e.shiftKey ? 1 : 0, e.shiftKey ? 0 : -1); }
      if (e.code === "ArrowDown") { e.preventDefault(); this.nudge(0, e.shiftKey ? -1 : 0, e.shiftKey ? 0 : 1); }
    });
    this.syncMapFields();
  }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px";
    this.renderer.domElement.style.height = h + "px";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.controls.update();
    // keep selection outlines locked to live mesh transforms (e.g. during drags)
    const picks = this.selectedPicks();
    this.outlines.forEach((h, i) => { if (h.visible && picks[i]) h.box.setFromObject(picks[i].obj); });
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.loop);
  };
}

// ---- shared mesh builders (also used by the prebuilt preview) -------------
function rampMesh(r: Ramp, textured: boolean): THREE.Mesh {
  const alongX = r.dir === 0 || r.dir === 1;
  const L = alongX ? r.size.x : r.size.z;
  const angle = Math.atan2(r.size.y, L);
  const hyp = Math.hypot(L, r.size.y);
  const thick = 0.5;
  const dx = alongX ? hyp : r.size.x;
  const dz = alongX ? r.size.z : hyp;
  const geo = new THREE.BoxGeometry(dx, thick, dz);
  let mat: THREE.MeshStandardMaterial;
  if (textured) {
    const key = textureForBox({ pos: r.pos, size: r.size, color: r.color, emissive: r.emissive, texture: r.texture }) ?? "walls_dark";
    applyBoxUV(geo, { x: dx, y: thick, z: dz }, key);
    const t = getTexture(key);
    mat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: r.emissive ?? 0x666666, emissiveIntensity: 0.2, roughness: 0.9, metalness: 0.05 });
  } else {
    mat = new THREE.MeshStandardMaterial({ color: r.color, emissive: r.emissive ?? 0x000000, emissiveIntensity: r.emissive ? 0.4 : 0, roughness: 0.9 });
  }
  const m = new THREE.Mesh(geo, mat);
  m.position.set(r.pos.x, r.pos.y + r.size.y / 2 - thick * 0.4, r.pos.z);
  if (r.dir === 0) m.rotation.z = angle;
  else if (r.dir === 1) m.rotation.z = -angle;
  else if (r.dir === 2) m.rotation.x = -angle;
  else m.rotation.x = angle;
  return m;
}

/** Flat-shaded (untextured) meshes for a template — used by the hover preview. */
function flatMeshes(data: PrebuiltData): THREE.Group {
  const g = new THREE.Group();
  for (const b of data.boxes) {
    const m = new THREE.Mesh(
      shapeGeometry(b.shape, b.size),
      new THREE.MeshStandardMaterial({ color: b.color, emissive: b.emissive ?? 0x000000, emissiveIntensity: b.emissive ? 0.5 : 0, roughness: 0.8, metalness: 0.1 }),
    );
    m.position.set(b.pos.x, b.pos.y, b.pos.z);
    if (b.rot) m.rotation.set(b.rot.x, b.rot.y, b.rot.z);
    g.add(m);
  }
  for (const r of data.ramps) g.add(rampMesh(r, false));
  for (const p of data.pads) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z), new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.9 }));
    m.position.set(p.pos.x, p.pos.y, p.pos.z);
    g.add(m);
  }
  return g;
}

// ---- prebuilt 3D preview popup --------------------------------------------
class PrebuiltPreview {
  private el = $("preview-pop") as HTMLDivElement;
  private nameEl = document.createElement("div");
  private canvas = document.createElement("canvas");
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  private group = new THREE.Group();
  private raf = 0;
  private dist = 30;
  private readonly W = 190;
  private readonly H = 150;

  constructor() {
    this.nameEl.className = "pv-name";
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.el.append(this.nameEl, this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setSize(this.W, this.H, false);
    this.renderer.setPixelRatio(devicePixelRatio);
    this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x101018, 1.2));
    const d = new THREE.DirectionalLight(0xffffff, 0.95); d.position.set(6, 12, 8); this.scene.add(d);
    this.scene.add(this.group);
    this.camera.aspect = this.W / this.H;
  }

  show(name: string, data: PrebuiltData, anchor: DOMRect) {
    this.group.clear();
    const g = flatMeshes(data);
    const box = new THREE.Box3().setFromObject(g);
    const c = box.getCenter(new THREE.Vector3());
    g.position.sub(c); // recentre content at the group origin
    this.group.add(g);
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 6;
    this.dist = radius / Math.tan(d2r(22.5)) * 1.15 + 2;
    this.group.rotation.y = 0.6;
    this.nameEl.textContent = name;
    this.el.style.left = Math.max(8, anchor.left - this.W - 18) + "px";
    this.el.style.top = Math.min(innerHeight - this.H - 28, Math.max(50, anchor.top - 10)) + "px";
    this.el.classList.remove("hidden");
    if (!this.raf) this.loop();
  }

  hide() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.el.classList.add("hidden");
  }

  private loop = () => {
    this.group.rotation.y += 0.013;
    this.camera.position.set(0, this.dist * 0.55, this.dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };
}

// ---- prebuilt templates ---------------------------------------------------
const bx = (pos: Vec3, size: Vec3, color: number, emissive?: number, shape?: BoxShape): MapBox => ({ pos, size, color, ...(emissive !== undefined ? { emissive } : {}), ...(shape ? { shape } : {}) });

const PREBUILTS: { name: string; make: () => PrebuiltData }[] = [
  { name: "Cover Wall", make: () => ({ boxes: [bx(v3(0, 2, 0), v3(8, 4, 1), SLATE2, CYAN)], pads: [], ramps: [] }) },
  { name: "Crate Stack", make: () => ({ boxes: [
    bx(v3(0, 1.5, 0), v3(3, 3, 3), SLATE2, AMBER),
    bx(v3(0.2, 4.2, 0.3), v3(2.4, 2.4, 2.4), SLATE2, AMBER),
    bx(v3(2.4, 1.1, -0.4), v3(2.2, 2.2, 2.2), SLATE2, AMBER),
  ], pads: [], ramps: [] }) },
  { name: "Pillar", make: () => ({ boxes: [bx(v3(0, 4.5, 0), v3(2.4, 9, 2.4), SLATE3, CYAN, "cylinder")], pads: [], ramps: [] }) },
  { name: "Dome", make: () => ({ boxes: [bx(v3(0, 0, 0), v3(8, 6, 8), SLATE2, CYAN, "sphere")], pads: [], ramps: [] }) },
  { name: "Watchtower", make: () => ({ boxes: [
    bx(v3(-2.5, 4, -2.5), v3(0.8, 8, 0.8), SLATE3, PINK),
    bx(v3(2.5, 4, -2.5), v3(0.8, 8, 0.8), SLATE3, PINK),
    bx(v3(-2.5, 4, 2.5), v3(0.8, 8, 0.8), SLATE3, PINK),
    bx(v3(2.5, 4, 2.5), v3(0.8, 8, 0.8), SLATE3, PINK),
    bx(v3(0, 8.3, 0), v3(7, 0.6, 7), SLATE2, PINK),
  ], pads: [], ramps: [] }) },
  { name: "Stairs", make: () => ({ boxes: [0, 1, 2, 3, 4].map((i) =>
    bx(v3(0, (i + 1) / 2, i * 2), v3(5, i + 1, 2), SLATE2, CYAN)), pads: [], ramps: [] }) },
  { name: "Ramp + Deck", make: () => ({
    boxes: [
      bx(v3(0, 2, 0), v3(8, 4, 6), SLATE2, CYAN, "wedge"),
      bx(v3(-5.5, 2, 0), v3(3, 4, 6), SLATE2, CYAN),
    ], pads: [], ramps: [],
  }) },
  { name: "Wedge", make: () => ({ boxes: [bx(v3(0, 2, 0), v3(7, 4, 7), SLATE3, CYAN, "wedge")], pads: [], ramps: [] }) },
  { name: "Doorway", make: () => ({ boxes: [
    bx(v3(-3, 3, 0), v3(1.5, 6, 1.5), SLATE2, PINK),
    bx(v3(3, 3, 0), v3(1.5, 6, 1.5), SLATE2, PINK),
    bx(v3(0, 6.75, 0), v3(8, 1.5, 1.5), SLATE2, PINK),
  ], pads: [], ramps: [] }) },
  { name: "Bunker", make: () => ({ boxes: [
    bx(v3(0, 1.5, -3.5), v3(8, 3, 1), SLATE, GREEN),
    bx(v3(-3.5, 1.5, 0), v3(1, 3, 8), SLATE, GREEN),
    bx(v3(3.5, 1.5, 0), v3(1, 3, 8), SLATE, GREEN),
  ], pads: [], ramps: [] }) },
  { name: "Pyramid", make: () => ({ boxes: [
    bx(v3(0, 1, 0), v3(8, 2, 8), SLATE3, AMBER),
    bx(v3(0, 3, 0), v3(5.5, 2, 5.5), SLATE3, AMBER),
    bx(v3(0, 5, 0), v3(3, 2, 3), SLATE3, AMBER),
  ], pads: [], ramps: [] }) },
  { name: "Jump Tower", make: () => ({
    boxes: [bx(v3(0, 6, 0), v3(5, 12, 5), DARK, CYAN)],
    pads: [{ pos: v3(0, 0.1, 6), size: v3(5, 0.2, 5), launch: v3(0, 22, 0), color: CYAN }],
    ramps: [],
  }) },
  { name: "Pillar Ring", make: () => ({
    boxes: [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * Math.PI * 2;
      return bx(v3(r2(Math.cos(a) * 6), 4, r2(Math.sin(a) * 6)), v3(1.6, 8, 1.6), SLATE3, CYAN, "cylinder");
    }), pads: [], ramps: [],
  }) },
  { name: "Half-Pipe", make: () => ({
    boxes: [
      bx(v3(-5, 2, 0), v3(6, 4, 8), SLATE2, PINK, "wedge"),
      { ...bx(v3(5, 2, 0), v3(6, 4, 8), SLATE2, PINK, "wedge"), rot: v3(0, Math.PI, 0) },
    ], pads: [], ramps: [],
  }) },
  { name: "Orb Tower", make: () => ({
    boxes: [
      bx(v3(0, 4, 0), v3(2.2, 8, 2.2), SLATE3, VIOLET, "cylinder"),
      bx(v3(0, 9, 0), v3(3.2, 3.2, 3.2), SLATE3, VIOLET, "sphere"),
    ], pads: [], ramps: [],
  }) },
  { name: "Catwalk", make: () => ({
    boxes: [
      bx(v3(0, 5, 0), v3(14, 0.6, 2.4), SLATE2, GREEN),
      bx(v3(-6.5, 2.5, 0), v3(1, 5, 2.4), SLATE3, GREEN),
      bx(v3(6.5, 2.5, 0), v3(1, 5, 2.4), SLATE3, GREEN),
    ], pads: [], ramps: [],
  }) },
  { name: "Launch + Pad", make: () => ({
    boxes: [bx(v3(0, 4, -10), v3(8, 8, 4), DARK, AMBER)],
    pads: [{ pos: v3(0, 0.1, 0), size: v3(5, 0.2, 5), launch: v3(0, 16, -12), color: AMBER }],
    ramps: [],
  }) },
];

// ---- helpers --------------------------------------------------------------
function blank(): Model {
  return {
    name: "Untitled", bounds: 40, spawns: [v3(0, 0, 0)],
    boxes: [{ pos: v3(0, -0.5, 0), size: v3(80, 1, 80), color: DARK }],
    pads: [], ramps: [], lights: [], emitters: [], hazards: [], platforms: [],
  };
}
function setNum(id: string, n: number) { ($(id) as HTMLInputElement).value = String(Math.round(n * 100) / 100); }
function getNum(id: string) { return Number(($(id) as HTMLInputElement).value) || 0; }

new Editor($("view") as HTMLCanvasElement);
