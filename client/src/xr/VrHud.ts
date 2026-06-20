import * as THREE from "three";

/**
 * A minimal head-locked HUD for VR. The DOM HUD isn't visible inside the
 * headset, so we mirror its key readouts (health + overheal, ammo, the two
 * ability cooldowns) onto a canvas texture on a small panel in front of the
 * camera. It reads straight from the existing HUD DOM elements so it always
 * matches the authoritative HUD logic.
 */
export class VrHud {
  readonly group = new THREE.Group();
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;

  // Cached HUD elements.
  private healthEl = document.getElementById("health-val");
  private overhealEl = document.getElementById("overheal-val");
  private ammoCurEl = document.getElementById("ammo-cur");
  private ammoMaxEl = document.getElementById("ammo-max");
  private abFName = document.querySelector("#ability-f .ab-name");
  private abFCd = document.querySelector("#ability-f .ab-cd");
  private abCName = document.querySelector("#ability-c .ab-name");
  private abCCd = document.querySelector("#ability-c .ab-cd");

  constructor(camera: THREE.PerspectiveCamera) {
    this.canvas.width = 512;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.25),
      new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, depthTest: false, depthWrite: false,
      }),
    );
    panel.renderOrder = 1000;
    this.group.add(panel);
    // Down and forward so it sits at the bottom of the view, angled up slightly.
    this.group.position.set(0, -0.32, -1);
    this.group.rotation.x = 0.35;
    // Hidden on desktop; Game shows it only while a VR session is active.
    this.group.visible = false;
    camera.add(this.group);
  }

  /** Redraw the panel from the current DOM HUD state. Call each VR frame. */
  update() {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(5,6,12,0.55)";
    c.fillRect(0, 0, W, H);
    c.textBaseline = "middle";

    const hp = this.healthEl?.textContent ?? "100";
    const over = this.overhealEl && !this.overhealEl.classList.contains("hidden")
      ? this.overhealEl.textContent ?? "" : "";

    // Health (pink) + overheal (cyan, raised to the right of the number).
    c.font = "bold 64px 'Courier New', monospace";
    c.fillStyle = "#ff2d9b";
    c.textAlign = "left";
    c.fillText(hp, 28, 86);
    const hpWidth = c.measureText(hp).width;
    if (over) {
      c.font = "bold 36px 'Courier New', monospace";
      c.fillStyle = "#18e0ff";
      c.fillText(over, 28 + hpWidth + 12, 52);
    }
    c.font = "20px 'Courier New', monospace";
    c.fillStyle = "rgba(214,230,255,0.6)";
    c.fillText("HP", 28, 130);

    // Ammo (right side).
    const cur = this.ammoCurEl?.textContent ?? "";
    const max = this.ammoMaxEl?.textContent ?? "";
    c.textAlign = "right";
    c.font = "bold 56px 'Courier New', monospace";
    c.fillStyle = "#d6e6ff";
    c.fillText(max ? `${cur}/${max}` : cur, W - 28, 86);

    // Abilities (bottom row).
    c.font = "22px 'Courier New', monospace";
    this.drawAbility(c, "F", this.abFName?.textContent ?? "", this.abFCd?.textContent ?? "", 28, 200, "left");
    this.drawAbility(c, "C", this.abCName?.textContent ?? "", this.abCCd?.textContent ?? "", W - 28, 200, "right");

    this.texture.needsUpdate = true;
  }

  private drawAbility(
    c: CanvasRenderingContext2D, key: string, name: string, cd: string,
    x: number, y: number, align: CanvasTextAlign,
  ) {
    c.textAlign = align;
    const ready = cd === "";
    c.fillStyle = ready ? "#18e0ff" : "rgba(214,230,255,0.5)";
    const label = ready ? `${key} ${name}` : `${key} ${name} ${cd}`;
    c.fillText(label, x, y);
  }
}
