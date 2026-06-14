import { Network } from "./net/Network.js";
import { Game } from "./core/Game.js";
import { settings, saveSettings, type Settings } from "./core/Settings.js";
import type { RoomInfo, BotDifficulty } from "@drunkr/shared";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const menu = document.getElementById("menu")!;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const status = document.getElementById("status")!;
const roomList = document.getElementById("room-list")!;

const quickBtn = document.getElementById("quickplay") as HTMLButtonElement;
const createBtn = document.getElementById("create-btn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;

const cfgMap = document.getElementById("cfg-map") as HTMLSelectElement;
const cfgDiff = document.getElementById("cfg-diff") as HTMLSelectElement;
const cfgBots = document.getElementById("cfg-bots") as HTMLInputElement;
const cfgBotCount = document.getElementById("cfg-botcount") as HTMLInputElement;
const cfgBotCountVal = document.getElementById("cfg-botcount-val")!;
const cfgName = document.getElementById("cfg-name") as HTMLInputElement;
const skinsEl = document.getElementById("skins")!;
const loadoutSel = document.getElementById("cfg-loadout") as HTMLSelectElement;

nameInput.value = localStorage.getItem("drunkr.name") ?? "";

// --- Skins -----------------------------------------------------------------
const SKIN_HUES = [0.0, 0.08, 0.13, 0.33, 0.5, 0.58, 0.75, 0.85];
let selectedHue = Number(localStorage.getItem("drunkr.skin") ?? SKIN_HUES[5]);
for (const hue of SKIN_HUES) {
  const sw = document.createElement("button");
  sw.className = "skin";
  sw.style.background = `hsl(${hue * 360}, 85%, 55%)`;
  if (Math.abs(hue - selectedHue) < 0.001) sw.classList.add("active");
  sw.addEventListener("click", () => {
    selectedHue = hue;
    localStorage.setItem("drunkr.skin", String(hue));
    skinsEl.querySelectorAll(".skin").forEach((s) => s.classList.remove("active"));
    sw.classList.add("active");
  });
  skinsEl.appendChild(sw);
}
loadoutSel.value = localStorage.getItem("drunkr.loadout") ?? "ak";
loadoutSel.addEventListener("change", () =>
  localStorage.setItem("drunkr.loadout", loadoutSel.value));

const classSel = document.getElementById("cfg-class") as HTMLSelectElement;
classSel.value = localStorage.getItem("drunkr.class") ?? "wind";
classSel.addEventListener("change", () => localStorage.setItem("drunkr.class", classSel.value));

function prefs() {
  return { skin: selectedHue, weapon: loadoutSel.value, cls: classSel.value };
}

// --- Settings --------------------------------------------------------------
const setSens = document.getElementById("set-sens") as HTMLInputElement;
const setSensVal = document.getElementById("set-sens-val")!;
const setScoped = document.getElementById("set-scoped") as HTMLInputElement;
const setScopedVal = document.getElementById("set-scoped-val")!;
const setQuality = document.getElementById("set-quality") as HTMLSelectElement;
const setFps = document.getElementById("set-fps") as HTMLSelectElement;
const setShowFps = document.getElementById("set-showfps") as HTMLInputElement;

setSens.value = String(settings.sensitivity);
setSensVal.textContent = settings.sensitivity.toFixed(2);
setScoped.value = String(settings.scopedSens);
setScopedVal.textContent = settings.scopedSens.toFixed(2);
setQuality.value = settings.quality;
setFps.value = String(settings.fpsCap);
setShowFps.checked = settings.showFps;

setSens.addEventListener("input", () => {
  settings.sensitivity = Number(setSens.value);
  setSensVal.textContent = settings.sensitivity.toFixed(2);
  saveSettings();
});
setScoped.addEventListener("input", () => {
  settings.scopedSens = Number(setScoped.value);
  setScopedVal.textContent = settings.scopedSens.toFixed(2);
  saveSettings();
});
setQuality.addEventListener("change", () => {
  settings.quality = setQuality.value as Settings["quality"];
  saveSettings();
});
setFps.addEventListener("change", () => {
  settings.fpsCap = Number(setFps.value);
  saveSettings();
});
setShowFps.addEventListener("change", () => {
  settings.showFps = setShowFps.checked;
  saveSettings();
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

function createRoom() {
  if (!net.connected || game) return;
  net.send({
    t: "create",
    name: callsign(),
    ...prefs(),
    config: {
      name: cfgName.value.trim(),
      mapId: cfgMap.value,
      bots: cfgBots.checked,
      botCount: Number(cfgBotCount.value),
      difficulty: cfgDiff.value as BotDifficulty,
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
    game = new Game(canvas, net, msg);
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
