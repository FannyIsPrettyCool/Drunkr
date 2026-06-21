import type { C_Admin, PlayerState } from "@drunkr/shared";

export interface AdminPanelOpts {
  /** Send an admin command to the server (it re-checks our privilege). */
  send: (msg: C_Admin) => void;
  /** Current player roster (for the targetable player list). */
  roster: () => PlayerState[];
  localId: number;
  /** Maps that can be switched to via the panel. */
  maps: { id: string; name: string }[];
  /** Toggle a purely client-side "fun" mod (noclip / fly / infinite ammo). */
  onClientToggle: (key: "noclip" | "fly" | "infammo", on: boolean) => void;
  /** Set the client-side movement-speed multiplier. */
  onSpeed: (mul: number) => void;
  /** User asked to close the panel (Game re-locks the pointer). */
  onClose: () => void;
}

/**
 * The admin control panel. Server-authoritative actions (god, slay, kick, map,
 * bots…) are sent as `C_Admin` messages; client-side "fun" toggles (noclip,
 * fly, infinite ammo, speed) only affect the local player and are applied via
 * callbacks. Only shown to players the server granted admin to.
 */
export class AdminPanel {
  private root = document.getElementById("admin-panel")!;
  private listEl!: HTMLElement;
  open = false;

  constructor(private opts: AdminPanelOpts) {
    this.build();
  }

  private cmd(cmd: string, extra: Partial<C_Admin> = {}) {
    this.opts.send({ t: "admin", cmd, ...extra });
  }

  private build() {
    const maps = this.opts.maps.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    this.root.innerHTML = `
      <div class="ap-card">
        <div class="ap-head"><span>⚙ ADMIN PANEL</span><button class="ap-close" title="close">✕</button></div>
        <div class="ap-cols">
          <div class="ap-col">
            <h4>SELF</h4>
            <div class="ap-btns">
              <button data-c="god">Godmode</button>
              <button data-c="heal">Heal</button>
              <button data-c="heal-over">Heal +100</button>
            </div>
            <label class="ap-check"><input type="checkbox" data-t="noclip"> Noclip (fly through walls)</label>
            <label class="ap-check"><input type="checkbox" data-t="fly"> Fly</label>
            <label class="ap-check"><input type="checkbox" data-t="infammo"> Infinite ammo</label>
            <label class="ap-range">Speed <span class="ap-spd">1.0</span>×
              <input type="range" class="ap-speed" min="1" max="6" step="0.5" value="1">
            </label>
            <h4>GIVE WEAPON</h4>
            <div class="ap-btns">
              <button data-give="ak">AK-44</button>
              <button data-give="sniper">LVR-50</button>
              <button data-give="shotgun">DB-12</button>
              <button data-give="katana">Katana</button>
            </div>
          </div>
          <div class="ap-col">
            <h4>LOBBY</h4>
            <label class="ap-range">Bots <span class="ap-botval">4</span>
              <input type="range" class="ap-bots" min="0" max="10" step="1" value="4">
            </label>
            <label class="ap-sel">Difficulty
              <select class="ap-diff">
                <option value="easy">Easy</option>
                <option value="normal" selected>Normal</option>
                <option value="hard">Hard</option>
              </select>
            </label>
            <label class="ap-sel">Map<select class="ap-map">${maps}</select></label>
            <div class="ap-btns">
              <button data-c="killbots">Kill Bots</button>
              <button data-c="slayall" class="danger">Slay All</button>
            </div>
            <h4>ANNOUNCE</h4>
            <div class="ap-announce">
              <input type="text" class="ap-msg" maxlength="120" placeholder="message to everyone">
              <button class="ap-send">SEND</button>
            </div>
          </div>
          <div class="ap-col ap-players">
            <h4>PLAYERS</h4>
            <div class="ap-list"></div>
          </div>
        </div>
        <div class="ap-hint">Press <b>\`</b> to toggle this panel · client toggles affect only you</div>
      </div>`;

    this.listEl = this.root.querySelector(".ap-list")!;

    this.root.querySelector(".ap-close")!.addEventListener("click", () => this.opts.onClose());

    // Self / lobby command buttons.
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-c]")) {
      btn.addEventListener("click", () => {
        const c = btn.dataset.c!;
        if (c === "heal-over") this.cmd("heal", { amount: 100 });
        else this.cmd(c);
      });
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-give]")) {
      btn.addEventListener("click", () => this.cmd("give", { value: btn.dataset.give }));
    }

    // Client-side toggles.
    for (const cb of this.root.querySelectorAll<HTMLInputElement>("input[data-t]")) {
      cb.addEventListener("change", () =>
        this.opts.onClientToggle(cb.dataset.t as "noclip" | "fly" | "infammo", cb.checked));
    }

    // Speed slider.
    const speed = this.root.querySelector<HTMLInputElement>(".ap-speed")!;
    const spdLabel = this.root.querySelector<HTMLElement>(".ap-spd")!;
    speed.addEventListener("input", () => {
      const v = Number(speed.value);
      spdLabel.textContent = v.toFixed(1);
      this.opts.onSpeed(v);
    });

    // Bots slider.
    const bots = this.root.querySelector<HTMLInputElement>(".ap-bots")!;
    const botLabel = this.root.querySelector<HTMLElement>(".ap-botval")!;
    bots.addEventListener("input", () => (botLabel.textContent = bots.value));
    bots.addEventListener("change", () => this.cmd("bots", { amount: Number(bots.value) }));

    this.root.querySelector<HTMLSelectElement>(".ap-diff")!.addEventListener("change", (e) =>
      this.cmd("difficulty", { value: (e.target as HTMLSelectElement).value }));
    this.root.querySelector<HTMLSelectElement>(".ap-map")!.addEventListener("change", (e) =>
      this.cmd("map", { value: (e.target as HTMLSelectElement).value }));

    const msg = this.root.querySelector<HTMLInputElement>(".ap-msg")!;
    const sendMsg = () => {
      const text = msg.value.trim();
      if (text) { this.cmd("announce", { value: text }); msg.value = ""; }
    };
    this.root.querySelector(".ap-send")!.addEventListener("click", sendMsg);
    msg.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });

    // Per-player action buttons (event-delegated).
    this.listEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
      if (!b) return;
      const target = Number(b.dataset.id);
      this.cmd(b.dataset.act!, { target });
    });
  }

  /** Rebuild the targetable player list from the live roster. */
  private refreshList() {
    const rows = this.opts.roster()
      .sort((a, b) => a.id - b.id)
      .map((p) => {
        const me = p.id === this.opts.localId;
        const tag = me ? "you" : `#${p.id}`;
        const acts = me
          ? ""
          : `<button data-act="slay" data-id="${p.id}">Slay</button>` +
            `<button data-act="kick" data-id="${p.id}">Kick</button>` +
            `<button data-act="tp" data-id="${p.id}">TP</button>` +
            `<button data-act="bring" data-id="${p.id}">Bring</button>` +
            `<button data-act="boom" data-id="${p.id}" class="danger">Boom</button>`;
        return `<div class="ap-prow"><span class="ap-pname">${p.admin ? "★ " : ""}${esc(p.name)} <em>${tag}</em></span>` +
          `<span class="ap-pacts">${acts}</span></div>`;
      })
      .join("");
    this.listEl.innerHTML = rows || `<div class="ap-empty">no players</div>`;
  }

  show() {
    this.refreshList();
    this.root.classList.remove("hidden");
    this.open = true;
  }

  hide() {
    this.root.classList.add("hidden");
    this.open = false;
  }
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}
