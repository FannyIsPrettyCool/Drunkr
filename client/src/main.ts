import { Network } from "./net/Network.js";
import { Game } from "./core/Game.js";
import { Music } from "./audio/Music.js";
import { settings } from "./core/Settings.js";
import { SettingsPanel } from "./ui/SettingsPanel.js";
import { Locker } from "./ui/Locker.js";
import { loadLocker } from "./render/cosmetics.js";
import type { RoomInfo } from "@drunkr/shared";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const menu = document.getElementById("menu")!;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const status = document.getElementById("status")!;
const roomList = document.getElementById("room-list")!;

const quickBtn = document.getElementById("quickplay") as HTMLButtonElement;
const createBtn = document.getElementById("create-btn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;

const cfgMode = document.getElementById("cfg-mode") as HTMLSelectElement;
const cfgMapRow = document.getElementById("cfg-map-row")!;
const cfgCustomRow = document.getElementById("cfg-custom-row")!;
const cfgBotsRow = document.getElementById("cfg-bots-row")!;
const cfgBotCountRow = document.getElementById("cfg-botcount-row")!;
const cfgMap = document.getElementById("cfg-map") as HTMLSelectElement;
const cfgBots = document.getElementById("cfg-bots") as HTMLInputElement;
const cfgBotCount = document.getElementById("cfg-botcount") as HTMLInputElement;
const cfgBotCountVal = document.getElementById("cfg-botcount-val")!;
const cfgName = document.getElementById("cfg-name") as HTMLInputElement;

nameInput.value = localStorage.getItem("drunkr.name") ?? "";

// Skin hue + cosmetics now live in the Locker (see Locker.ts).
const classSel = document.getElementById("cfg-class") as HTMLSelectElement;
classSel.value = localStorage.getItem("drunkr.class") ?? "wind";
classSel.addEventListener("change", () => localStorage.setItem("drunkr.class", classSel.value));

const locker = new Locker();
document.getElementById("open-locker")!.addEventListener("click", () => locker.open());

function prefs() {
  const l = loadLocker();
  const skin = Number(localStorage.getItem("drunkr.skin") ?? 0.58);
  return { skin, cls: classSel.value, lockerSkins: l.skins, accessory: l.accessory };
}

// --- Settings --------------------------------------------------------------
const music = new Music(settings.musicEnabled, settings.musicVolume);

// Shared settings UI (sensitivity / audio / graphics / key rebinding). The same
// component is mounted in the in-game pause menu (see Game.ts).
new SettingsPanel(document.getElementById("lobby-settings")!, {
  onMusicEnabled: (on) => music.setEnabled(on),
  onMusicVol: (v) => music.setVolume(v),
});

const net = new Network();
let game: Game | null = null;
let connecting = false;
let refreshTimer: number | undefined;

function callsign(): string {
  const n = nameInput.value.trim() || "runner";
  localStorage.setItem("drunkr.name", n);
  return n;
}

// --- Tabs ------------------------------------------------------------------
for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) =>
      p.classList.toggle("hidden", p.id !== `tab-${name}`));
  });
}

cfgBotCount.addEventListener("input", () => (cfgBotCountVal.textContent = cfgBotCount.value));
cfgBots.addEventListener("change", () => (cfgBotCount.disabled = !cfgBots.checked));

function applyModeUI() {
  const isBomb = cfgMode.value === "bomb";
  cfgMapRow.classList.toggle("hidden", isBomb);
  // The custom-map file picker only shows when the map dropdown is set to it.
  const wantCustom = !isBomb && cfgMap.value === "__custom";
  cfgCustomRow.classList.toggle("hidden", !wantCustom);
  // Bots are available in bomb mode too.
}
cfgMode.addEventListener("change", applyModeUI);
cfgMap.addEventListener("change", applyModeUI);
applyModeUI();

// --- Room list -------------------------------------------------------------
function renderRooms(rooms: RoomInfo[]) {
  if (game) return;
  if (rooms.length === 0) {
    roomList.innerHTML = `<div class="empty">no servers — create one!</div>`;
    return;
  }
  roomList.innerHTML = "";
  for (const r of rooms) {
    const full = r.players >= r.maxPlayers;
    const row = document.createElement("div");
    row.className = "room-row";
    row.innerHTML =
      `<div class="room-meta">` +
      `<span class="room-name">${esc(r.name)}</span>` +
      `<span class="room-sub">${esc(r.mapName)} · ${r.bots} bots · ${r.difficulty}</span>` +
      `</div>` +
      `<span class="room-pop">${r.players}/${r.maxPlayers}</span>` +
      `<button class="join-btn"${full ? " disabled" : ""}>${full ? "FULL" : "JOIN"}</button>`;
    row.querySelector(".join-btn")!.addEventListener("click", () => {
      if (!full) joinRoom(r.id);
    });
    roomList.appendChild(row);
  }
}

function requestRooms() {
  if (net.connected) net.send({ t: "rooms" });
}

// --- Actions ---------------------------------------------------------------
function joinRoom(roomId?: string) {
  if (!net.connected || game) return;
  net.send({ t: "join", name: callsign(), roomId, ...prefs() });
  status.textContent = "dropping in…";
}

// Custom map (editor export) for the Create tab.
const cfgCustomFile = document.getElementById("cfg-custom-file") as HTMLInputElement;
const cfgCustomName = document.getElementById("cfg-custom-name")!;
let customMap: unknown = null;
cfgCustomFile.addEventListener("change", async () => {
  const f = cfgCustomFile.files?.[0];
  if (!f) { customMap = null; cfgCustomName.textContent = ""; return; }
  try {
    const m = JSON.parse(await f.text());
    if (!m.boxes || !m.spawns) throw new Error("bad");
    customMap = m;
    cfgCustomName.textContent = `loaded: ${m.name ?? "custom"} (${m.boxes.length} boxes)`;
  } catch {
    customMap = null;
    cfgCustomName.textContent = "invalid map file";
  }
});

function createRoom() {
  if (!net.connected || game) return;
  const isBomb = cfgMode.value === "bomb";
  const wantCustom = !isBomb && cfgMap.value === "__custom";
  if (wantCustom && !customMap) { status.textContent = "load a custom map file first"; return; }
  net.send({
    t: "create",
    name: callsign(),
    ...prefs(),
    config: {
      name: cfgName.value.trim(),
      // Custom uses an inline map; otherwise fall back to a built-in id.
      mapId: isBomb ? "dust2" : wantCustom ? "custom" : cfgMap.value,
      bots: cfgBots.checked,
      botCount: Number(cfgBotCount.value),
      mode: isBomb ? "bomb" : "ffa",
      ...(wantCustom ? { customMap: customMap as never } : {}),
    },
  });
  status.textContent = "creating server…";
}

quickBtn.addEventListener("click", () => joinRoom());
createBtn.addEventListener("click", createRoom);
refreshBtn.addEventListener("click", requestRooms);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && net.connected) joinRoom();
});

// --- Networking ------------------------------------------------------------
net.on((msg) => {
  if (msg.t === "roomlist") renderRooms(msg.rooms);
  if (msg.t === "welcome" && !game) {
    game = new Game(canvas, net, msg, music);
    menu.classList.add("hidden");
    window.clearInterval(refreshTimer);
    game.start();
  }
});

net.onClose = () => {
  if (!game) {
    status.textContent = "disconnected — retrying…";
    setButtons(true);
    setTimeout(tryConnect, 1500);
  } else {
    status.textContent = "connection lost";
  }
};

function setButtons(disabled: boolean) {
  quickBtn.disabled = disabled;
  createBtn.disabled = disabled;
}

async function tryConnect() {
  if (connecting || net.connected) return;
  connecting = true;
  setButtons(true);
  try {
    await net.connect();
    status.textContent = "connected";
    setButtons(false);
    requestRooms();
    window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
      if (!game) requestRooms();
    }, 2000);
  } catch {
    status.textContent = "server offline — retrying…";
    setTimeout(tryConnect, 1500);
  } finally {
    connecting = false;
  }
}

// Re-lock the pointer on click after the browser releases it (Esc).
canvas.addEventListener("click", () => {
  if (game && document.pointerLockElement !== canvas) canvas.requestPointerLock();
});

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

setButtons(true);
tryConnect();
