import { WebSocketServer, WebSocket } from "ws";
import {
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
  type PlayerState,
  type Vec3,
  type GameMap,
  type BotDifficulty,
  type RoomConfig,
  type RoomInfo,
  MOVE,
  PLAYER,
  WEAPONS,
  DEFAULT_WEAPON,
  SNAPSHOT_RATE,
  TICK_RATE,
  MAPS,
  CollisionWorld,
  stepMovement,
} from "@drunkr/shared";

const PORT = Number(process.env.PORT ?? 2567);
const DEFAULT_MAP = process.env.MAP && MAPS[process.env.MAP] ? process.env.MAP : "neon_yard";
const DEFAULT_BOTS = Number(process.env.BOTS ?? 4);
const MAX_PLAYERS = 12;

const weaponOf = (a: Actor) => WEAPONS[a.state.weapon] ?? WEAPONS[DEFAULT_WEAPON];

/** Bot difficulty presets — these make bots fair / beatable. */
const BOT_DIFF: Record<BotDifficulty, {
  aimLerp: number; spread: number; react: [number, number]; fire: [number, number]; range: number;
}> = {
  easy:   { aimLerp: 0.06, spread: 0.14, react: [450, 850], fire: [320, 560], range: 40 },
  normal: { aimLerp: 0.11, spread: 0.10, react: [300, 560], fire: [220, 380], range: 60 },
  hard:   { aimLerp: 0.18, spread: 0.06, react: [170, 320], fire: [130, 230], range: 200 },
};

const BOT_NAMES = ["GHOST", "VIPER", "NEON", "RAZR", "BYTE", "HEX", "FLUX", "ZERO", "DRX", "KILO"];

interface BotAI {
  waypoint: Vec3;
  repathAt: number;
  nextJumpAt: number;
  targetId: number;
  retargetAt: number;
  nextShotAt: number;
  reactAt: number;
}

/** A participant: a connected client (ws set) or a bot (ai set). */
interface Actor {
  id: number;
  ws: WebSocket | null;
  state: PlayerState;
  vel: Vec3;
  grounded: boolean;
  lastSeen: number;
  ai?: BotAI;
}

interface Room {
  id: string;
  name: string;
  mapId: string;
  map: GameMap;
  world: CollisionWorld;
  difficulty: BotDifficulty;
  botsEnabled: boolean;
  botCount: number;
  actors: Map<number, Actor>;
  persistent: boolean;
}

const rooms = new Map<string, Room>();
let nextId = 1;
let nextRoomNum = 1;

// --- room lifecycle --------------------------------------------------------

function createRoom(config: RoomConfig, persistent = false): Room {
  const mapId = MAPS[config.mapId] ? config.mapId : DEFAULT_MAP;
  const map = MAPS[mapId];
  const id = `r${nextRoomNum++}`;
  const room: Room = {
    id,
    name: (config.name || `${map.name} #${id}`).slice(0, 24),
    mapId,
    map,
    world: new CollisionWorld(map),
    difficulty: config.difficulty in BOT_DIFF ? config.difficulty : "normal",
    botsEnabled: config.bots,
    botCount: config.bots ? clamp(Math.round(config.botCount), 0, 10) : 0,
    actors: new Map(),
    persistent,
  };
  rooms.set(id, room);
  for (let i = 0; i < room.botCount; i++) spawnBot(room);
  return room;
}

function realCount(room: Room): number {
  let n = 0;
  for (const a of room.actors.values()) if (a.ws) n++;
  return n;
}

function botCountOf(room: Room): number {
  let n = 0;
  for (const a of room.actors.values()) if (a.ai) n++;
  return n;
}

function roomInfo(room: Room): RoomInfo {
  return {
    id: room.id,
    name: room.name,
    mapId: room.mapId,
    mapName: room.map.name,
    players: realCount(room),
    maxPlayers: MAX_PLAYERS,
    bots: botCountOf(room),
    difficulty: room.difficulty,
  };
}

function roomList(): RoomInfo[] {
  return [...rooms.values()].map(roomInfo);
}

function maybeCloseRoom(room: Room) {
  if (!room.persistent && realCount(room) === 0) rooms.delete(room.id);
}

/** Quick play: most-populated room with space, else a fresh default room. */
function quickPlayRoom(): Room {
  let best: Room | null = null;
  for (const r of rooms.values()) {
    if (realCount(r) >= MAX_PLAYERS) continue;
    if (!best || realCount(r) > realCount(best)) best = r;
  }
  if (best) return best;
  return createRoom(
    { name: "Quick Play", mapId: DEFAULT_MAP, bots: DEFAULT_BOTS > 0, botCount: DEFAULT_BOTS, difficulty: "normal" },
    false,
  );
}

// --- helpers ---------------------------------------------------------------

function send(ws: WebSocket | null, msg: ServerMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

function broadcast(room: Room, msg: ServerMessage, except?: number) {
  const data = encode(msg);
  for (const [id, a] of room.actors) {
    if (id === except || !a.ws) continue;
    if (a.ws.readyState === WebSocket.OPEN) a.ws.send(data);
  }
}

function clamp(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x;
}

function pickSpawn(room: Room): Vec3 {
  let best = room.map.spawns[0];
  let bestDist = -Infinity;
  for (const spawn of room.map.spawns) {
    let nearest = Infinity;
    for (const a of room.actors.values()) {
      if (a.state.dead) continue;
      const dx = a.state.pos.x - spawn.x;
      const dz = a.state.pos.z - spawn.z;
      nearest = Math.min(nearest, dx * dx + dz * dz);
    }
    if (nearest > bestDist) { bestDist = nearest; best = spawn; }
  }
  return { x: best.x, y: best.y, z: best.z };
}

function makeState(room: Room, id: number, name: string): PlayerState {
  const s = pickSpawn(room);
  return {
    id, name: name.slice(0, 16) || `runner${id}`,
    pos: { x: s.x, y: s.y, z: s.z },
    yaw: 0, pitch: 0,
    health: PLAYER.maxHealth, hue: Math.random(),
    kills: 0, deaths: 0, dead: false,
    weapon: DEFAULT_WEAPON,
  };
}

// --- hit detection / damage ------------------------------------------------

function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

function rayHitsPlayer(origin: Vec3, dir: Vec3, p: PlayerState) {
  const chest = { x: p.pos.x, y: p.pos.y + MOVE.height * 0.55, z: p.pos.z };
  const head = { x: p.pos.x, y: p.pos.y + MOVE.height * 0.92, z: p.pos.z };
  const bodyHit = raySphere(origin, dir, chest, MOVE.radius + 0.15);
  const headHit = raySphere(origin, dir, head, 0.28);
  if (headHit >= 0 && (bodyHit < 0 || headHit <= bodyHit))
    return { hit: true, head: true, dist: headHit };
  if (bodyHit >= 0) return { hit: true, head: false, dist: bodyHit };
  return { hit: false, head: false, dist: Infinity };
}

function handleShoot(room: Room, shooter: Actor, origin: Vec3, dir: Vec3) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  broadcast(room, { t: "shot", from: shooter.id, origin, dir: d }, shooter.id);

  let bestId = -1, bestDist = weaponOf(shooter).range, bestHead = false;
  for (const [id, a] of room.actors) {
    if (id === shooter.id || a.state.dead) continue;
    const res = rayHitsPlayer(origin, d, a.state);
    // Bullets are blocked by walls between shooter and victim.
    if (res.hit && res.dist < bestDist && !room.world.segmentBlocked(origin, a.state.pos)) {
      bestDist = res.dist; bestId = id; bestHead = res.head;
    }
  }
  if (bestId < 0) return;
  applyDamage(room, shooter, room.actors.get(bestId)!, bestHead);
}

function applyDamage(room: Room, attacker: Actor, victim: Actor, head: boolean) {
  if (victim.state.dead) return;
  const w = weaponOf(attacker);
  const dmg = Math.round(w.damage * (head ? w.headshotMul : 1));
  victim.state.health -= dmg;
  send(victim.ws, { t: "damage", health: Math.max(0, victim.state.health), from: attacker.id });

  if (victim.state.health <= 0) {
    victim.state.dead = true;
    victim.state.health = 0;
    victim.state.deaths++;
    attacker.state.kills++;
    broadcast(room, { t: "kill", killer: attacker.id, victim: victim.id, head });
    setTimeout(() => respawn(room, victim), PLAYER.respawnDelayMs);
  }
}

function respawn(room: Room, a: Actor) {
  if (!room.actors.has(a.id)) return;
  const s = pickSpawn(room);
  a.state.pos = { x: s.x, y: s.y, z: s.z };
  a.state.health = PLAYER.maxHealth;
  a.state.dead = false;
  a.vel = { x: 0, y: 0, z: 0 };
  a.grounded = false;
  broadcast(room, { t: "respawned", id: a.id, pos: a.state.pos, health: a.state.health });
}

// --- bots ------------------------------------------------------------------

function randomPoint(room: Room): Vec3 {
  const b = room.map.bounds - 4;
  return { x: (Math.random() * 2 - 1) * b, y: 0, z: (Math.random() * 2 - 1) * b };
}

function spawnBot(room: Room) {
  const id = nextId++;
  const name = BOT_NAMES[(id - 1) % BOT_NAMES.length];
  const now = Date.now();
  const state = makeState(room, id, name);
  // ~35% of bots carry the sniper, the rest the AK.
  state.weapon = Math.random() < 0.35 ? "sniper" : "ak";
  room.actors.set(id, {
    id, ws: null, state,
    vel: { x: 0, y: 0, z: 0 }, grounded: false, lastSeen: now,
    ai: {
      waypoint: randomPoint(room), repathAt: now + 2000,
      nextJumpAt: now + 500, targetId: -1, retargetAt: 0, nextShotAt: 0, reactAt: 0,
    },
  });
}

const eye = (p: PlayerState): Vec3 => ({ x: p.pos.x, y: p.pos.y + MOVE.eyeHeight, z: p.pos.z });
const chest = (p: PlayerState): Vec3 => ({ x: p.pos.x, y: p.pos.y + MOVE.height * 0.6, z: p.pos.z });

function lerpAngleTo(cur: number, target: number, t: number): number {
  let diff = target - cur;
  while (diff < -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;
  return cur + diff * t;
}

const rng = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

function updateBot(room: Room, bot: Actor, now: number, dt: number) {
  const ai = bot.ai!;
  if (bot.state.dead) return;
  const me = bot.state;
  const diff = BOT_DIFF[room.difficulty];

  // Target acquisition: nearest visible enemy within difficulty range.
  if (now >= ai.retargetAt) {
    ai.retargetAt = now + 400;
    let bestId = -1, bestDist = Infinity;
    for (const [id, a] of room.actors) {
      if (id === bot.id || a.state.dead) continue;
      const dist = Math.hypot(a.state.pos.x - me.pos.x, a.state.pos.z - me.pos.z);
      if (dist > diff.range) continue;
      if (room.world.segmentBlocked(eye(me), chest(a.state))) continue;
      if (dist < bestDist) { bestDist = dist; bestId = id; }
    }
    if (bestId !== ai.targetId) {
      ai.targetId = bestId;
      if (bestId >= 0) ai.reactAt = now + rng(diff.react[0], diff.react[1]);
    }
  }

  const target = ai.targetId >= 0 ? room.actors.get(ai.targetId) : undefined;
  const targetVisible =
    !!target && !target.state.dead && !room.world.segmentBlocked(eye(me), chest(target.state));

  // Aim toward target (smoothed by difficulty).
  if (target && targetVisible) {
    const t = chest(target.state), o = eye(me);
    const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const flat = Math.hypot(dx, dz);
    me.yaw = lerpAngleTo(me.yaw, Math.atan2(dx, dz), diff.aimLerp);
    me.pitch += (Math.atan2(dy, flat) - me.pitch) * diff.aimLerp;
  }

  // Movement: chase/strafe around target, else wander; repath when arrived/stuck.
  const dxw = ai.waypoint.x - me.pos.x, dzw = ai.waypoint.z - me.pos.z;
  const wpDist = Math.hypot(dxw, dzw);
  if (now >= ai.repathAt || wpDist < 2) {
    ai.repathAt = now + rng(1500, 3000);
    if (target && Math.random() < 0.6) {
      const a = Math.atan2(target.state.pos.z - me.pos.z, target.state.pos.x - me.pos.x);
      const side = Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
      const r = rng(8, 16);
      ai.waypoint = {
        x: clamp(target.state.pos.x + Math.cos(a + side) * r, -room.map.bounds + 3, room.map.bounds - 3),
        y: 0,
        z: clamp(target.state.pos.z + Math.sin(a + side) * r, -room.map.bounds + 3, room.map.bounds - 3),
      };
    } else {
      ai.waypoint = randomPoint(room);
    }
  }

  let wishX = 0, wishZ = 0;
  if (wpDist > 0.001) { wishX = dxw / wpDist; wishZ = dzw / wpDist; }

  let jump = false;
  if (bot.grounded && now >= ai.nextJumpAt) {
    jump = true;
    ai.nextJumpAt = now + rng(90, 210);
  }

  if (!targetVisible && wpDist > 0.001) me.yaw = Math.atan2(wishX, wishZ);

  const moveState = { pos: me.pos, vel: bot.vel, grounded: bot.grounded };
  const res = stepMovement(
    moveState, { wishX, wishZ, wishSpeed: MOVE.speed, jump, crouch: false }, room.world, dt,
  );
  bot.grounded = moveState.grounded;
  // Stuck against a wall → repath soon (to a random nearby point to escape).
  if (res.hitWall && now + 300 < ai.repathAt) {
    ai.repathAt = now + 300;
    if (Math.random() < 0.5) ai.waypoint = randomPoint(room);
  }
  if (me.pos.y < -10) respawn(room, bot);

  // Shooting.
  if (target && targetVisible && now >= ai.reactAt && now >= ai.nextShotAt) {
    const w = weaponOf(bot);
    const o = eye(me), t = chest(target.state);
    let dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const aimDot = dx * Math.sin(me.yaw) + dz * Math.cos(me.yaw);
    // Snipers wait for a tighter lock; their one-shot is balanced by extra
    // spread and the lever-action cycle time.
    const sniper = w.id === "sniper";
    const spread = diff.spread + (sniper ? 0.04 : 0);
    if (aimDot > (sniper ? 0.985 : 0.96)) {
      handleShoot(room, bot, o, {
        x: dx + (Math.random() - 0.5) * spread,
        y: dy + (Math.random() - 0.5) * spread,
        z: dz + (Math.random() - 0.5) * spread,
      });
      // Never fire faster than the weapon can cycle.
      const cycle = Math.max(60_000 / w.fireRate, w.magazine <= 1 ? w.reloadMs : 0);
      ai.nextShotAt = now + Math.max(rng(diff.fire[0], diff.fire[1]), cycle);
    }
  }
}

// --- connections -----------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  let actor: Actor | null = null;
  let room: Room | null = null;

  function joinRoom(target: Room, name: string) {
    const id = nextId++;
    const state = makeState(target, id, name);
    actor = { id, ws, state, vel: { x: 0, y: 0, z: 0 }, grounded: false, lastSeen: Date.now() };
    room = target;
    target.actors.set(id, actor);
    send(ws, {
      t: "welcome", id, mapId: target.mapId, roomId: target.id, roomName: target.name,
      tickRate: TICK_RATE, snapshotRate: SNAPSHOT_RATE,
      players: [...target.actors.values()].map((a) => a.state),
    });
    broadcast(target, { t: "pjoin", player: state }, id);
    console.log(`+ ${state.name} (#${id}) -> ${target.name} (${realCount(target)} players)`);
  }

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try { msg = decode<ClientMessage>(raw.toString()); } catch { return; }

    if (msg.t === "rooms") {
      send(ws, { t: "roomlist", rooms: roomList() });
      return;
    }

    if (msg.t === "create") {
      if (actor) return;
      joinRoom(createRoom(msg.config, false), msg.name);
      return;
    }

    if (msg.t === "join") {
      if (actor) return;
      const target = msg.roomId && rooms.get(msg.roomId);
      if (msg.roomId && (!target || realCount(target) >= MAX_PLAYERS)) {
        // Requested room is gone/full — fall back to quick play.
        joinRoom(quickPlayRoom(), msg.name);
      } else {
        joinRoom(target || quickPlayRoom(), msg.name);
      }
      return;
    }

    if (!actor || !room) return;
    actor.lastSeen = Date.now();

    switch (msg.t) {
      case "state":
        if (actor.state.dead) break;
        actor.state.pos = {
          x: clamp(msg.pos.x, -room.map.bounds, room.map.bounds),
          y: clamp(msg.pos.y, -5, 60),
          z: clamp(msg.pos.z, -room.map.bounds, room.map.bounds),
        };
        actor.state.yaw = msg.yaw;
        actor.state.pitch = msg.pitch;
        break;
      case "shoot":
        if (actor.state.dead) break;
        handleShoot(room, actor, msg.origin, msg.dir);
        break;
      case "respawn":
        if (actor.state.dead) respawn(room, actor);
        break;
      case "weapon":
        if (WEAPONS[msg.weapon]) actor.state.weapon = msg.weapon;
        break;
    }
  });

  ws.on("close", () => {
    if (actor && room) {
      room.actors.delete(actor.id);
      broadcast(room, { t: "pleave", id: actor.id });
      console.log(`- ${actor.state.name} (#${actor.id}) left ${room.name}`);
      maybeCloseRoom(room);
    }
  });
  ws.on("error", () => ws.close());
});

// --- loops -----------------------------------------------------------------

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const room of rooms.values()) {
    for (const a of room.actors.values()) if (a.ai) updateBot(room, a, now, dt);
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  for (const room of rooms.values()) {
    if (realCount(room) === 0) continue;
    broadcast(room, {
      t: "snapshot",
      time: Date.now(),
      players: [...room.actors.values()].map((a) => a.state),
    });
  }
}, 1000 / SNAPSHOT_RATE);

// A persistent default room so the browser is never empty.
createRoom(
  { name: "Quick Play", mapId: DEFAULT_MAP, bots: DEFAULT_BOTS > 0, botCount: DEFAULT_BOTS, difficulty: "normal" },
  true,
);

console.log(`Drunkr server on ws://localhost:${PORT}  default map: ${MAPS[DEFAULT_MAP].name}  bots: ${DEFAULT_BOTS}`);
