import * as THREE from "three";

interface DmgItem {
  el: HTMLElement;
  /** World-space anchor the number floats up from. */
  pos: THREE.Vector3;
  born: number;
  life: number;
}

/**
 * Floating combat damage numbers. Each is a DOM element anchored to a world
 * point (the impact spot); every frame we project that point to screen space,
 * float it upward and fade it out. Crisp text over the low-res 3D buffer.
 */
export class DamageNumbers {
  private root: HTMLElement;
  private items: DmgItem[] = [];
  private tmp = new THREE.Vector3();

  constructor(container?: HTMLElement) {
    this.root = container ?? document.getElementById("damage-numbers")!;
  }

  /** Pop a number at a world position. Headshots are gold + emphasised. */
  spawn(x: number, y: number, z: number, amount: number, head: boolean) {
    if (amount <= 0) return;
    const el = document.createElement("div");
    el.className = head ? "dmg head" : "dmg";
    el.textContent = head ? `${amount}` : String(amount);
    // A little horizontal jitter so rapid hits don't stack into one blob.
    (el as HTMLElement & { _jitter: number })._jitter = (Math.random() - 0.5) * 26;
    this.root.appendChild(el);
    this.items.push({ el, pos: new THREE.Vector3(x, y + 0.15, z), born: performance.now(), life: 850 });
  }

  /** Project + animate every live number. Call once per frame with the camera. */
  update(camera: THREE.Camera) {
    if (!this.items.length) return;
    const now = performance.now();
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const t = (now - it.born) / it.life;
      if (t >= 1) { it.el.remove(); this.items.splice(i, 1); continue; }
      this.tmp.copy(it.pos).project(camera);
      if (this.tmp.z > 1) { it.el.style.opacity = "0"; continue; } // behind camera
      const jitter = (it.el as HTMLElement & { _jitter: number })._jitter;
      const sx = (this.tmp.x * 0.5 + 0.5) * w + jitter;
      const sy = (-this.tmp.y * 0.5 + 0.5) * h - t * 38; // float up
      const scale = 1.35 - 0.35 * Math.min(1, t * 5);    // quick pop, then settle
      it.el.style.transform = `translate(-50%, -50%) translate(${sx}px, ${sy}px) scale(${scale})`;
      it.el.style.opacity = String(1 - t * t); // ease-out fade
    }
  }

  clear() {
    for (const it of this.items) it.el.remove();
    this.items = [];
  }
}
