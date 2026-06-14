import type { PlayerState } from "@drunkr/shared";

/** Thin wrapper over the HUD DOM elements. */
export class HUD {
  private root = document.getElementById("hud")!;
  private healthVal = document.getElementById("health-val")!;
  private ammoCur = document.getElementById("ammo-cur")!;
  private ammoMax = document.getElementById("ammo-max")!;
  private killfeed = document.getElementById("killfeed")!;
  private hitmarker = document.getElementById("hitmarker")!;
  private damageFlash = document.getElementById("damage-flash")!;
  private respawn = document.getElementById("respawn")!;
  private scoreboard = document.getElementById("scoreboard")!;
  private reload = document.getElementById("reload")!;
  private reloadFill = document.getElementById("reload-fill")!;
  private weaponName = document.getElementById("weapon-name")!;
  private scope = document.getElementById("scope")!;
  private crosshair = document.getElementById("crosshair")!;
  private dash = document.getElementById("dash")!;
  private bannerEl = document.getElementById("banner")!;
  private bannerTimer = 0;

  show() {
    this.root.classList.remove("hidden");
  }

  setHealth(hp: number) {
    this.healthVal.textContent = String(Math.max(0, Math.round(hp)));
  }

  setAmmo(cur: number, max: number) {
    if (max <= 0) {
      // Melee / no-magazine weapon.
      this.ammoCur.textContent = "∞";
      this.ammoMax.textContent = "";
    } else {
      this.ammoCur.textContent = String(cur);
      this.ammoMax.textContent = String(max);
    }
  }

  setDash(ready: boolean) {
    this.dash.classList.toggle("ready", ready);
  }

  banner(text: string) {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove("hidden");
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.add("hidden"), 4000);
  }

  hitmark(head: boolean) {
    this.hitmarker.style.background = head ? "#ffd33d" : "#fff";
    this.hitmarker.classList.remove("show");
    // Force reflow so the animation restarts.
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add("show");
  }

  flashDamage() {
    this.damageFlash.classList.add("show");
    setTimeout(() => this.damageFlash.classList.remove("show"), 30);
  }

  setDead(dead: boolean) {
    this.respawn.classList.toggle("hidden", !dead);
  }

  setReload(active: boolean, progress: number) {
    this.reload.classList.toggle("hidden", !active);
    if (active) this.reloadFill.style.width = `${Math.round(progress * 100)}%`;
  }

  setWeapon(name: string) {
    this.weaponName.textContent = name;
  }

  setScope(active: boolean) {
    this.scope.classList.toggle("hidden", !active);
    // Hide the hip crosshair while scoped (the scope has its own reticle).
    this.crosshair.style.opacity = active ? "0" : "1";
  }

  addKill(killerName: string, victimName: string, head: boolean) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<span class="killer">${esc(killerName)}</span>` +
      `<span class="verb">${head ? '✜' : '»'}</span>` +
      `<span class="victim">${esc(victimName)}</span>`;
    if (head) row.querySelector(".verb")!.classList.add("head");
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 5) {
      this.killfeed.lastChild!.remove();
    }
    setTimeout(() => row.remove(), 5000);
  }

  toggleScoreboard(show: boolean, players: PlayerState[], localId: number) {
    this.scoreboard.classList.toggle("hidden", !show);
    if (!show) return;
    const sorted = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const rows = sorted
      .map(
        (p) =>
          `<tr class="${p.id === localId ? "me" : ""}">` +
          `<td>${esc(p.name)}</td>` +
          `<td class="num">${p.kills}</td>` +
          `<td class="num">${p.deaths}</td></tr>`,
      )
      .join("");
    this.scoreboard.innerHTML =
      `<h2>SCORES</h2><table><tr><th>RUNNER</th><th class="num">K</th><th class="num">D</th></tr>${rows}</table>`;
  }
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}
