import * as THREE from "three";
import { MOVE, ABILITY_LIST, ABILITIES, sanitizeAbilities } from "@drunkr/shared";
import {
  loadLocker, saveLocker, type LockerData,
  WEAPON_SKINS, WEAPON_SKIN_LIST, SKIN_PARTS, SKINNABLE_WEAPONS, SKIN_HUES,
  skinToArr, arrToSkin, ACCESSORIES, ACCESSORY_LIST,
  type WeaponSkin,
} from "../render/cosmetics.js";
import { buildWeaponMesh } from "../render/weaponMesh.js";

const hex = (n: number) => "#" + (n & 0xffffff).toString(16).padStart(6, "0");
const parseHex = (s: string) => parseInt(s.replace("#", ""), 16) || 0;

/** Player's skin hue (for tinting the character/accessory preview). */
function playerHue(): number {
  return Number(localStorage.getItem("drunkr.skin") ?? 0.58);
}

/** A simple static mannequin matching the in-game avatar proportions. */
function buildMannequin(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({
    color, emissive: color.clone().multiplyScalar(0.5), emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.2,
  });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.3), body);
  torso.position.y = MOVE.height * 0.58;
  g.add(torso);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.34, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x0a0c18, emissive: color, emissiveIntensity: 0.4 }),
  );
  head.position.y = MOVE.height * 0.9;
  g.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.04), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  visor.position.set(0, MOVE.height * 0.9, 0.18);
  g.add(visor);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.16), body);
    arm.position.set(sx * 0.34, MOVE.height * 0.52, 0);
    g.add(arm);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.8, 0.24), body);
    leg.position.set(sx * 0.15, MOVE.height * 0.2, 0);
    g.add(leg);
  }
  return g;
}

/**
 * The Locker: customise per-weapon material colours (visible to everyone) and
 * pick an accessory, with a rotating weapon preview and a Minecraft-style
 * character preview that follows the mouse pointer.
 */
export class Locker {
  private root = document.getElementById("locker")!;
  private data: LockerData = loadLocker();
  private weaponId = "ak";
  /** Which ability slot the grid is currently editing (0 = F, 1 = C). */
  private abilSlot: 0 | 1 = 0;
  private onChange?: () => void;
  private onClose?: () => void;
  private onAbilities?: (abilities: string[]) => void;

  // Weapon preview.
  private wRenderer!: THREE.WebGLRenderer;
  private wScene = new THREE.Scene();
  private wCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  private wGroup = new THREE.Group();
  private wDist = 4;

  // Character preview (mouse-follow).
  private cRenderer!: THREE.WebGLRenderer;
  private cScene = new THREE.Scene();
  private cCam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private cGroup = new THREE.Group();
  private cDist = 6;
  private wantYaw = 0;
  private wantPitch = 0;
  private curYaw = 0;
  private curPitch = 0;

  private raf = 0;
  private built = false;

  /** Open the Locker. `onChange` fires when the held weapon's skin may have
   *  changed (so the caller can rebuild a live viewmodel). */
  open(onChange?: () => void, onClose?: () => void, onAbilities?: (abilities: string[]) => void) {
    this.onChange = onChange;
    this.onClose = onClose;
    this.onAbilities = onAbilities;
    this.data = loadLocker();
    this.data.abilities = sanitizeAbilities(this.data.abilities);
    if (!this.built) this.build();
    this.syncControls();
    this.rebuildWeaponPreview();
    this.rebuildCharacterPreview();
    this.root.classList.remove("hidden");
    if (!this.raf) this.loop();
  }

  close() {
    this.root.classList.add("hidden");
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onClose?.();
  }

  /** True while the Locker overlay is on screen (its previews are rendering). */
  isOpen(): boolean {
    return !this.root.classList.contains("hidden");
  }

  private build() {
    this.built = true;
    const weaponTabs = SKINNABLE_WEAPONS
      .map((w) => `<button class="lk-wtab" data-w="${w.id}">${w.label}</button>`).join("");
    const presets = WEAPON_SKIN_LIST
      .map((p) => `<button class="lk-preset" data-p="${p.id}">${p.label}</button>`).join("");
    const pickers = SKIN_PARTS
      .map((p, i) => `<label class="lk-picker"><span>${p.label}</span>` +
        `<input type="color" data-i="${i}" /></label>`).join("");
    const accessories = ACCESSORY_LIST
      .map((a) => `<button class="lk-acc" data-a="${a.id}">${a.label}</button>`).join("");
    const abilities2 = ABILITY_LIST
      .map((a) => `<button class="lk-abil" data-ab="${a.id}">${a.name}</button>`).join("");

    this.root.innerHTML = `
      <div class="lk-card">
        <div class="lk-head"><span>LOCKER</span><button id="lk-close">✕</button></div>
        <div class="lk-body">
          <div class="lk-col">
            <div class="lk-label">WEAPON</div>
            <div class="lk-wtabs">${weaponTabs}</div>
            <canvas id="lk-wpreview" width="300" height="190"></canvas>
            <div class="lk-label">PRESETS</div>
            <div class="lk-presets">${presets}</div>
            <div class="lk-label">MATERIALS</div>
            <div class="lk-pickers">${pickers}</div>
            <button id="lk-reset" class="lk-reset">RESET THIS GUN</button>
          </div>
          <div class="lk-col">
            <div class="lk-label">CHARACTER</div>
            <canvas id="lk-cpreview" width="300" height="340"></canvas>
            <div class="lk-label">SKIN</div>
            <div id="lk-skins" class="lk-skins"></div>
            <div class="lk-label">ACCESSORY</div>
            <div class="lk-accs">${accessories}</div>
            <div class="lk-label">ABILITIES</div>
            <div class="lk-slots">
              <button class="lk-slot" data-slot="0"><b>F</b> <span id="lk-slot0">—</span></button>
              <button class="lk-slot" data-slot="1"><b>C</b> <span id="lk-slot1">—</span></button>
            </div>
            <div id="lk-abilities" class="lk-abilities">${abilities2}</div>
            <div id="lk-abil-desc" class="lk-abil-desc"></div>
          </div>
        </div>
      </div>`;

    // Renderers.
    const wCanvas = this.root.querySelector("#lk-wpreview") as HTMLCanvasElement;
    this.wRenderer = new THREE.WebGLRenderer({ canvas: wCanvas, antialias: true, alpha: true });
    this.wRenderer.setSize(wCanvas.width, wCanvas.height, false);
    // Pixel ratio 1 (not devicePixelRatio): these previews are tiny, and at 2×
    // with MSAA they cost ~10× the whole low-res game and tank FPS while open.
    this.wRenderer.setPixelRatio(1);
    this.wScene.add(new THREE.HemisphereLight(0x88aaff, 0x101018, 1.3));
    const wd = new THREE.DirectionalLight(0xffffff, 1.0); wd.position.set(6, 12, 8); this.wScene.add(wd);
    this.wScene.add(this.wGroup);
    this.wCam.aspect = wCanvas.width / wCanvas.height;

    const cCanvas = this.root.querySelector("#lk-cpreview") as HTMLCanvasElement;
    this.cRenderer = new THREE.WebGLRenderer({ canvas: cCanvas, antialias: true, alpha: true });
    this.cRenderer.setSize(cCanvas.width, cCanvas.height, false);
    this.cRenderer.setPixelRatio(1); // see weapon preview note above
    this.cScene.add(new THREE.HemisphereLight(0x88aaff, 0x101018, 1.3));
    const cd = new THREE.DirectionalLight(0xffffff, 1.0); cd.position.set(4, 10, 8); this.cScene.add(cd);
    this.cScene.add(this.cGroup);
    this.cCam.aspect = cCanvas.width / cCanvas.height;

    // The character looks toward the pointer anywhere over the card.
    this.root.addEventListener("pointermove", (e) => {
      const r = cCanvas.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      this.wantYaw = Math.max(-1, Math.min(1, (e.clientX - cx) / (innerWidth / 2))) * 0.8;
      this.wantPitch = Math.max(-1, Math.min(1, (e.clientY - cy) / (innerHeight / 2))) * 0.4;
    });

    // Wiring.
    this.root.querySelector("#lk-close")!.addEventListener("click", () => this.close());
    for (const tab of this.root.querySelectorAll<HTMLElement>(".lk-wtab")) {
      tab.addEventListener("click", () => { this.weaponId = tab.dataset.w!; this.syncControls(); this.rebuildWeaponPreview(); });
    }
    for (const btn of this.root.querySelectorAll<HTMLElement>(".lk-preset")) {
      btn.addEventListener("click", () => {
        this.data.skins[this.weaponId] = skinToArr(WEAPON_SKINS[btn.dataset.p!] ?? WEAPON_SKINS.default);
        this.commit();
      });
    }
    for (const inp of this.root.querySelectorAll<HTMLInputElement>('.lk-picker input[type="color"]')) {
      inp.addEventListener("input", () => {
        const arr = this.currentPalette();
        arr[Number(inp.dataset.i)] = parseHex(inp.value);
        this.data.skins[this.weaponId] = arr;
        this.commit();
      });
    }
    this.root.querySelector("#lk-reset")!.addEventListener("click", () => {
      delete this.data.skins[this.weaponId];
      this.commit();
    });
    for (const btn of this.root.querySelectorAll<HTMLElement>(".lk-acc")) {
      btn.addEventListener("click", () => {
        this.data.accessory = btn.dataset.a!;
        saveLocker(this.data);
        this.markActiveAccessory();
        this.rebuildCharacterPreview();
      });
    }

    // Ability slots: click a slot to choose which one the grid edits.
    for (const slot of this.root.querySelectorAll<HTMLElement>(".lk-slot")) {
      slot.addEventListener("click", () => { this.abilSlot = Number(slot.dataset.slot) as 0 | 1; this.syncAbilities(); });
    }
    // Ability grid: click assigns to the active slot; hover shows the blurb.
    const descEl = this.root.querySelector("#lk-abil-desc") as HTMLElement;
    for (const btn of this.root.querySelectorAll<HTMLElement>(".lk-abil")) {
      const id = btn.dataset.ab!;
      btn.addEventListener("mouseenter", () => { descEl.textContent = ABILITIES[id as keyof typeof ABILITIES]?.desc ?? ""; });
      btn.addEventListener("click", () => {
        const other = this.abilSlot === 0 ? 1 : 0;
        // Avoid picking the same ability twice: swap if it's already in the other slot.
        if (this.data.abilities[other] === id) this.data.abilities[other] = this.data.abilities[this.abilSlot];
        this.data.abilities[this.abilSlot] = id;
        saveLocker(this.data);
        this.syncAbilities();
        this.onAbilities?.(this.data.abilities);
      });
    }
    this.root.querySelector("#lk-abilities")!.addEventListener("mouseleave", () => { descEl.textContent = ""; });

    // Skin hue swatches (drive the avatar tint, persisted to drunkr.skin).
    const skinsEl = this.root.querySelector("#lk-skins")!;
    for (const hue of SKIN_HUES) {
      const sw = document.createElement("button");
      sw.className = "skin";
      sw.style.background = `hsl(${hue * 360}, 85%, 55%)`;
      sw.dataset.hue = String(hue);
      sw.addEventListener("click", () => {
        localStorage.setItem("drunkr.skin", String(hue));
        this.markActiveSkin();
        this.rebuildCharacterPreview();
      });
      skinsEl.appendChild(sw);
    }
  }

  private markActiveSkin() {
    const cur = Number(localStorage.getItem("drunkr.skin") ?? 0.58);
    for (const sw of this.root.querySelectorAll<HTMLElement>("#lk-skins .skin")) {
      sw.classList.toggle("active", Math.abs(Number(sw.dataset.hue) - cur) < 0.001);
    }
  }

  /** Current edited weapon's palette as a mutable 6-array (default if unset). */
  private currentPalette(): number[] {
    return (this.data.skins[this.weaponId] ?? skinToArr(WEAPON_SKINS.default)).slice();
  }

  private currentSkin(): WeaponSkin {
    return arrToSkin(this.data.skins[this.weaponId]) ?? WEAPON_SKINS.default;
  }

  /** Persist + refresh previews and any live viewmodel after an edit. */
  private commit() {
    saveLocker(this.data);
    this.syncControls();
    this.rebuildWeaponPreview();
    this.onChange?.();
  }

  /** Reflect the current selection into the controls (tabs, pickers, accessory). */
  private syncControls() {
    for (const tab of this.root.querySelectorAll<HTMLElement>(".lk-wtab")) {
      tab.classList.toggle("active", tab.dataset.w === this.weaponId);
    }
    const sk = this.currentSkin();
    const arr = skinToArr(sk);
    for (const inp of this.root.querySelectorAll<HTMLInputElement>('.lk-picker input[type="color"]')) {
      inp.value = hex(arr[Number(inp.dataset.i)]);
    }
    this.markActiveAccessory();
    this.markActiveSkin();
    this.syncAbilities();
  }

  /** Reflect the chosen [F, C] abilities into the slot labels + grid highlight. */
  private syncAbilities() {
    const nameOf = (id: string) => ABILITIES[id as keyof typeof ABILITIES]?.name ?? "—";
    const s0 = this.root.querySelector("#lk-slot0"); if (s0) s0.textContent = nameOf(this.data.abilities[0]);
    const s1 = this.root.querySelector("#lk-slot1"); if (s1) s1.textContent = nameOf(this.data.abilities[1]);
    for (const slot of this.root.querySelectorAll<HTMLElement>(".lk-slot")) {
      slot.classList.toggle("active", Number(slot.dataset.slot) === this.abilSlot);
    }
    for (const btn of this.root.querySelectorAll<HTMLElement>(".lk-abil")) {
      const id = btn.dataset.ab!;
      btn.classList.toggle("f", this.data.abilities[0] === id);
      btn.classList.toggle("c", this.data.abilities[1] === id);
    }
  }

  private markActiveAccessory() {
    for (const btn of this.root.querySelectorAll<HTMLElement>(".lk-acc")) {
      btn.classList.toggle("active", btn.dataset.a === this.data.accessory);
    }
  }

  private rebuildWeaponPreview() {
    this.clearGroup(this.wGroup);
    const { group } = buildWeaponMesh(this.weaponId, this.currentSkin());
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    group.position.sub(c);
    this.wGroup.add(group);
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    this.wDist = radius / Math.tan((22.5 * Math.PI) / 180) * 1.15 + 0.5;
  }

  private rebuildCharacterPreview() {
    this.clearGroup(this.cGroup);
    const color = new THREE.Color().setHSL(playerHue(), 0.85, 0.55);
    const man = buildMannequin(color);
    const acc = ACCESSORIES[this.data.accessory]?.build(color);
    if (acc) man.add(acc);
    this.cGroup.add(man);
    const box = new THREE.Box3().setFromObject(man);
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() / 2 || 2;
    // A touch further back so the whole character sits comfortably in frame.
    this.cDist = radius / Math.tan((20 * Math.PI) / 180) * 1.3;
    // Pivot around the body centre so the mouse-follow rotation looks natural.
    this.cGroup.position.set(0, -MOVE.height * 0.5, 0);
  }

  private loop = () => {
    // Weapon: slow auto-rotate.
    this.wGroup.rotation.y += 0.012;
    this.wCam.position.set(0, this.wDist * 0.35, this.wDist);
    this.wCam.lookAt(0, 0, 0);
    this.wCam.updateProjectionMatrix();
    this.wRenderer.render(this.wScene, this.wCam);

    // Character: ease toward the pointer-driven target.
    this.curYaw += (this.wantYaw - this.curYaw) * 0.12;
    this.curPitch += (this.wantPitch - this.curPitch) * 0.12;
    this.cGroup.rotation.y = this.curYaw;
    this.cGroup.rotation.x = this.curPitch;
    this.cCam.position.set(0, 0, this.cDist);
    this.cCam.lookAt(0, 0, 0);
    this.cCam.updateProjectionMatrix();
    this.cRenderer.render(this.cScene, this.cCam);

    this.raf = requestAnimationFrame(this.loop);
  };

  private clearGroup(g: THREE.Group) {
    g.position.set(0, 0, 0);
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
      });
    }
  }
}
