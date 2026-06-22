import type { C_Admin, PlayerState } from "@drunkr/shared";

export interface AdminPanelOpts {
  send: (msg: C_Admin) => void;
  roster: () => PlayerState[];
  localId: number;
  onClientToggle: (key: "noclip" | "fly" | "infammo", on: boolean) => void;
  onSpeed: (mul: number) => void;
  onClose: () => void;
}

export class AdminPanel {
  private root = document.getElementById("admin-panel")!;
  private listEl!: HTMLElement;
  private refreshTimer = 0;
  open = false;

  constructor(private opts: AdminPanelOpts) {
    this.build();
  }

  private cmd(cmd: string, extra: Partial<C_Admin> = {}) {
    this.opts.send({ t: "admin", cmd, ...extra });
  }

  private build() {
    this.root.innerHTML = `
      <div class="ap-card">
        <div class="ap-head">
          <span class="ap-title">ADMIN PANEL</span>
          <button class="ap-close" title="Close (Esc)">✕</button>
        </div>
        <div class="ap-cols">

          <div class="ap-col">
            <h4>SELF</h4>
            <div class="ap-btns">
              <button data-c="god">Godmode</button>
              <button data-c="heal">Full Heal</button>
              <button data-c="heal-over">Overheal +100</button>
            </div>
            <label class="ap-check"><input type="checkbox" data-t="noclip"> Noclip</label>
            <label class="ap-check"><input type="checkbox" data-t="fly"> Fly</label>
            <label class="ap-check"><input type="checkbox" data-t="infammo"> Infinite ammo</label>
            <label class="ap-range">Speed <span class="ap-spd">1.0</span>×
              <input type="range" class="ap-speed" min="1" max="6" step="0.5" value="1">
            </label>

            <h4>LOBBY</h4>
            <div class="ap-btns">
              <button data-c="addbot">+ Bot</button>
              <button data-c="killbots">Kill Bots</button>
              <button data-c="launchall">Launch All</button>
              <button data-c="slayall" class="danger">Slay All</button>
            </div>

            <h4>ANNOUNCE</h4>
            <div class="ap-announce">
              <input type="text" class="ap-msg" maxlength="120" placeholder="message to everyone…">
              <button class="ap-send">SEND</button>
            </div>
          </div>

          <div class="ap-col ap-players">
            <h4>PLAYERS <span class="ap-pcount"></span></h4>
            <div class="ap-list"></div>
          </div>

        </div>
        <div class="ap-hint">Press <b>\`</b> or <b>Esc</b> to toggle · client toggles only affect you</div>
      </div>`;

    this.listEl = this.root.querySelector(".ap-list")!;

    this.root.querySelector(".ap-close")!.addEventListener("click", () => this.opts.onClose());

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-c]")) {
      btn.addEventListener("click", () => {
        const c = btn.dataset.c!;
        if (c === "heal-over") this.cmd("heal", { amount: 100 });
        else this.cmd(c);
      });
    }

    for (const cb of this.root.querySelectorAll<HTMLInputElement>("input[data-t]")) {
      cb.addEventListener("change", () =>
        this.opts.onClientToggle(cb.dataset.t as "noclip" | "fly" | "infammo", cb.checked));
    }

    const speed = this.root.querySelector<HTMLInputElement>(".ap-speed")!;
    const spdLabel = this.root.querySelector<HTMLElement>(".ap-spd")!;
    speed.addEventListener("input", () => {
      spdLabel.textContent = Number(speed.value).toFixed(1);
      this.opts.onSpeed(Number(speed.value));
    });

    const msg = this.root.querySelector<HTMLInputElement>(".ap-msg")!;
    const sendMsg = () => {
      const text = msg.value.trim();
      if (text) { this.cmd("announce", { value: text }); msg.value = ""; }
    };
    this.root.querySelector(".ap-send")!.addEventListener("click", sendMsg);
    msg.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); sendMsg(); } });

    this.listEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
      if (!b) return;
      const target = Number(b.dataset.id);
      this.cmd(b.dataset.act!, { target });
    });
  }

  private refreshList() {
    const players = this.opts.roster().sort((a, b) => a.id - b.id);

    const countEl = this.root.querySelector<HTMLElement>(".ap-pcount");
    if (countEl) countEl.textContent = `(${players.length})`;

    const rows = players.map((p) => {
      const me = p.id === this.opts.localId;
      const isDead = !!p.dead;
      const label = me ? "you" : `#${p.id}`;
      const statusDot = isDead
        ? `<span class="ap-dot dead" title="Dead"></span>`
        : `<span class="ap-dot alive" title="Alive"></span>`;

      let acts = "";
      if (!me) {
        acts += `<button data-act="slay" data-id="${p.id}" ${isDead ? "disabled" : ""}>Slay</button>`;
        acts += `<button data-act="kick" data-id="${p.id}">Kick</button>`;
        acts += `<button data-act="tp" data-id="${p.id}">TP</button>`;
        acts += `<button data-act="bring" data-id="${p.id}" ${isDead ? "disabled" : ""}>Bring</button>`;
        acts += `<button data-act="launch" data-id="${p.id}" ${isDead ? "disabled" : ""}>Launch</button>`;
        acts += `<button data-act="freeze" data-id="${p.id}" ${isDead ? "disabled" : ""}>Freeze</button>`;
        if (isDead) acts += `<button data-act="revive" data-id="${p.id}">Revive</button>`;
        acts += `<button data-act="boom" data-id="${p.id}" class="danger" ${isDead ? "disabled" : ""}>Boom</button>`;
        if (!p.admin) acts += `<button data-act="grant" data-id="${p.id}" class="grant">★ Admin</button>`;
      }

      const adminMark = p.admin ? `<span class="ap-admin-mark">★</span>` : "";
      return `<div class="ap-prow ${isDead ? "dead" : ""}">
        <span class="ap-pname">${statusDot}${adminMark}${esc(p.name)} <em>${esc(label)}</em></span>
        <span class="ap-pacts">${acts}</span>
      </div>`;
    }).join("");

    this.listEl.innerHTML = rows || `<div class="ap-empty">no players</div>`;
  }

  show() {
    this.refreshList();
    this.root.classList.remove("hidden");
    this.open = true;
    this.refreshTimer = window.setInterval(() => this.refreshList(), 800);
  }

  hide() {
    this.root.classList.add("hidden");
    this.open = false;
    clearInterval(this.refreshTimer);
  }
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}
