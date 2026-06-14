import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { MAPS, textureForBox, TEXTURE_KEYS, type GameMap, type MapBox, type JumpPad, type Ramp, type Vec3 } from "@drunkr/shared";
import { getTexture, applyBoxUV } from "./textures.js";

type Model = {
  name: string;
  bounds: number;
  spawns: Vec3[];
  boxes: MapBox[];
  pads: JumpPad[];
  ramps: Ramp[];
};
type SelObj = { type: "box" | "pad" | "spawn" | "ramp"; index: number };
type Sel = SelObj | null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const toNum = (s: string) => parseInt(s.slice(1), 16);
const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

class Editor {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private gizmo!: TransformControls;
  private raycaster = new THREE.Raycaster();
  private group = new THREE.Group();
  private box = new THREE.Box3Helper(new THREE.Box3(), 0xffd33d);
  private picks: { obj: THREE.Object3D; type: SelObj }[] = [];
  private model: Model = blank();
  private sel: Sel = null;

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
      if (!e.value) this.afterDrag(); // rebuild + reattach when the drag ends
    });
    this.gizmo.addEventListener("objectChange", () => this.writeBack());
    this.scene.add(this.gizmo.getHelper());

    this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x101018, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(30, 60, 20);
    this.scene.add(dir);
    this.scene.add(this.group);
    this.box.visible = false;
    this.scene.add(this.box);

    this.resize();
    addEventListener("resize", () => this.resize());
    this.bindUI(canvas);
    this.build();
    this.loop();
  }

  // ---- scene build --------------------------------------------------------
  private build() {
    this.group.clear();
    this.picks = [];

    // Ground grid sized to bounds.
    const grid = new THREE.GridHelper(this.model.bounds * 2, this.model.bounds, 0x2a3050, 0x161a2c);
    this.group.add(grid);

    this.model.boxes.forEach((b, index) => {
      const geo = new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z);
      const tex = textureForBox(b);
      let mat: THREE.MeshStandardMaterial;
      if (tex) {
        applyBoxUV(geo, b.size, tex);
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
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z),
        new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.9 }),
      );
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      if (p.rot) m.rotation.set(p.rot.x, p.rot.y, p.rot.z);
      this.group.add(m);
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(p.launch.x, p.launch.y, p.launch.z).normalize(),
        new THREE.Vector3(p.pos.x, p.pos.y + 0.4, p.pos.z), 4, p.color,
      );
      this.group.add(arrow);
      this.picks.push({ obj: m, type: { type: "pad", index } });
    });

    this.model.ramps.forEach((r, index) => {
      const alongX = r.dir === 0 || r.dir === 1;
      const L = alongX ? r.size.x : r.size.z;
      const angle = Math.atan2(r.size.y, L);
      const hyp = Math.hypot(L, r.size.y);
      const thick = 0.5;
      const dx = alongX ? hyp : r.size.x;
      const dz = alongX ? r.size.z : hyp;
      const geo = new THREE.BoxGeometry(dx, thick, dz);
      const key = textureForBox({ pos: r.pos, size: r.size, color: r.color, emissive: r.emissive, texture: r.texture }) ?? "walls_dark";
      applyBoxUV(geo, { x: dx, y: thick, z: dz }, key);
      const t = getTexture(key);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: t, emissiveMap: t, emissive: r.emissive ?? 0x666666, emissiveIntensity: 0.2, roughness: 0.9, metalness: 0.05,
      }));
      m.position.set(r.pos.x, r.pos.y + r.size.y / 2 - thick * 0.4, r.pos.z);
      if (r.dir === 0) m.rotation.z = angle;
      else if (r.dir === 1) m.rotation.z = -angle;
      else if (r.dir === 2) m.rotation.x = -angle;
      else m.rotation.x = angle;
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

  private refreshHighlight() {
    const e = this.sel && this.picks.find((p) => p.type.type === this.sel!.type && p.type.index === this.sel!.index);
    if (e) {
      this.box.box.setFromObject(e.obj);
      this.box.visible = true;
    } else {
      this.box.visible = false;
    }
    // NOTE: do not refresh the property inputs here — applyProps() rebuilds the
    // scene on every keystroke and we must not clobber the field being typed.
  }

  // ---- selection ----------------------------------------------------------
  private pick(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.picks.map((p) => p.obj), false)[0];
    if (!hit) return;
    const e = this.picks.find((p) => p.obj === hit.object);
    if (e) this.select(e.type);
  }

  private select(s: Sel) {
    this.sel = s;
    this.refreshHighlight();
    this.attachGizmo();
    this.refreshList();
    this.showProps(); // repopulate inputs only when the selection changes
  }

  private attachGizmo() {
    const e = this.sel && this.picks.find((p) => p.type.type === this.sel!.type && p.type.index === this.sel!.index);
    if (e) this.gizmo.attach(e.obj);
    else this.gizmo.detach();
  }

  private setMode(mode: "translate" | "rotate" | "scale") {
    this.gizmo.setMode(mode);
    document.querySelectorAll<HTMLElement>(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  }

  /** Write the dragged mesh's transform back into the data model. */
  private writeBack() {
    const obj = this.gizmo.object as THREE.Mesh | undefined;
    if (!obj || !this.sel) return;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const r4 = (n: number) => Math.round(n * 1000) / 1000;
    const { type, index } = this.sel;
    if (type === "spawn") {
      const s = this.model.spawns[index];
      s.x = r2(obj.position.x); s.y = r2(obj.position.y - 1.2); s.z = r2(obj.position.z);
    } else if (type === "ramp") {
      // The ramp mesh is a rotated/offset slab — only translate maps cleanly;
      // size/dir are edited in the panel.
      const r = this.model.ramps[index];
      r.pos.x = r2(obj.position.x); r.pos.z = r2(obj.position.z);
      r.pos.y = r2(obj.position.y - r.size.y / 2 + 0.2);
    } else {
      const o = type === "box" ? this.model.boxes[index] : this.model.pads[index];
      o.pos.x = r2(obj.position.x); o.pos.y = r2(obj.position.y); o.pos.z = r2(obj.position.z);
      const geo = obj.geometry as THREE.BoxGeometry;
      o.size.x = Math.max(0.1, r2(geo.parameters.width * obj.scale.x));
      o.size.y = Math.max(0.1, r2(geo.parameters.height * obj.scale.y));
      o.size.z = Math.max(0.1, r2(geo.parameters.depth * obj.scale.z));
      const e = obj.rotation;
      o.rot = e.x || e.y || e.z ? { x: r4(e.x), y: r4(e.y), z: r4(e.z) } : undefined;
    }
    this.showProps();
  }

  /** After a gizmo drag, rebuild so scale bakes into geometry, then reattach. */
  private afterDrag() {
    this.build();
  }

  // ---- property panel -----------------------------------------------------
  private showProps() {
    const props = $("props");
    if (!this.sel) { props.classList.add("hidden"); return; }
    props.classList.remove("hidden");
    const { type, index } = this.sel;
    $("prop-title").textContent = type.toUpperCase();
    const solid = type === "box" || type === "ramp"; // has color, emissive, texture
    $("props").querySelector(".size-fields")!.classList.toggle("hidden", type === "spawn");
    $("props").querySelector(".color-fields")!.classList.toggle("hidden", type === "spawn");
    $("props").querySelector(".launch-fields")!.classList.toggle("hidden", type !== "pad");
    $("props").querySelector(".texture-fields")!.classList.toggle("hidden", !solid);
    $("props").querySelector(".dir-fields")!.classList.toggle("hidden", type !== "ramp");

    const obj = this.getObj();
    const pos = type === "spawn" ? this.model.spawns[index] : (obj as MapBox).pos;
    setNum("p-px", pos.x); setNum("p-py", pos.y); setNum("p-pz", pos.z);

    if (type !== "spawn") {
      const o = obj as MapBox | JumpPad | Ramp;
      setNum("p-sx", o.size.x); setNum("p-sy", o.size.y); setNum("p-sz", o.size.z);
      ($("p-color") as HTMLInputElement).value = hex(o.color);
    }
    if (solid) {
      const o = obj as MapBox | Ramp;
      ($("p-emi-on") as HTMLInputElement).checked = o.emissive !== undefined;
      ($("p-emi") as HTMLInputElement).value = hex(o.emissive ?? color0(o.color));
      ($("p-texture") as HTMLSelectElement).value = o.texture ?? "";
    }
    if (type === "pad") {
      const l = this.model.pads[index].launch;
      setNum("p-lx", l.x); setNum("p-ly", l.y); setNum("p-lz", l.z);
    }
    if (type === "ramp") ($("p-dir") as HTMLSelectElement).value = String(this.model.ramps[index].dir);
  }

  /** The currently-selected box/pad/ramp object (not spawns). */
  private getObj(): MapBox | JumpPad | Ramp {
    const { type, index } = this.sel!;
    return type === "box" ? this.model.boxes[index]
      : type === "pad" ? this.model.pads[index]
      : type === "ramp" ? this.model.ramps[index]
      : (this.model.spawns[index] as unknown as MapBox);
  }

  private applyProps() {
    if (!this.sel) return;
    const { type, index } = this.sel;
    const solid = type === "box" || type === "ramp";
    const pos = type === "spawn" ? this.model.spawns[index] : (this.getObj() as MapBox).pos;
    pos.x = getNum("p-px"); pos.y = getNum("p-py"); pos.z = getNum("p-pz");
    if (type !== "spawn") {
      const o = this.getObj() as MapBox | JumpPad | Ramp;
      o.size.x = Math.max(0.1, getNum("p-sx"));
      o.size.y = Math.max(0.1, getNum("p-sy"));
      o.size.z = Math.max(0.1, getNum("p-sz"));
      o.color = toNum(($("p-color") as HTMLInputElement).value);
    }
    if (solid) {
      const o = this.getObj() as MapBox | Ramp;
      o.emissive = ($("p-emi-on") as HTMLInputElement).checked ? toNum(($("p-emi") as HTMLInputElement).value) : undefined;
      o.texture = ($("p-texture") as HTMLSelectElement).value || undefined;
    }
    if (type === "pad") {
      const l = this.model.pads[index].launch;
      l.x = getNum("p-lx"); l.y = getNum("p-ly"); l.z = getNum("p-lz");
    }
    if (type === "ramp") this.model.ramps[index].dir = Number(($("p-dir") as HTMLSelectElement).value) || 0;
    this.build();
  }

  // ---- toolbar actions ----------------------------------------------------
  private addBox() {
    this.model.boxes.push({ pos: v3(0, 2, 0), size: v3(4, 4, 4), color: 0x2a2e45, emissive: 0x18e0ff });
    this.select({ type: "box", index: this.model.boxes.length - 1 });
    this.build();
  }
  private addPad() {
    this.model.pads.push({ pos: v3(0, 0.1, 0), size: v3(5, 0.2, 5), launch: v3(0, 15, 0), color: 0x18e0ff });
    this.select({ type: "pad", index: this.model.pads.length - 1 });
    this.build();
  }
  private addRamp() {
    this.model.ramps.push({ pos: v3(0, 0, 0), size: v3(6, 5, 12), dir: 2, color: 0x232639, emissive: 0x18e0ff });
    this.select({ type: "ramp", index: this.model.ramps.length - 1 });
    this.build();
  }
  private addSpawn() {
    this.model.spawns.push(v3(0, 0, 0));
    this.select({ type: "spawn", index: this.model.spawns.length - 1 });
    this.build();
  }
  private listOf(type: SelObj["type"]): unknown[] {
    return type === "box" ? this.model.boxes : type === "pad" ? this.model.pads
      : type === "ramp" ? this.model.ramps : this.model.spawns;
  }
  private duplicate() {
    if (!this.sel) return;
    const { type, index } = this.sel;
    const list = this.listOf(type) as { pos?: Vec3 }[] | Vec3[];
    const copy = clone((list as unknown[])[index]);
    if (type === "spawn") (copy as Vec3).x += 3;
    else (copy as { pos: Vec3 }).pos.x += 3;
    (list as unknown[]).push(copy);
    this.select({ type, index: (list as unknown[]).length - 1 });
    this.build();
  }
  private del() {
    if (!this.sel) return;
    const { type, index } = this.sel;
    (this.listOf(type) as unknown[]).splice(index, 1);
    this.sel = null;
    this.build();
    this.showProps();
  }

  // ---- load / save --------------------------------------------------------
  private loadMap(map: GameMap) {
    this.model = {
      name: map.name, bounds: map.bounds,
      spawns: clone(map.spawns), boxes: clone(map.boxes), pads: clone(map.pads ?? []), ramps: clone(map.ramps ?? []),
    };
    this.sel = null;
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
      const m = JSON.parse(text) as GameMap;
      this.loadMap(m);
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
    $("counts").textContent =
      `${this.model.boxes.length} boxes · ${this.model.ramps.length} ramps · ${this.model.pads.length} pads · ${this.model.spawns.length} spawns`;
  }
  private refreshList() {
    const el = $("objlist");
    el.innerHTML = "";
    const add = (label: string, s: Sel) => {
      const row = document.createElement("div");
      row.className = "obj-row" + (this.sel && s && this.sel.type === s.type && this.sel.index === s.index ? " active" : "");
      row.textContent = label;
      row.onclick = () => this.select(s);
      el.appendChild(row);
    };
    this.model.boxes.forEach((_, i) => add(`box ${i}`, { type: "box", index: i }));
    this.model.ramps.forEach((_, i) => add(`ramp ${i}`, { type: "ramp", index: i }));
    this.model.pads.forEach((_, i) => add(`pad ${i}`, { type: "pad", index: i }));
    this.model.spawns.forEach((_, i) => add(`spawn ${i}`, { type: "spawn", index: i }));
  }

  private bindUI(canvas: HTMLCanvasElement) {
    // Click-select that ignores camera drags.
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.pick(e.clientX, e.clientY);
      down = null;
    });

    $("add-box").onclick = () => this.addBox();
    $("add-pad").onclick = () => this.addPad();
    $("add-ramp").onclick = () => this.addRamp();
    $("add-spawn").onclick = () => this.addSpawn();
    document.querySelectorAll<HTMLElement>(".mode").forEach((b) =>
      (b.onclick = () => this.setMode(b.dataset.mode as "translate" | "rotate" | "scale")));
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
      else { this.model = blank(); this.sel = null; this.syncMapFields(); this.build(); }
    });

    ($("m-name") as HTMLInputElement).addEventListener("input", (e) => (this.model.name = (e.target as HTMLInputElement).value));
    ($("m-bounds") as HTMLInputElement).addEventListener("change", (e) => {
      this.model.bounds = Math.max(8, Number((e.target as HTMLInputElement).value) || 40);
      this.build();
    });

    for (const id of ["p-px", "p-py", "p-pz", "p-sx", "p-sy", "p-sz", "p-lx", "p-ly", "p-lz", "p-color", "p-emi", "p-emi-on"]) {
      const el = $(id) as HTMLInputElement;
      el.addEventListener("input", () => this.applyProps());
    }
    // Texture dropdown: "auto", "none", then each texture key.
    const texSel = $("p-texture") as HTMLSelectElement;
    for (const [val, label] of [["", "auto"], ["none", "none (color)"], ...TEXTURE_KEYS.map((k) => [k, k] as const)]) {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      texSel.appendChild(o);
    }
    texSel.addEventListener("change", () => this.applyProps());
    ($("p-dir") as HTMLSelectElement).addEventListener("change", () => this.applyProps());
    window.addEventListener("keydown", (e) => {
      const typing = document.activeElement && (document.activeElement as HTMLElement).tagName === "INPUT";
      if (typing) return;
      if (e.key === "Delete" && this.sel) this.del();
      if (e.code === "KeyW") this.setMode("translate");
      if (e.code === "KeyE") this.setMode("rotate");
      if (e.code === "KeyR") this.setMode("scale");
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
    if (this.box.visible) {
      const e = this.sel && this.picks.find((p) => p.type.type === this.sel!.type && p.type.index === this.sel!.index);
      if (e) this.box.box.setFromObject(e.obj);
    }
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.loop);
  };
}

// helper funcs
function blank(): Model {
  return { name: "Untitled", bounds: 40, spawns: [v3(0, 0, 0)], boxes: [{ pos: v3(0, -0.5, 0), size: v3(80, 1, 80), color: 0x12131c }], pads: [], ramps: [] };
}
function color0(c: number) { return c; }
function setNum(id: string, n: number) { ($(id) as HTMLInputElement).value = String(Math.round(n * 100) / 100); }
function getNum(id: string) { return Number(($(id) as HTMLInputElement).value) || 0; }

new Editor($("view") as HTMLCanvasElement);
