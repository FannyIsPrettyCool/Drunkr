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
  private deathBy = document.getElementById("death-by")!;
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
  private pingEl = document.getElementById("ping")!;
  private toastEl = document.getElementById("toast")!;
  private toastTimer = 0;
  private killConfirmEl = document.getElementById("killconfirm")!;
  private killConfirmTimer = 0;
  private multiEl = document.getElementById("multikill")!;
  private multiTextEl = document.getElementById("mk-text")!;
  private multiFillEl = document.getElementById("mk-fill")!;
  private multiTimer = 0;
  private protectEl = document.getElementById("protect")!;
  private speedometer = document.getElementById("speedometer")!;
  private speedVal = document.getElementById("speed-val")!;
  private intermission = document.getElementById("intermission")!;
  private intermissionTimer = 0;
  private chatLog = document.getElementById("chat-log")!;

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

  /** Latency readout next to the FPS counter (null hides it). */
  setPing(ms: number | null) {
    if (ms === null) {
      this.pingEl.classList.add("hidden");
    } else {
      this.pingEl.classList.remove("hidden");
      this.pingEl.textContent = `${ms} ms`;
      this.pingEl.classList.toggle("bad", ms > 120);
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
    if (!dead) this.deathBy.classList.add("hidden");
  }

  /** Who/what killed the local player, shown on the elimination overlay. */
  setDeathInfo(
    killerName: string | null, head: boolean,
    cause?: "void" | "hazard", noscope?: boolean, airborne?: boolean,
  ) {
    if (cause === "void" || (!killerName && !cause)) {
      this.deathBy.textContent = rand(VOID_MSGS);
    } else if (cause === "hazard") {
      this.deathBy.textContent = rand(HAZARD_MSGS);
    } else {
      const verb = head ? '<span class="db-head">✜ headshotted</span> by' : `${rand(KILL_VERBS)} by`;
      this.deathBy.innerHTML =
        `${verb} <span class="db-killer">${esc(killerName!)}</span>` +
        `${noscope ? " " + NOSCOPE_ICON : ""}${airborne ? " " + AIRBORNE_ICON : ""}` +
        `<span class="db-tags">${styleSuffix(noscope, airborne)}</span>`;
    }
    this.deathBy.classList.remove("hidden");
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

  addKill(
    killerName: string, victimName: string, head: boolean, assistNames: string[] = [], multi = 1,
    noscope = false, airborne = false, cause?: "void" | "hazard",
  ) {
    const row = document.createElement("div");
    row.className = "row";
    // Environmental death (no killer): just the victim + how they went out.
    if (cause) {
      row.innerHTML =
        `<span class="verb">${cause === "void" ? "↡" : "✸"}</span>` +
        `<span class="victim">${esc(victimName)} ${cause === "void" ? rand(VOID_MSGS) : rand(HAZARD_MSGS)}</span>`;
      this.killfeed.prepend(row);
      while (this.killfeed.children.length > 5) this.killfeed.lastChild!.remove();
      setTimeout(() => row.remove(), 5000);
      return;
    }
    const assist = assistNames.length
      ? `<span class="assist">+${assistNames.map(esc).join(", ")}</span>`
      : "";
    const badge = multi >= 2 ? `<span class="mk-badge">${multiKillName(multi)}</span>` : "";
    const icons = `${noscope ? NOSCOPE_ICON : ""}${airborne ? AIRBORNE_ICON : ""}`;
    row.innerHTML =
      `<span class="killer">${esc(killerName)}</span>` +
      `<span class="verb">${head ? '✜' : '»'}</span>` + icons +
      `<span class="victim">${esc(victimName)}</span>` + assist + badge;
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
          `<td>${p.admin ? "★ " : ""}${esc(p.name)}</td>` +
          `<td class="num">${p.kills}</td>` +
          `<td class="num">${p.deaths}</td>` +
          `<td class="num">${p.assists ?? 0}</td>` +
          `<td class="num">${p.ping ?? 0}</td></tr>`,
      )
      .join("");
    this.scoreboard.innerHTML =
      `<h2>SCORES</h2><table><tr><th>RUNNER</th><th class="num">K</th><th class="num">D</th><th class="num">A</th><th class="num">MS</th></tr>${rows}</table>`;
  }

  /** Live speedometer (units/s), colour-tiered by how fast you're moving. */
  setSpeed(speed: number) {
    this.speedVal.textContent = String(Math.round(speed));
    this.speedometer.classList.toggle("fast", speed > 12);
    this.speedometer.classList.toggle("blaze", speed > 20);
  }

  /** Spawn-protection indicator (active just after respawning). */
  setProtected(on: boolean) {
    this.protectEl.classList.toggle("hidden", !on);
  }

  /** Personal kill/assist confirmation, popped at bottom-center of the screen. */
  killConfirm(text: string, kind: "kill" | "assist") {
    this.killConfirmEl.textContent = text; // textContent → safe from name injection
    this.killConfirmEl.className = kind;    // "kill" | "assist" (clears "hidden")
    void this.killConfirmEl.offsetWidth;    // restart the pop animation
    this.killConfirmEl.classList.add("show");
    clearTimeout(this.killConfirmTimer);
    this.killConfirmTimer = window.setTimeout(
      () => this.killConfirmEl.classList.add("hidden"),
      kind === "kill" ? 1700 : 1300,
    );
  }

  /**
   * Big centred multikill announcement for the local player (double/triple/…),
   * with a combo bar that depletes over the combo window and resets/extends on
   * each new kill. `windowMs` should match the server's combo window.
   */
  multiKill(count: number, windowMs = 4500) {
    this.multiTextEl.textContent = multiKillName(count);
    this.multiEl.className = `mk-${Math.min(count, 6)}`; // clears "hidden", tiers colour
    void this.multiEl.offsetWidth; // restart pop animation
    this.multiEl.classList.add("show");

    // Depleting bar: snap to full, then animate width to 0 over the window.
    this.multiFillEl.style.transition = "none";
    this.multiFillEl.style.width = "100%";
    void this.multiFillEl.offsetWidth;
    this.multiFillEl.style.transition = `width ${windowMs}ms linear`;
    this.multiFillEl.style.width = "0%";

    clearTimeout(this.multiTimer);
    this.multiTimer = window.setTimeout(() => this.multiEl.classList.add("hidden"), windowMs);
  }

  /** Append a chat line to the log; auto-removed after 8 s via CSS animation. */
  addChatMessage(name: string, text: string) {
    const line = document.createElement("div");
    line.className = "chat-line";
    line.innerHTML = `<span class="chat-name">${esc(name)}</span>: ${esc(text)}`;
    this.chatLog.appendChild(line);
    // Keep at most 12 visible lines.
    while (this.chatLog.children.length > 12) this.chatLog.firstChild!.remove();
    setTimeout(() => line.remove(), 8000);
  }

  /** A transient notification: announcements (kind="admin") or action feedback. */
  toast(text: string, kind: "info" | "admin" = "info") {
    this.toastEl.textContent = text;
    this.toastEl.className = kind === "admin" ? "admin" : "";
    this.toastEl.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add("hidden"), kind === "admin" ? 4500 : 2800);
  }
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

// --- Fun death flavor (dumb gen-z humor) -----------------------------------
const KILL_VERBS = [
  "slimed", "yeeted", "deleted", "disintegrated", "clapped", "vaporized",
  "unalived", "fragged", "bonked", "cooked", "ratio'd", "obliterated",
  "atomized", "folded", "ended", "no-capped on", "speedran past", "GG'd",
  "sent to the shadow realm", "touched grass on", "left on read",
];
const VOID_MSGS = [
  "fell into the void", "yeeted themselves off the map", "rage quit gravity",
  "touched the abyss", "found out the floor was lava (it was void)",
  "took the big L off the edge", "speedran the respawn screen",
];
const HAZARD_MSGS = [
  "got cooked by the hazard", "stood in the bad place", "melted (skill issue)",
  "speedran death by hazard", "found out that REALLY hurts", "got that crispy aura",
];
/** Glyph icons that stack onto a kill (no-scope reticle, airborne up-triangle). */
const NOSCOPE_ICON = `<span class="kf-icon" title="No-scope">⌖</span>`;
const AIRBORNE_ICON = `<span class="kf-icon" title="Airborne">⏶</span>`;
const rand = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
/** A " · no-scope · mid-air" style suffix for personal kill confirms / death. */
function styleSuffix(noscope?: boolean, airborne?: boolean): string {
  const tags: string[] = [];
  if (noscope) tags.push("no-scope");
  if (airborne) tags.push("mid-air");
  return tags.length ? ` (${tags.join(" + ")})` : "";
}

/** A fun "verb NAME" phrase for a kill the local player got, with flair. */
export function killBrag(victim: string, noscope?: boolean, airborne?: boolean): string {
  return `${rand(KILL_VERBS)} ${victim}${styleSuffix(noscope, airborne)}`;
}

/** Announcement label for a multikill count. */
function multiKillName(count: number): string {
  switch (count) {
    case 2: return "DOUBLE KILL";
    case 3: return "TRIPLE KILL";
    case 4: return "QUAD KILL";
    case 5: return "MEGA KILL";
    case 6: return "ULTRA KILL";
    default: return count >= 7 ? "MONSTER KILL" : "KILL";
  }
}
