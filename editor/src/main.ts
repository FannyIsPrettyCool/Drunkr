import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MAPS, type GameMap, type MapBox, type JumpPad, type Vec3 } from "@drunkr/shared";

type Model = {
  name: string;
  bounds: number;
  spawns: Vec3[];
  boxes: MapBox[];
  pads: JumpPad[];
};
type SelObj = { type: "box" | "pad" | "spawn"; index: number };
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
      const mat = new THREE.MeshStandardMaterial({
        color: b.color, emissive: b.emissive ?? 0x000000,
        emissiveIntensity: b.emissive ? 0.5 : 0, roughness: 0.8, metalness: 0.1,
      });
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z), mat);
      m.position.set(b.pos.x, b.pos.y, b.pos.z);
      this.group.add(m);
      this.picks.push({ obj: m, type: { type: "box", index } });
    });

    this.model.pads.forEach((p, index) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z),
        new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.9 }),
      );
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      this.group.add(m);
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(p.launch.x, p.launch.y, p.launch.z).normalize(),
        new THREE.Vector3(p.pos.x, p.pos.y + 0.4, p.pos.z), 4, p.color,
      );
      this.group.add(arrow);
      this.picks.push({ obj: m, type: { type: "pad", index } });
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
    this.showProps();
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
    this.refreshList();
  }

  // ---- property panel -----------------------------------------------------
  private showProps() {
    const props = $("props");
    if (!this.sel) { props.classList.add("hidden"); return; }
    props.classList.remove("hidden");
    const { type, index } = this.sel;
    $("prop-title").textContent = type.toUpperCase();
    $("props").querySelector(".size-fields")!.classList.toggle("hidden", type === "spawn");
    $("props").querySelector(".color-fields")!.classList.toggle("hidden", type === "spawn");
    $("props").querySelector(".launch-fields")!.classList.toggle("hidden", type !== "pad");

    const pos = type === "box" ? this.model.boxes[index].pos
      : type === "pad" ? this.model.pads[index].pos
      : this.model.spawns[index];
    setNum("p-px", pos.x); setNum("p-py", pos.y); setNum("p-pz", pos.z);

    if (type === "box" || type === "pad") {
      const size = type === "box" ? this.model.boxes[index].size : this.model.pads[index].size;
      setNum("p-sx", size.x); setNum("p-sy", size.y); setNum("p-sz", size.z);
      const color = type === "box" ? this.model.boxes[index].color : this.model.pads[index].color;
      ($("p-color") as HTMLInputElement).value = hex(color);
    }
    if (type === "box") {
      const emi = this.model.boxes[index].emissive;
      ($("p-emi-on") as HTMLInputElement).checked = emi !== undefined;
      ($("p-emi") as HTMLInputElement).value = hex(emi ?? color0(this.model.boxes[index].color));
    }
    if (type === "pad") {
      const l = this.model.pads[index].launch;
      setNum("p-lx", l.x); setNum("p-ly", l.y); setNum("p-lz", l.z);
    }
  }

  private applyProps() {
    if (!this.sel) return;
    const { type, index } = this.sel;
    const pos = type === "box" ? this.model.boxes[index].pos
      : type === "pad" ? this.model.pads[index].pos
      : this.model.spawns[index];
    pos.x = getNum("p-px"); pos.y = getNum("p-py"); pos.z = getNum("p-pz");
    if (type === "box" || type === "pad") {
      const obj = type === "box" ? this.model.boxes[index] : this.model.pads[index];
      obj.size.x = Math.max(0.1, getNum("p-sx"));
      obj.size.y = Math.max(0.1, getNum("p-sy"));
      obj.size.z = Math.max(0.1, getNum("p-sz"));
      obj.color = toNum(($("p-color") as HTMLInputElement).value);
    }
    if (type === "box") {
      const b = this.model.boxes[index];
      b.emissive = ($("p-emi-on") as HTMLInputElement).checked
        ? toNum(($("p-emi") as HTMLInputElement).value) : undefined;
    }
    if (type === "pad") {
      const l = this.model.pads[index].launch;
      l.x = getNum("p-lx"); l.y = getNum("p-ly"); l.z = getNum("p-lz");
    }
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
  private addSpawn() {
    this.model.spawns.push(v3(0, 0, 0));
    this.select({ type: "spawn", index: this.model.spawns.length - 1 });
    this.build();
  }
  private duplicate() {
    if (!this.sel) return;
    const { type, index } = this.sel;
    if (type === "box") { this.model.boxes.push(clone(this.model.boxes[index])); this.model.boxes.at(-1)!.pos.x += 3; this.select({ type, index: this.model.boxes.length - 1 }); }
    else if (type === "pad") { this.model.pads.push(clone(this.model.pads[index])); this.model.pads.at(-1)!.pos.x += 3; this.select({ type, index: this.model.pads.length - 1 }); }
    else { this.model.spawns.push(clone(this.model.spawns[index])); this.select({ type, index: this.model.spawns.length - 1 }); }
    this.build();
  }
  private del() {
    if (!this.sel) return;
    const { type, index } = this.sel;
    if (type === "box") this.model.boxes.splice(index, 1);
    else if (type === "pad") this.model.pads.splice(index, 1);
    else this.model.spawns.splice(index, 1);
    this.sel = null;
    this.build();
  }

  // ---- load / save --------------------------------------------------------
  private loadMap(map: GameMap) {
    this.model = {
      name: map.name, bounds: map.bounds,
      spawns: clone(map.spawns), boxes: clone(map.boxes), pads: clone(map.pads ?? []),
    };
    this.sel = null;
    this.syncMapFields();
    this.build();
  }
  private exportJSON() {
    const out: GameMap = {
      name: this.model.name, bounds: this.model.bounds,
      spawns: this.model.spawns, boxes: this.model.boxes,
      ...(this.model.pads.length ? { pads: this.model.pads } : {}),
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
      `${this.model.boxes.length} boxes · ${this.model.pads.length} pads · ${this.model.spawns.length} spawns`;
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
    $("add-spawn").onclick = () => this.addSpawn();
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
    window.addEventListener("keydown", (e) => {
      if (e.key === "Delete" && this.sel) this.del();
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
  return { name: "Untitled", bounds: 40, spawns: [v3(0, 0, 0)], boxes: [{ pos: v3(0, -0.5, 0), size: v3(80, 1, 80), color: 0x12131c }], pads: [] };
}
function color0(c: number) { return c; }
function setNum(id: string, n: number) { ($(id) as HTMLInputElement).value = String(Math.round(n * 100) / 100); }
function getNum(id: string) { return Number(($(id) as HTMLInputElement).value) || 0; }

new Editor($("view") as HTMLCanvasElement);
