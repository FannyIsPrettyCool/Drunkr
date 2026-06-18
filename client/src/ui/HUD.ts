import type { PlayerState } from "@drunkr/shared";

/** Thin wrapper over the HUD DOM elements. */
export class HUD {
  private root = document.getElementById("hud")!;
  private healthVal = document.getElementById("health-val")!;
  private overhealVal = document.getElementById("overheal-val")!;
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
  private abilityF = document.getElementById("ability-f")!;
  private abilityC = document.getElementById("ability-c")!;
  private blindEl = document.getElementById("blind")!;
  private blindTimer = 0;
  private bannerEl = document.getElementById("banner")!;
  private bannerTimer = 0;
  private timerEl = document.getElementById("timer")!;
  private fpsEl = document.getElementById("fps")!;
  private intermission = document.getElementById("intermission")!;
  private intermissionTimer = 0;

  show() {
    this.root.classList.remove("hidden");
  }

  setHealth(hp: number) {
    const total = Math.max(0, Math.round(hp));
    // Base health caps at 100 (pink); anything above is overheal, shown as a
    // blue-neon "+N" floating above the number (Fortify / vampire abilities).
    this.healthVal.textContent = String(Math.min(100, total));
    const over = Math.max(0, total - 100);
    if (over > 0) {
      this.overhealVal.textContent = `+${over}`;
      this.overhealVal.classList.remove("hidden");
    } else {
      this.overhealVal.classList.add("hidden");
    }
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

  setAbility(slot: "F" | "C", name: string, ready: boolean, secsLeft: number) {
    const el = slot === "F" ? this.abilityF : this.abilityC;
    el.querySelector(".ab-name")!.textContent = name;
    el.querySelector(".ab-cd")!.textContent = ready ? "" : String(secsLeft);
    el.classList.toggle("ready", ready);
  }

  /** White flash-bang blind: holds fully white, then fades over the duration. */
  blind(ms: number) {
    clearTimeout(this.blindTimer);
    this.blindEl.style.transition = "none";
    this.blindEl.style.opacity = "1";
    // Stay fully blind for ~45% of the time, then fade over the rest.
    const hold = ms * 0.45;
    this.blindTimer = window.setTimeout(() => {
      this.blindEl.style.transition = `opacity ${ms - hold}ms ease-out`;
      this.blindEl.style.opacity = "0";
    }, hold);
  }

  setTimer(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    this.timerEl.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
    this.timerEl.classList.toggle("low", s <= 30);
  }

  setFps(fps: number | null) {
    if (fps === null) {
      this.fpsEl.classList.add("hidden");
    } else {
      this.fpsEl.classList.remove("hidden");
      this.fpsEl.textContent = `${fps} FPS`;
    }
  }

  banner(text: string) {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove("hidden");
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.add("hidden"), 4000);
  }

  /** Full-screen round-over / waiting screen, auto-hides after `ms`. */
  showIntermission(winner: string, ms = 5000) {
    this.intermission.querySelector(".winner")!.textContent = `${winner} WINS`;
    this.intermission.classList.remove("hidden");
    clearTimeout(this.intermissionTimer);
    this.intermissionTimer = window.setTimeout(
      () => this.intermission.classList.add("hidden"), ms);
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
