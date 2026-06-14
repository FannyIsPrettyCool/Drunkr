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
  type PlayerPrefs,
  MOVE,
  MATCH,
  PLAYER,
  WEAPONS,
  DEFAULT_WEAPON,
  LOADOUT_WEAPONS,
  CLASSES,
  DEFAULT_CLASS,
  ABILITIES,
  INVIS,
  CONFUSION,
  GRENADE,
  FORTIFY,
  SHOCKWAVE,
  SNAPSHOT_RATE,
  TICK_RATE,
  MAPS,
  CollisionWorld,
  stepMovement,
  TEXTURE_KEYS,
  type ProjectileState,
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
  // Movement sub-state for the shared stepMovement model.
  sliding: boolean;
  slideTime: number;
  jumpsUsed: number;
  // Magazine model so bots can't fire faster than they could reload.
  ammo: number;
  reloadUntil: number;
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
  /** Earliest time (ms) this actor is allowed to fire again (anti-cheat). */
  nextShot: number;
  /** Sliding window message counter for flood protection. */
  msgWindowStart: number;
  msgCount: number;
  /** Per-ability cooldown (earliest next-use timestamp). */
  abilityCd: Record<string, number>;
}

interface Projectile {
  id: number;
  owner: number;
  kind: "flash" | "frag";
  pos: Vec3;
  vel: Vec3;
  explodeAt: number;
}

interface Room {
  id: string;
  name: string;
  mapId: string;
  map: GameMap;
  /** Set when the map is a custom (editor) map, sent to joiners in welcome. */
  customMap?: GameMap;
  world: CollisionWorld;
  difficulty: BotDifficulty;
  botsEnabled: boolean;
  botCount: number;
  actors: Map<number, Actor>;
  persistent: boolean;
  /** Server-clock timestamp (ms) when the current match ends. */
  matchEndsAt: number;
  projectiles: Projectile[];
  /** True while in the 15-second intermission / map vote between rounds. */
  intermission: boolean;
  intermissionEndsAt: number;
  intermissionWinner: string;
  /** The three map options currently up for vote. */
  voteMaps: string[];
  /** actorId -> voted mapId. */
  mapVotes: Map<number, string>;
}

let nextProjId = 1;

const rooms = new Map<string, Room>();
let nextId = 1;
let nextRoomNum = 1;

/** Sanitize/validate an editor-supplied map; returns null if unusable. */
function validateMap(m: unknown): GameMap | null {
  if (!m || typeof m !== "object") return null;
  const raw = m as Partial<GameMap>;
  if (!Array.isArray(raw.boxes) || !Array.isArray(raw.spawns)) return null;
  const bounds = clamp(isFiniteNum(raw.bounds) ? raw.bounds : 40, 8, 200);
  const num = (n: unknown, d = 0) => (isFiniteNum(n) ? clamp(n, -500, 500) : d);
  const vec = (v: unknown): Vec3 => ({ x: num((v as Vec3)?.x), y: num((v as Vec3)?.y), z: num((v as Vec3)?.z) });
  const col = (c: unknown) => (isFiniteNum(c) ? clamp(Math.floor(c), 0, 0xffffff) : 0x2a2e45);

  const validTex = (t: unknown) => typeof t === "string" && (t === "none" || (TEXTURE_KEYS as readonly string[]).includes(t));
  const boxes = raw.boxes.slice(0, 600).map((b) => ({
    pos: vec(b.pos),
    size: { x: clamp(num((b.size as Vec3)?.x, 1), 0.1, 400), y: clamp(num((b.size as Vec3)?.y, 1), 0.1, 400), z: clamp(num((b.size as Vec3)?.z, 1), 0.1, 400) },
    color: col(b.color),
    ...(isFiniteNum(b.emissive) ? { emissive: col(b.emissive) } : {}),
    ...(b.rot ? { rot: vec(b.rot) } : {}),
    ...(validTex(b.texture) ? { texture: b.texture } : {}),
  }));
  const spawns = raw.spawns.slice(0, 64).map(vec);
  if (boxes.length === 0 || spawns.length === 0) return null;
  const sizeVec = (v: unknown): Vec3 => ({
    x: clamp(num((v as Vec3)?.x, 1), 0.1, 400),
    y: clamp(num((v as Vec3)?.y, 1), 0.1, 400),
    z: clamp(num((v as Vec3)?.z, 1), 0.1, 400),
  });
  const pads = Array.isArray(raw.pads)
    ? raw.pads.slice(0, 64).map((p) => ({ pos: vec(p.pos), size: sizeVec(p.size), launch: vec(p.launch), color: col(p.color), ...(p.rot ? { rot: vec(p.rot) } : {}) }))
    : undefined;
  const ramps = Array.isArray(raw.ramps)
    ? raw.ramps.slice(0, 64).map((r) => ({
        pos: vec(r.pos), size: sizeVec(r.size), dir: clamp(Math.floor(num(r.dir)), 0, 3), color: col(r.color),
        ...(isFiniteNum(r.emissive) ? { emissive: col(r.emissive) } : {}),
        ...(validTex(r.texture) ? { texture: r.texture } : {}),
      }))
    : undefined;
  return {
    name: (typeof raw.name === "string" ? raw.name : "Custom").slice(0, 24),
    bounds, spawns, boxes,
    ...(pads && pads.length ? { pads } : {}),
    ...(ramps && ramps.length ? { ramps } : {}),
  };
}

// --- room lifecycle --------------------------------------------------------

function createRoom(config: RoomConfig, persistent = false): Room {
  // A validated custom map (from the editor) takes precedence over a built-in.
  const custom = config.customMap ? validateMap(config.customMap) : null;
  const mapId = custom ? "custom" : MAPS[config.mapId] ? config.mapId : DEFAULT_MAP;
  const map = custom ?? MAPS[mapId];
  const id = `r${nextRoomNum++}`;
  const room: Room = {
    id,
    name: (config.name || `${map.name} #${id}`).slice(0, 24),
    mapId,
    map,
    customMap: custom ?? undefined,
    world: new CollisionWorld(map),
    difficulty: config.difficulty in BOT_DIFF ? config.difficulty : "normal",
    botsEnabled: config.bots,
    botCount: config.bots ? clamp(Math.round(config.botCount), 0, 10) : 0,
    actors: new Map(),
    persistent,
    matchEndsAt: Date.now() + MATCH.durationMs,
    projectiles: [],
    intermission: false,
    intermissionEndsAt: 0,
    intermissionWinner: "",
    voteMaps: [],
    mapVotes: new Map(),
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

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function validVec(v: unknown): v is Vec3 {
  return (
    !!v && typeof v === "object" &&
    isFiniteNum((v as Vec3).x) && isFiniteNum((v as Vec3).y) && isFiniteNum((v as Vec3).z)
  );
}

/** Strip control chars / markup and clamp length for display names. */
function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/[<>&]/g, "").slice(0, 16);
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

function makeState(room: Room, id: number, name: string, prefs?: PlayerPrefs): PlayerState {
  const s = pickSpawn(room);
  const hue = isFiniteNum(prefs?.skin) ? clamp(prefs!.skin!, 0, 1) : Math.random();
  const weapon = prefs?.weapon && LOADOUT_WEAPONS.includes(prefs.weapon) ? prefs.weapon : DEFAULT_WEAPON;
  const cls = prefs?.cls && CLASSES[prefs.cls] ? prefs.cls : DEFAULT_CLASS;
  return {
    id, name: name.slice(0, 16) || `runner${id}`,
    pos: { x: s.x, y: s.y, z: s.z },
    yaw: 0, pitch: 0,
    health: PLAYER.maxHealth, hue,
    kills: 0, deaths: 0, dead: false,
    weapon, cls, invis: false,
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

function handleShoot(room: Room, shooter: Actor, origin: Vec3, dirs: Vec3[], melee: boolean) {
  const w = weaponOf(shooter);
  // Anti-cheat: the muzzle must be near the shooter's actual eye position so a
  // client can't fire rays from across the map.
  const e = eye(shooter.state);
  if (Math.hypot(origin.x - e.x, origin.y - e.y, origin.z - e.z) > 3) return;

  const norm: Vec3[] = [];
  for (const d of dirs) {
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    norm.push({ x: d.x / len, y: d.y / len, z: d.z / len });
  }
  if (norm.length === 0) return;

  broadcast(
    room,
    { t: "shot", from: shooter.id, origin, dirs: norm, melee: melee || !!w.melee, weapon: w.id },
    shooter.id,
  );

  for (const d of norm) {
    let bestId = -1, bestDist = w.range, bestHead = false;
    for (const [id, a] of room.actors) {
      if (id === shooter.id || a.state.dead) continue;
      const res = rayHitsPlayer(origin, d, a.state);
      // Bullets are blocked by walls between shooter and victim.
      if (res.hit && res.dist < bestDist && !room.world.segmentBlocked(origin, a.state.pos)) {
        bestDist = res.dist; bestId = id; bestHead = res.head;
      }
    }
    if (bestId >= 0) applyDamage(room, shooter, room.actors.get(bestId)!, bestHead);
  }
}

// --- abilities & grenades --------------------------------------------------

function handleAbility(room: Room, actor: Actor, ability: string, origin?: Vec3, dir?: Vec3) {
  const cls = CLASSES[actor.state.cls] ?? CLASSES[DEFAULT_CLASS];
  // You may only use your own class's server-side abilities.
  if (ability !== cls.F && ability !== cls.C) return;
  const def = ABILITIES[ability as keyof typeof ABILITIES];
  if (!def || !def.server || actor.state.dead) return;
  const now = Date.now();
  if (now < (actor.abilityCd[ability] ?? 0)) return;
  actor.abilityCd[ability] = now + def.cooldownMs;

  if (ability === "invis") {
    actor.state.invis = true;
    setTimeout(() => { actor.state.invis = false; }, INVIS.durationMs);
  } else if (ability === "confusion") {
    for (const a of room.actors.values()) {
      if (a.id === actor.id || a.state.dead) continue;
      const d = Math.hypot(a.state.pos.x - actor.state.pos.x, a.state.pos.z - actor.state.pos.z);
      if (d > CONFUSION.radius) continue;
      const w = LOADOUT_WEAPONS[Math.floor(Math.random() * LOADOUT_WEAPONS.length)];
      a.state.weapon = w;
      send(a.ws, { t: "forceweapon", weapon: w });
    }
  } else if (ability === "flash" || ability === "frag") {
    spawnGrenade(room, actor, ability, origin, dir);
  } else if (ability === "fortify") {
    // Heal to full plus temporary overheal (reflected via the next snapshot).
    actor.state.health = PLAYER.maxHealth + FORTIFY.overheal;
  } else if (ability === "shockwave") {
    broadcast(room, { t: "explosion", kind: "frag", pos: actor.state.pos });
    for (const a of room.actors.values()) {
      if (a.id === actor.id || a.state.dead) continue;
      const dist = Math.hypot(
        a.state.pos.x - actor.state.pos.x,
        a.state.pos.y - actor.state.pos.y,
        a.state.pos.z - actor.state.pos.z,
      );
      if (dist > SHOCKWAVE.radius) continue;
      dealDamage(room, actor, a, SHOCKWAVE.damage, false);
    }
  }
}

function spawnGrenade(room: Room, owner: Actor, kind: "flash" | "frag", origin?: Vec3, dir?: Vec3) {
  const e = eye(owner.state);
  let o = validVec(origin) ? origin! : e;
  if (Math.hypot(o.x - e.x, o.y - e.y, o.z - e.z) > 3) o = e;
  let d = validVec(dir) ? dir! : { x: Math.sin(owner.state.yaw), y: 0.2, z: Math.cos(owner.state.yaw) };
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  room.projectiles.push({
    id: nextProjId++, owner: owner.id, kind,
    pos: { x: o.x, y: o.y, z: o.z },
    vel: { x: (d.x / len) * GRENADE.speed, y: (d.y / len) * GRENADE.speed + 3, z: (d.z / len) * GRENADE.speed },
    explodeAt: Date.now() + GRENADE.fuseMs,
  });
}

function insideSolid(room: Room, p: Vec3): boolean {
  const r = GRENADE.radius;
  for (const b of room.world.boxes) {
    if (
      p.x + r > b.minX && p.x - r < b.maxX &&
      p.y + r > b.minY && p.y - r < b.maxY &&
      p.z + r > b.minZ && p.z - r < b.maxZ
    ) return true;
  }
  return false;
}

function updateProjectiles(room: Room, now: number, dt: number) {
  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    const p = room.projectiles[i];
    p.vel.y -= GRENADE.gravity * dt;
    // Move axis-by-axis, bouncing off geometry.
    p.pos.x += p.vel.x * dt;
    if (insideSolid(room, p.pos)) { p.pos.x -= p.vel.x * dt; p.vel.x *= -GRENADE.bounce; }
    p.pos.z += p.vel.z * dt;
    if (insideSolid(room, p.pos)) { p.pos.z -= p.vel.z * dt; p.vel.z *= -GRENADE.bounce; }
    p.pos.y += p.vel.y * dt;
    if (insideSolid(room, p.pos)) { p.pos.y -= p.vel.y * dt; p.vel.y *= -GRENADE.bounce; p.vel.x *= 0.85; p.vel.z *= 0.85; }
    if (p.pos.y < GRENADE.radius) {
      p.pos.y = GRENADE.radius; p.vel.y = -p.vel.y * GRENADE.bounce; p.vel.x *= 0.85; p.vel.z *= 0.85;
    }
    if (now >= p.explodeAt) {
      explodeGrenade(room, p);
      room.projectiles.splice(i, 1);
    }
  }
}

function explodeGrenade(room: Room, p: Projectile) {
  broadcast(room, { t: "explosion", kind: p.kind, pos: p.pos });
  if (p.kind !== "frag") return; // flash blinds client-side
  const owner = room.actors.get(p.owner);
  if (!owner) return;
  for (const a of room.actors.values()) {
    if (a.state.dead) continue;
    const c = chest(a.state);
    const dist = Math.hypot(c.x - p.pos.x, c.y - p.pos.y, c.z - p.pos.z);
    if (dist > GRENADE.fragRadius) continue;
    if (room.world.segmentBlocked(p.pos, a.state.pos)) continue;
    const dmg = Math.round(GRENADE.fragDamage * (1 - dist / GRENADE.fragRadius));
    dealDamage(room, owner, a, dmg, false);
  }
}

function applyDamage(room: Room, attacker: Actor, victim: Actor, head: boolean) {
  const w = weaponOf(attacker);
  dealDamage(room, attacker, victim, Math.round(w.damage * (head ? w.headshotMul : 1)), head);
}

function dealDamage(room: Room, attacker: Actor, victim: Actor, dmg: number, head: boolean) {
  if (victim.state.dead) return;
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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** End the round: start 15-second intermission with map vote. */
function endMatch(room: Room) {
  if (room.intermission) return;
  let winner: Actor | null = null;
  for (const a of room.actors.values()) {
    if (!winner || a.state.kills > winner.state.kills) winner = a;
  }
  const allMaps = Object.keys(MAPS).filter((id) => id !== room.mapId);
  room.voteMaps = shuffle(allMaps).slice(0, 3);
  if (room.voteMaps.length === 0) room.voteMaps = [DEFAULT_MAP];
  room.mapVotes = new Map();
  room.intermission = true;
  room.intermissionEndsAt = Date.now() + MATCH.intermissionMs;
  room.intermissionWinner = winner ? winner.state.name : "nobody";
  broadcast(room, {
    t: "intermission",
    winnerName: room.intermissionWinner,
    endsAt: room.intermissionEndsAt,
    mapOptions: room.voteMaps.map((id) => ({ id, name: MAPS[id].name })),
    scores: [...room.actors.values()].map((a) => a.state),
  });
}

/** Called when intermission ends: switch map if voted, reset all actors. */
function startNextMatch(room: Room) {
  const tally = new Map<string, number>();
  for (const id of room.voteMaps) tally.set(id, 0);
  for (const mapId of room.mapVotes.values()) tally.set(mapId, (tally.get(mapId) ?? 0) + 1);
  let nextMapId = room.voteMaps[0] ?? DEFAULT_MAP;
  let bestVotes = -1;
  for (const [id, cnt] of tally) {
    if (cnt > bestVotes) { bestVotes = cnt; nextMapId = id; }
  }

  if (nextMapId !== room.mapId || room.customMap) {
    room.mapId = nextMapId;
    room.map = MAPS[nextMapId];
    room.customMap = undefined;
    room.world = new CollisionWorld(room.map);
  }

  room.intermission = false;
  room.intermissionEndsAt = 0;
  room.voteMaps = [];
  room.mapVotes = new Map();
  room.matchEndsAt = Date.now() + MATCH.durationMs;
  room.projectiles = [];

  for (const a of room.actors.values()) {
    a.state.kills = 0;
    a.state.deaths = 0;
    const s = pickSpawn(room);
    a.state.pos = { x: s.x, y: s.y, z: s.z };
    a.state.health = PLAYER.maxHealth;
    a.state.dead = false;
    a.vel = { x: 0, y: 0, z: 0 };
    a.grounded = false;
    if (a.ai) { a.ai.ammo = weaponOf(a).magazine; a.ai.reloadUntil = 0; }
  }

  broadcast(room, {
    t: "matchrestart",
    mapId: room.mapId,
    matchEndsAt: room.matchEndsAt,
    players: [...room.actors.values()].map((a) => a.state),
  });
}

function respawn(room: Room, a: Actor) {
  if (!room.actors.has(a.id)) return;
  const s = pickSpawn(room);
  a.state.pos = { x: s.x, y: s.y, z: s.z };
  a.state.health = PLAYER.maxHealth;
  a.state.dead = false;
  a.vel = { x: 0, y: 0, z: 0 };
  a.grounded = false;
  if (a.ai) {
    a.ai.ammo = weaponOf(a).magazine;
    a.ai.reloadUntil = 0;
  }
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
  // Bots roll a random loadout: AK, sniper, or shotgun.
  const roll = Math.random();
  state.weapon = roll < 0.3 ? "sniper" : roll < 0.5 ? "shotgun" : "ak";
  room.actors.set(id, {
    id, ws: null, state,
    vel: { x: 0, y: 0, z: 0 }, grounded: false, lastSeen: now,
    nextShot: 0, msgWindowStart: now, msgCount: 0, abilityCd: {},
    ai: {
      waypoint: randomPoint(room), repathAt: now + 2000,
      nextJumpAt: now + 500, targetId: -1, retargetAt: 0, nextShotAt: 0, reactAt: 0,
      sliding: false, slideTime: 0, jumpsUsed: 0,
      ammo: (WEAPONS[state.weapon] ?? WEAPONS[DEFAULT_WEAPON]).magazine, reloadUntil: 0,
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

  const moveState = {
    pos: me.pos, vel: bot.vel, grounded: bot.grounded,
    sliding: ai.sliding, slideTime: ai.slideTime, jumpsUsed: ai.jumpsUsed,
  };
  const res = stepMovement(
    moveState,
    {
      wishX, wishZ, wishSpeed: MOVE.speed,
      jump, jumpEdge: false, crouch: false, crouchEdge: false,
      speedMul: 1, maxJumps: 1, canSlide: false,
    },
    room.world, dt,
  );
  bot.grounded = moveState.grounded;
  ai.sliding = moveState.sliding;
  ai.slideTime = moveState.slideTime;
  ai.jumpsUsed = moveState.jumpsUsed;
  // Stuck against a wall → repath soon (to a random nearby point to escape).
  if (res.hitWall && now + 300 < ai.repathAt) {
    ai.repathAt = now + 300;
    if (Math.random() < 0.5) ai.waypoint = randomPoint(room);
  }
  if (me.pos.y < -10) respawn(room, bot);

  // Shooting (with a real magazine + reload downtime).
  if (target && targetVisible && now >= ai.reactAt && now >= ai.nextShotAt && now >= ai.reloadUntil) {
    const w = weaponOf(bot);
    const o = eye(me), t = chest(target.state);
    let dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const aimDot = dx * Math.sin(me.yaw) + dz * Math.cos(me.yaw);
    const sniper = w.id === "sniper";
    const spread = diff.spread + (sniper ? 0.04 : w.id === "shotgun" ? 0.07 : 0);
    if (aimDot > (sniper ? 0.985 : 0.96)) {
      const pellets = w.pellets ?? 1;
      const shotDirs: Vec3[] = [];
      for (let p = 0; p < pellets; p++) {
        shotDirs.push({
          x: dx + (Math.random() - 0.5) * spread,
          y: dy + (Math.random() - 0.5) * spread,
          z: dz + (Math.random() - 0.5) * spread,
        });
      }
      handleShoot(room, bot, o, shotDirs, !!w.melee);
      ai.ammo--;
      if (w.magazine > 0 && ai.ammo <= 0) {
        // Empty the mag → forced reload downtime, just like a player.
        ai.reloadUntil = now + w.reloadMs;
        ai.ammo = w.magazine;
      } else {
        ai.nextShotAt = now + Math.max(rng(diff.fire[0], diff.fire[1]), 60_000 / w.fireRate);
      }
    }
  }
}

// --- connections -----------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  let actor: Actor | null = null;
  let room: Room | null = null;

  function joinRoom(target: Room, name: string, prefs?: PlayerPrefs) {
    const id = nextId++;
    const state = makeState(target, id, sanitizeName(name), prefs);
    const now = Date.now();
    actor = {
      id, ws, state, vel: { x: 0, y: 0, z: 0 }, grounded: false, lastSeen: now,
      nextShot: 0, msgWindowStart: now, msgCount: 0, abilityCd: {},
    };
    room = target;
    target.actors.set(id, actor);
    send(ws, {
      t: "welcome", id, mapId: target.mapId, roomId: target.id, roomName: target.name,
      tickRate: TICK_RATE, snapshotRate: SNAPSHOT_RATE, matchEndsAt: target.matchEndsAt,
      ...(target.customMap ? { mapData: target.customMap } : {}),
      players: [...target.actors.values()].map((a) => a.state),
    });
    if (target.intermission) {
      send(ws, {
        t: "intermission",
        winnerName: target.intermissionWinner,
        endsAt: target.intermissionEndsAt,
        mapOptions: target.voteMaps.map((mid) => ({ id: mid, name: MAPS[mid].name })),
        scores: [...target.actors.values()].map((a) => a.state),
      });
      const votes: Record<string, number> = {};
      for (const mid of target.voteMaps) votes[mid] = 0;
      for (const v of target.mapVotes.values()) votes[v] = (votes[v] ?? 0) + 1;
      send(ws, { t: "voteupdate", votes });
    }
    broadcast(target, { t: "pjoin", player: state }, id);
    console.log(`+ ${state.name} (#${id}) -> ${target.name} (${realCount(target)} players)`);
  }

  ws.on("message", (raw) => {
    // Flood protection: cap messages per second per connection.
    if (actor) {
      const now = Date.now();
      if (now - actor.msgWindowStart > 1000) {
        actor.msgWindowStart = now;
        actor.msgCount = 0;
      }
      if (++actor.msgCount > 240) return; // ~4x the expected steady rate
    }

    let msg: ClientMessage;
    try { msg = decode<ClientMessage>(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "rooms") {
      send(ws, { t: "roomlist", rooms: roomList() });
      return;
    }

    if (msg.t === "create") {
      if (actor) return;
      joinRoom(createRoom(msg.config, false), msg.name, msg);
      return;
    }

    if (msg.t === "join") {
      if (actor) return;
      const target = msg.roomId && rooms.get(msg.roomId);
      if (msg.roomId && (!target || realCount(target) >= MAX_PLAYERS)) {
        // Requested room is gone/full — fall back to quick play.
        joinRoom(quickPlayRoom(), msg.name, msg);
      } else {
        joinRoom(target || quickPlayRoom(), msg.name, msg);
      }
      return;
    }

    if (!actor || !room) return;
    actor.lastSeen = Date.now();

    switch (msg.t) {
      case "state": {
        if (actor.state.dead) break;
        if (!validVec(msg.pos) || !isFiniteNum(msg.yaw) || !isFiniteNum(msg.pitch)) break;
        const b = room.map.bounds + 1;
        actor.state.pos = {
          x: clamp(msg.pos.x, -b, b),
          y: clamp(msg.pos.y, -15, 80),
          z: clamp(msg.pos.z, -b, b),
        };
        actor.state.yaw = msg.yaw;
        actor.state.pitch = clamp(msg.pitch, -Math.PI, Math.PI);
        break;
      }
      case "shoot": {
        if (actor.state.dead || room.intermission) break;
        if (!validVec(msg.origin) || !Array.isArray(msg.dirs)) break;
        const w = weaponOf(actor);
        const now = Date.now();
        // Anti-cheat: enforce the weapon's cycle time between trigger pulls.
        const cycle = Math.max(60_000 / w.fireRate, w.magazine === 1 ? w.reloadMs : 0) * 0.85;
        if (now < actor.nextShot) break;
        actor.nextShot = now + cycle;
        const maxDirs = Math.max(1, w.pellets ?? 1);
        const dirs = msg.dirs.filter(validVec).slice(0, maxDirs);
        handleShoot(room, actor, msg.origin, dirs, !!msg.melee);
        break;
      }
      case "respawn":
        if (actor.state.dead) respawn(room, actor);
        break;
      case "fell": {
        // Fell into the void → self-death.
        const rm = room, self = actor;
        if (!self.state.dead) {
          self.state.dead = true;
          self.state.health = 0;
          self.state.deaths++;
          broadcast(rm, { t: "kill", killer: self.id, victim: self.id, head: false });
          setTimeout(() => respawn(rm, self), PLAYER.respawnDelayMs);
        }
        break;
      }
      case "weapon":
        // Players may only switch to loadout weapons or the always-available katana.
        if (WEAPONS[msg.weapon] && (LOADOUT_WEAPONS.includes(msg.weapon) || msg.weapon === "katana")) {
          actor.state.weapon = msg.weapon;
        }
        break;
      case "ability":
        if (!room.intermission && typeof msg.ability === "string")
          handleAbility(room, actor, msg.ability, msg.origin, msg.dir);
        break;
      case "vote":
        if (room.intermission && room.voteMaps.includes(msg.mapId)) {
          room.mapVotes.set(actor.id, msg.mapId);
          const votes: Record<string, number> = {};
          for (const mid of room.voteMaps) votes[mid] = 0;
          for (const v of room.mapVotes.values()) votes[v] = (votes[v] ?? 0) + 1;
          broadcast(room, { t: "voteupdate", votes });
        }
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
    if (room.intermission) {
      if (now >= room.intermissionEndsAt) startNextMatch(room);
    } else {
      if (now >= room.matchEndsAt) endMatch(room);
      for (const a of room.actors.values()) if (a.ai) updateBot(room, a, now, dt);
      if (room.projectiles.length) updateProjectiles(room, now, dt);
    }
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  for (const room of rooms.values()) {
    if (realCount(room) === 0) continue;
    const proj: ProjectileState[] = room.projectiles.map((p) => ({ id: p.id, kind: p.kind, pos: p.pos }));
    broadcast(room, {
      t: "snapshot",
      time: Date.now(),
      players: [...room.actors.values()].map((a) => a.state),
      proj: proj.length ? proj : undefined,
    });
  }
}, 1000 / SNAPSHOT_RATE);

// A persistent default room so the browser is never empty.
createRoom(
  { name: "Quick Play", mapId: DEFAULT_MAP, bots: DEFAULT_BOTS > 0, botCount: DEFAULT_BOTS, difficulty: "normal" },
  true,
);

console.log(`Drunkr server on ws://localhost:${PORT}  default map: ${MAPS[DEFAULT_MAP].name}  bots: ${DEFAULT_BOTS}`);
