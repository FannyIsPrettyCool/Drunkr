import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  BOMB,
  PLAYER,
  WEAPONS,
  DEFAULT_WEAPON,
  LOADOUT_WEAPONS,
  CLASSES,
  CLASS_IDS,
  DEFAULT_CLASS,
  ABILITIES,
  INVIS,
  CONFUSION,
  GRENADE,
  FORTIFY,
  SHOCKWAVE,
  BLOODLUST,
  SIPHON,
  SNAPSHOT_RATE,
  TICK_RATE,
  MAPS,
  CollisionWorld,
  NavGrid,
  stepMovement,
  TEXTURE_KEYS,
  type ProjectileState,
} from "@drunkr/shared";

const PORT = Number(process.env.PORT ?? 2567);
const DEFAULT_MAP = process.env.MAP && MAPS[process.env.MAP] ? process.env.MAP : "neon_yard";
const DEFAULT_BOTS = Number(process.env.BOTS ?? 4);
const MAX_PLAYERS = 12;
/** How far back (ms) lag-compensated shots may rewind targets. */
const LAGCOMP_WINDOW_MS = 1000;
/** Equip delay (ms) before a freshly-switched weapon may fire. */
const WEAPON_SWITCH_MS = 250;

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
  // Navigation: a current goal + the A* path (world waypoints) toward it.
  goal: Vec3 | null;
  pathGoal: Vec3 | null;
  path: Vec3[];
  pathIdx: number;
  repathAt: number;
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
  // Combat strafing.
  strafeDir: number;
  strafeUntil: number;
  // Stuck detection (forces a repath if a bot stops making progress).
  stuckAt: number;
  stuckX: number;
  stuckZ: number;
  // Weapon/ability rotation.
  weaponSwitchAt: number;
  abilityFAt: number;
  abilityCAt: number;
  // Bomb mode: which site this bot defends/patrols (CT) — index into bombSites.
  bombSiteIdx: number;
  // Behavioral personality (set from the equipped weapon).
  behavior: BotBehavior;
  /** Whether this bot bunny-hops (vs. just running) while travelling. */
  bhop: boolean;
  /** A held position for campers; re-picked periodically. */
  campSpot: Vec3 | null;
  campUntil: number;
}

type BotBehavior = "rush" | "roam" | "camp";

/** Pick a movement personality to suit the weapon. */
function botBehaviorFor(weaponId: string): { behavior: BotBehavior; bhop: boolean } {
  // Snipers mostly hold angles (a few relocate); shotguns rush in close.
  if (weaponId === "sniper") return Math.random() < 0.7 ? { behavior: "camp", bhop: false } : { behavior: "roam", bhop: false };
  if (weaponId === "shotgun") return { behavior: "rush", bhop: Math.random() < 0.7 };
  // AK / default: aggressive or roaming, rarely camps; mixed bhop.
  const r = Math.random();
  const behavior: BotBehavior = r < 0.55 ? "rush" : r < 0.9 ? "roam" : "camp";
  return { behavior, bhop: Math.random() < 0.55 };
}

/** Minimum horizontal speed before a bot starts bunny-hopping (so it builds
 * ground speed first instead of bouncing in place). */
const BHOP_MIN_SPEED = 6;

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
  /** Recent positions (server-clock ms) for lag-compensated hit rewind. */
  posHistory: PosSample[];
  /** Vampire Bloodlust: timestamp (ms) until which dealt damage lifesteals. */
  bloodlustUntil?: number;
}

interface PosSample {
  t: number;
  x: number;
  y: number;
  z: number;
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
  /** Navigation grid for bot pathfinding (rebuilt when the map changes). */
  nav: NavGrid;
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
  // Bomb defusal mode
  mode: "ffa" | "bomb";
  bombTeams: Map<number, "T" | "CT">;
  bombPlanted: boolean;
  bombPos: Vec3 | null;
  bombDetonatesAt: number;
  bombRound: number;
  bombScoreT: number;
  bombScoreCT: number;
  bombRoundEndsAt: number;
  bombRoundOver: boolean;
  bombPlanterId: number;
  bombPlanterStart: number;
  bombDefuserId: number;
  bombDefuserStart: number;
  /** Which bomb site the T bots commit to this round (index into bombSites). */
  botTargetSite: number;
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
  const isBomb = config.mode === "bomb";
  // Bomb rooms always use dust2; custom maps are ignored in bomb mode.
  const custom = !isBomb && config.customMap ? validateMap(config.customMap) : null;
  const mapId = isBomb ? "dust2" : (custom ? "custom" : MAPS[config.mapId] ? config.mapId : DEFAULT_MAP);
  const map = MAPS[mapId] ?? custom ?? MAPS[DEFAULT_MAP];
  const id = `r${nextRoomNum++}`;
  const world = new CollisionWorld(map);
  const room: Room = {
    id,
    name: (config.name || `${map.name} #${id}`).slice(0, 24),
    mapId,
    map,
    customMap: custom ?? undefined,
    world,
    nav: new NavGrid(world, map.bounds),
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
    mode: isBomb ? "bomb" : "ffa",
    bombTeams: new Map(),
    bombPlanted: false,
    bombPos: null,
    bombDetonatesAt: 0,
    bombRound: 1,
    bombScoreT: 0,
    bombScoreCT: 0,
    bombRoundEndsAt: 0,
    bombRoundOver: false,
    bombPlanterId: -1,
    bombPlanterStart: 0,
    bombDefuserId: -1,
    bombDefuserStart: 0,
    botTargetSite: 0,
  };
  rooms.set(id, room);
  for (let i = 0; i < room.botCount; i++) spawnBot(room);
  // Bomb rooms: assign teams to bots now; first real player join triggers round start.
  if (isBomb && room.actors.size > 0) assignBombTeams(room);
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
    weapon, cls, invis: false, posture: 0,
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

// Body hitbox: a stack of overlapping spheres from the feet to the shoulders so
// the server covers the whole visible avatar (legs included), matching what the
// client raycasts against its mesh. The head is a tighter sphere for headshots.
const BODY_SPHERES: { y: number; r: number }[] = [
  { y: 0.35, r: 0.42 }, // legs / lower body
  { y: 0.70, r: 0.42 },
  { y: 1.05, r: 0.44 }, // chest
  { y: 1.40, r: 0.40 }, // shoulders
];
const HEAD_SPHERE = { y: MOVE.height * 0.92, r: 0.3 };

function rayHitsPlayer(origin: Vec3, dir: Vec3, pos: Vec3) {
  let bodyHit = -1;
  for (const s of BODY_SPHERES) {
    const c = { x: pos.x, y: pos.y + s.y, z: pos.z };
    const d = raySphere(origin, dir, c, s.r);
    if (d >= 0 && (bodyHit < 0 || d < bodyHit)) bodyHit = d;
  }
  const headC = { x: pos.x, y: pos.y + HEAD_SPHERE.y, z: pos.z };
  const headHit = raySphere(origin, dir, headC, HEAD_SPHERE.r);
  if (headHit >= 0 && (bodyHit < 0 || headHit <= bodyHit))
    return { hit: true, head: true, dist: headHit };
  if (bodyHit >= 0) return { hit: true, head: false, dist: bodyHit };
  return { hit: false, head: false, dist: Infinity };
}

/**
 * Where an actor was at server-clock time `t`, interpolated from its position
 * history (lag compensation). Falls back to the live position when `t` is in
 * the future, older than recorded history, or unset.
 */
function rewindPos(actor: Actor, t: number | undefined): Vec3 {
  const live = actor.state.pos;
  if (t === undefined) return live;
  const h = actor.posHistory;
  if (h.length === 0) return live;
  const newest = h[h.length - 1];
  if (t >= newest.t) return live;
  const oldest = h[0];
  if (t <= oldest.t) return { x: oldest.x, y: oldest.y, z: oldest.z };
  for (let i = h.length - 1; i > 0; i--) {
    const b = h[i], a = h[i - 1];
    if (a.t <= t && t <= b.t) {
      const span = b.t - a.t || 1;
      const f = (t - a.t) / span;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
      };
    }
  }
  return live;
}

function handleShoot(
  room: Room,
  shooter: Actor,
  origin: Vec3,
  dirs: Vec3[],
  melee: boolean,
  clientTime?: number,
) {
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

  // Clamp the rewind to a sane window so clock skew / stale packets can't make
  // shots resolve against ancient or future positions.
  const now = Date.now();
  let atTime: number | undefined;
  if (isFiniteNum(clientTime) && clientTime <= now + 200 && clientTime >= now - LAGCOMP_WINDOW_MS) {
    atTime = clientTime;
  }

  for (const d of norm) {
    let bestId = -1, bestDist = w.range, bestHead = false;
    for (const [id, a] of room.actors) {
      if (id === shooter.id || a.state.dead) continue;
      const pos = rewindPos(a, atTime);
      const res = rayHitsPlayer(origin, d, pos);
      if (!res.hit || res.dist >= bestDist) continue;
      // LOS check against the actual impact point (so headshots over low cover
      // aren't blocked by tracing to the target's feet).
      const aim = { x: origin.x + d.x * res.dist, y: origin.y + d.y * res.dist, z: origin.z + d.z * res.dist };
      if (room.world.segmentBlocked(origin, aim)) continue;
      bestDist = res.dist; bestId = id; bestHead = res.head;
    }
    if (bestId >= 0) {
      const at = { x: origin.x + d.x * bestDist, y: origin.y + d.y * bestDist, z: origin.z + d.z * bestDist };
      applyDamage(room, shooter, room.actors.get(bestId)!, bestHead, { from: origin, at });
    }
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
  } else if (ability === "bloodlust") {
    // Vampire: enable lifesteal-on-damage for a few seconds (see dealDamage).
    actor.bloodlustUntil = now + BLOODLUST.durationMs;
  } else if (ability === "siphon") {
    // Vampire: instant AoE life-drain — damage nearby enemies, heal per hit.
    broadcast(room, { t: "explosion", kind: "siphon", pos: actor.state.pos });
    let healed = 0;
    for (const a of room.actors.values()) {
      if (a.id === actor.id || a.state.dead) continue;
      const dist = Math.hypot(
        a.state.pos.x - actor.state.pos.x,
        a.state.pos.y - actor.state.pos.y,
        a.state.pos.z - actor.state.pos.z,
      );
      if (dist > SIPHON.radius) continue;
      dealDamage(room, actor, a, SIPHON.damage, false);
      healed += SIPHON.healPerHit;
    }
    if (healed > 0) {
      const cap = PLAYER.maxHealth + SIPHON.maxOverheal;
      if (actor.state.health < cap) actor.state.health = Math.min(cap, actor.state.health + healed);
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
    // Steep falloff: lethal at the epicenter, nearly harmless toward the edge.
    const dmg = Math.round(GRENADE.fragDamage * Math.pow(1 - dist / GRENADE.fragRadius, 2.5));
    if (dmg <= 0) continue;
    dealDamage(room, owner, a, dmg, false);
  }
}

function applyDamage(room: Room, attacker: Actor, victim: Actor, head: boolean, shot?: { from: Vec3; at: Vec3 }) {
  const w = weaponOf(attacker);
  dealDamage(room, attacker, victim, Math.round(w.damage * (head ? w.headshotMul : 1)), head, shot);
}

function dealDamage(room: Room, attacker: Actor, victim: Actor, dmg: number, head: boolean, shot?: { from: Vec3; at: Vec3 }) {
  if (victim.state.dead) return;
  const before = victim.state.health;
  victim.state.health -= dmg;
  send(victim.ws, { t: "damage", health: Math.max(0, victim.state.health), from: attacker.id });

  // Vampire Bloodlust: heal the attacker for a fraction of the damage actually
  // dealt while the buff is active (can briefly overheal). Reflected next snapshot.
  if (
    attacker.id !== victim.id && !attacker.state.dead &&
    attacker.bloodlustUntil && Date.now() < attacker.bloodlustUntil
  ) {
    const dealt = Math.max(0, before - Math.max(0, victim.state.health));
    const heal = Math.round(dealt * BLOODLUST.lifestealPct);
    const cap = PLAYER.maxHealth + BLOODLUST.maxOverheal;
    if (heal > 0 && attacker.state.health < cap) {
      attacker.state.health = Math.min(cap, attacker.state.health + heal);
    }
  }

  if (victim.state.health <= 0) {
    victim.state.dead = true;
    victim.state.health = 0;
    victim.state.deaths++;
    attacker.state.kills++;
    // Kill reward: refund 25 HP (capped at max, preserving any overheal). The
    // killer's client refills its held weapon's magazine off the "kill" broadcast.
    if (attacker.id !== victim.id && attacker.state.health < PLAYER.maxHealth) {
      attacker.state.health = Math.min(PLAYER.maxHealth, attacker.state.health + 25);
    }
    broadcast(room, {
      t: "kill", killer: attacker.id, victim: victim.id, head,
      ...(shot ? { from: shot.from, at: shot.at } : {}),
    });
    if (room.mode !== "bomb") {
      setTimeout(() => respawn(room, victim), PLAYER.respawnDelayMs);
    }
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

// --- bomb defusal mode -----------------------------------------------------

function pickTeamSpawn(room: Room, team: "T" | "CT"): Vec3 {
  const ctSpawns = room.map.spawnsCT ?? [];
  const spawns =
    team === "CT"
      ? (ctSpawns.length ? ctSpawns : room.map.spawns)
      : (ctSpawns.length
          ? room.map.spawns.slice(0, room.map.spawns.length - ctSpawns.length)
          : room.map.spawns);
  const list = spawns.length ? spawns : room.map.spawns;
  const s = list[Math.floor(Math.random() * list.length)];
  return { x: s.x, y: s.y, z: s.z };
}

function assignBombTeams(room: Room) {
  const ids = [...room.actors.keys()];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  room.bombTeams.clear();
  const half = Math.ceil(ids.length / 2);
  for (let i = 0; i < ids.length; i++) {
    room.bombTeams.set(ids[i], i < half ? "T" : "CT");
  }
}

function swapBombTeams(room: Room) {
  for (const [id, team] of room.bombTeams) {
    room.bombTeams.set(id, team === "T" ? "CT" : "T");
  }
}

function startBombRound(room: Room) {
  room.bombRoundOver = false;
  room.bombPlanted = false;
  room.bombPos = null;
  room.bombDetonatesAt = 0;
  room.bombPlanterId = -1;
  room.bombPlanterStart = 0;
  room.bombDefuserId = -1;
  room.bombDefuserStart = 0;
  room.bombRoundEndsAt = Date.now() + BOMB.roundMs;
  room.projectiles = [];
  // T bots commit to one site this round so they group up and can plant.
  room.botTargetSite = Math.floor(Math.random() * Math.max(1, room.map.bombSites?.length ?? 1));

  const players: PlayerState[] = [];
  for (const a of room.actors.values()) {
    const team = room.bombTeams.get(a.id) ?? "T";
    const s = pickTeamSpawn(room, team);
    a.state.pos = { x: s.x, y: s.y, z: s.z };
    a.state.health = PLAYER.maxHealth;
    a.state.dead = false;
    a.vel = { x: 0, y: 0, z: 0 };
    a.grounded = false;
    players.push(a.state);
  }

  broadcast(room, {
    t: "bombstart",
    teams: [...room.bombTeams.entries()].map(([id, team]) => ({ id, team })),
    roundNum: room.bombRound,
    scoreT: room.bombScoreT,
    scoreCT: room.bombScoreCT,
    roundEndsAt: room.bombRoundEndsAt,
    players,
  });
}

function endBombRound(
  room: Room,
  winner: "T" | "CT",
  reason: "bomb_exploded" | "bomb_defused" | "t_eliminated" | "ct_eliminated" | "time",
) {
  if (room.bombRoundOver) return;
  room.bombRoundOver = true;

  if (winner === "T") room.bombScoreT++;
  else room.bombScoreCT++;

  broadcast(room, {
    t: "bombroundend",
    winner,
    reason,
    scoreT: room.bombScoreT,
    scoreCT: room.bombScoreCT,
  });

  room.bombRound++;

  const winsNeeded = BOMB.switchAt + 1;
  if (room.bombScoreT >= winsNeeded || room.bombScoreCT >= winsNeeded || room.bombRound > BOMB.maxRounds) {
    setTimeout(() => endBombMatch(room), 4000);
    return;
  }

  if (room.bombRound === winsNeeded) swapBombTeams(room);

  setTimeout(() => {
    if (!room.intermission) startBombRound(room);
  }, 5000);
}

function endBombMatch(room: Room) {
  if (room.intermission) return;
  const winnerName = room.bombScoreT >= room.bombScoreCT ? "T SIDE" : "CT SIDE";
  room.voteMaps = ["dust2"];
  room.mapVotes = new Map();
  room.intermission = true;
  room.intermissionEndsAt = Date.now() + MATCH.intermissionMs;
  room.intermissionWinner = winnerName;
  broadcast(room, {
    t: "intermission",
    winnerName,
    endsAt: room.intermissionEndsAt,
    mapOptions: [{ id: "dust2", name: MAPS.dust2.name }],
    scores: [...room.actors.values()].map((a) => a.state),
  });
}

function tickBomb(room: Room, now: number) {
  if (room.bombRoundOver) return;

  // Plant progress: cancel if planter left site or died.
  if (room.bombPlanterId >= 0) {
    const planter = room.actors.get(room.bombPlanterId);
    let stillOnSite = false;
    if (planter && !planter.state.dead) {
      for (const site of room.map.bombSites ?? []) {
        const d = Math.hypot(planter.state.pos.x - site.pos.x, planter.state.pos.z - site.pos.z);
        if (d <= site.radius) { stillOnSite = true; break; }
      }
    }
    if (!stillOnSite) {
      broadcast(room, { t: "bombevent", event: "plant_cancel", actorId: room.bombPlanterId });
      room.bombPlanterId = -1;
      room.bombPlanterStart = 0;
      room.bombPos = null;
    } else if (now - room.bombPlanterStart >= BOMB.plantTime * 1000) {
      room.bombPlanted = true;
      room.bombDetonatesAt = now + BOMB.fuseMs;
      const plantedPos = room.bombPos!;
      room.bombPlanterId = -1;
      broadcast(room, { t: "bombevent", event: "planted", pos: plantedPos, detonatesAt: room.bombDetonatesAt });
    }
  }

  // Defuse progress: cancel if defuser left bomb or died.
  if (room.bombDefuserId >= 0 && room.bombPlanted && room.bombPos) {
    const defuser = room.actors.get(room.bombDefuserId);
    let stillInRange = false;
    if (defuser && !defuser.state.dead) {
      const d = Math.hypot(defuser.state.pos.x - room.bombPos.x, defuser.state.pos.z - room.bombPos.z);
      stillInRange = d <= BOMB.proximityRadius;
    }
    if (!stillInRange) {
      broadcast(room, { t: "bombevent", event: "defuse_cancel", actorId: room.bombDefuserId });
      room.bombDefuserId = -1;
      room.bombDefuserStart = 0;
    } else if (now - room.bombDefuserStart >= BOMB.defuseTime * 1000) {
      room.bombPlanted = false;
      broadcast(room, { t: "bombevent", event: "defused", actorId: room.bombDefuserId });
      room.bombDefuserId = -1;
      endBombRound(room, "CT", "bomb_defused");
      return;
    }
  }

  // Detonation.
  if (room.bombPlanted && now >= room.bombDetonatesAt && room.bombPos) {
    const pos = room.bombPos;
    broadcast(room, { t: "bombevent", event: "exploded", pos });
    for (const a of room.actors.values()) {
      if (a.state.dead) continue;
      const dist = Math.hypot(a.state.pos.x - pos.x, a.state.pos.y - pos.y, a.state.pos.z - pos.z);
      if (dist <= BOMB.explodeRadius) {
        a.state.health = Math.max(0, a.state.health - BOMB.explodeDamage);
        send(a.ws, { t: "damage", health: a.state.health, from: 0 });
        if (a.state.health <= 0) {
          a.state.dead = true;
          a.state.deaths++;
          broadcast(room, { t: "kill", killer: 0, victim: a.id, head: false });
        }
      }
    }
    endBombRound(room, "T", "bomb_exploded");
    return;
  }

  // Round timer.
  if (!room.bombPlanted && now >= room.bombRoundEndsAt) {
    endBombRound(room, "CT", "time");
    return;
  }

  // Elimination.
  let aliveT = 0, aliveCT = 0;
  for (const a of room.actors.values()) {
    if (a.state.dead) continue;
    const team = room.bombTeams.get(a.id);
    if (team === "T") aliveT++;
    else if (team === "CT") aliveCT++;
  }
  if (aliveT === 0) { endBombRound(room, "CT", "t_eliminated"); return; }
  if (aliveCT === 0) { endBombRound(room, "T", "ct_eliminated"); }
}

/** End the round: start 15-second intermission with map vote. */
function endMatch(room: Room) {
  if (room.intermission) return;
  let winner: Actor | null = null;
  for (const a of room.actors.values()) {
    if (!winner || a.state.kills > winner.state.kills) winner = a;
  }
  // Current map is always the first option so players can vote to replay it.
  // "custom" is never a key in MAPS, so filtering by id !== room.mapId still
  // returns all built-in maps when the room is running a custom map.
  const otherMaps = shuffle(Object.keys(MAPS).filter((id) => id !== room.mapId)).slice(0, 2);
  room.voteMaps = [room.mapId, ...otherMaps];
  room.mapVotes = new Map();
  room.intermission = true;
  room.intermissionEndsAt = Date.now() + MATCH.intermissionMs;
  room.intermissionWinner = winner ? winner.state.name : "nobody";
  const mapLabel = (id: string) => id === "custom" ? room.map.name : (MAPS[id]?.name ?? id);
  broadcast(room, {
    t: "intermission",
    winnerName: room.intermissionWinner,
    endsAt: room.intermissionEndsAt,
    mapOptions: room.voteMaps.map((id) => ({ id, name: mapLabel(id) })),
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

  if (nextMapId !== room.mapId) {
    room.mapId = nextMapId;
    room.map = MAPS[nextMapId];
    room.customMap = undefined;
    room.world = new CollisionWorld(room.map);
    room.nav = new NavGrid(room.world, room.map.bounds);
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
    ...(room.customMap ? { mapData: room.customMap } : {}),
    players: [...room.actors.values()].map((a) => a.state),
  });

  if (room.mode === "bomb") {
    room.bombRound = 1;
    room.bombScoreT = 0;
    room.bombScoreCT = 0;
    room.bombPlanted = false;
    room.bombPos = null;
    room.bombDetonatesAt = 0;
    room.bombRoundOver = false;
    room.bombPlanterId = -1;
    room.bombPlanterStart = 0;
    room.bombDefuserId = -1;
    room.bombDefuserStart = 0;
    assignBombTeams(room);
    startBombRound(room);
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
  if (a.ai) {
    a.ai.ammo = weaponOf(a).magazine;
    a.ai.reloadUntil = 0;
  }
  broadcast(room, { t: "respawned", id: a.id, pos: a.state.pos, health: a.state.health });
}

// --- bots ------------------------------------------------------------------

function spawnBot(room: Room) {
  const id = nextId++;
  const name = BOT_NAMES[(id - 1) % BOT_NAMES.length];
  const now = Date.now();
  const state = makeState(room, id, name);
  const roll = Math.random();
  state.weapon = roll < 0.3 ? "sniper" : roll < 0.5 ? "shotgun" : "ak";
  // Bots get random classes; weight toward classes with server-side abilities.
  state.cls = CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];
  const persona = botBehaviorFor(state.weapon);
  room.actors.set(id, {
    id, ws: null, state,
    vel: { x: 0, y: 0, z: 0 }, grounded: false, lastSeen: now,
    nextShot: 0, msgWindowStart: now, msgCount: 0, abilityCd: {}, posHistory: [],
    ai: {
      goal: null, pathGoal: null, path: [], pathIdx: 0, repathAt: 0,
      targetId: -1, retargetAt: 0, nextShotAt: 0, reactAt: 0,
      sliding: false, slideTime: 0, jumpsUsed: 0,
      ammo: (WEAPONS[state.weapon] ?? WEAPONS[DEFAULT_WEAPON]).magazine, reloadUntil: 0,
      strafeDir: Math.random() < 0.5 ? 1 : -1, strafeUntil: 0,
      stuckAt: now + 1000, stuckX: state.pos.x, stuckZ: state.pos.z,
      weaponSwitchAt: now + rng(25_000, 50_000),
      abilityFAt: now + rng(5_000, 15_000),
      abilityCAt: now + rng(7_000, 18_000),
      bombSiteIdx: Math.random() < 0.5 ? 0 : 1,
      behavior: persona.behavior, bhop: persona.bhop, campSpot: null, campUntil: 0,
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
  if (room.mode === "bomb" && room.bombRoundOver) return;
  const me = bot.state;
  const diff = BOT_DIFF[room.difficulty];

  // === TARGET ACQUISITION ===
  if (now >= ai.retargetAt) {
    ai.retargetAt = now + 350;
    let bestId = -1, bestDist = Infinity;
    for (const [id, a] of room.actors) {
      if (id === bot.id || a.state.dead) continue;
      if (room.mode === "bomb") {
        const myTeam = room.bombTeams.get(bot.id);
        const theirTeam = room.bombTeams.get(id);
        if (myTeam && theirTeam && myTeam === theirTeam) continue;
      }
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

  // === AIM TOWARD TARGET ===
  // Yaw convention: yaw=0 means model looks in -Z (same as local player camera at yaw=0).
  // We use atan2(-dx,-dz) so that the server yaw matches the client's rendering convention.
  if (target && targetVisible) {
    const t = chest(target.state), o = eye(me);
    const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const flat = Math.hypot(dx, dz);
    me.yaw = lerpAngleTo(me.yaw, Math.atan2(-dx, -dz), diff.aimLerp);
    me.pitch += (Math.atan2(dy, flat) - me.pitch) * diff.aimLerp;
  }

  // === DECIDE GOAL + IMMEDIATE BOMB ACTIONS ===
  const bombTeam = room.mode === "bomb" ? (room.bombTeams.get(bot.id) ?? null) : null;
  const isPlanter = bombTeam === "T" && room.bombPlanterId === bot.id;
  const isDefuser = bombTeam === "CT" && room.bombDefuserId === bot.id;
  const sites = room.map.bombSites ?? [];
  let goal: Vec3 | null = ai.goal;

  if (bombTeam === "T") {
    if (!room.bombPlanted) {
      const site = sites[room.botTargetSite % Math.max(1, sites.length)];
      if (site) {
        goal = { x: site.pos.x, y: 0, z: site.pos.z };
        const d = Math.hypot(me.pos.x - site.pos.x, me.pos.z - site.pos.z);
        // Begin the plant once we're inside the site and nobody else is planting.
        if (d <= site.radius - 1 && room.bombPlanterId === -1) {
          room.bombPlanterId = bot.id;
          room.bombPlanterStart = now;
          room.bombPos = { x: site.pos.x, y: site.pos.y, z: site.pos.z };
          broadcast(room, { t: "bombevent", event: "planting", pos: room.bombPos, actorId: bot.id });
        }
      }
    } else if (room.bombPos) {
      // Guard: hold a spot near the planted bomb, re-pick when reached.
      if (!ai.goal || Math.hypot(me.pos.x - ai.goal.x, me.pos.z - ai.goal.z) < 3) {
        goal = { x: room.bombPos.x + rng(-6, 6), y: 0, z: room.bombPos.z + rng(-6, 6) };
      }
    }
  } else if (bombTeam === "CT") {
    if (room.bombPlanted && room.bombPos) {
      goal = { x: room.bombPos.x, y: 0, z: room.bombPos.z };
      const d = Math.hypot(me.pos.x - room.bombPos.x, me.pos.z - room.bombPos.z);
      if (d <= BOMB.proximityRadius - 0.5 && room.bombDefuserId === -1) {
        room.bombDefuserId = bot.id;
        room.bombDefuserStart = now;
        broadcast(room, { t: "bombevent", event: "defusing", actorId: bot.id });
      }
    } else {
      // Patrol toward an assigned site; occasionally rotate to the other.
      if (now >= ai.repathAt && sites.length > 1 && Math.random() < 0.2) ai.bombSiteIdx ^= 1;
      const site = sites[ai.bombSiteIdx % Math.max(1, sites.length)];
      if (site && (!ai.goal || Math.hypot(me.pos.x - ai.goal.x, me.pos.z - ai.goal.z) < 4)) {
        goal = { x: site.pos.x + rng(-7, 7), y: 0, z: site.pos.z + rng(-7, 7) };
      }
    }
  } else if (ai.behavior === "camp") {
    // Campers hold a spot and snipe; they re-pick a new spot after holding it.
    if (!ai.campSpot) { ai.campSpot = room.nav.randomPoint(); ai.campUntil = 0; }
    const reached = Math.hypot(me.pos.x - ai.campSpot.x, me.pos.z - ai.campSpot.z) < 2.5;
    if (reached && ai.campUntil === 0) ai.campUntil = now + rng(5_000, 11_000);
    if (ai.campUntil !== 0 && now >= ai.campUntil) { ai.campSpot = room.nav.randomPoint(); ai.campUntil = 0; }
    goal = ai.campSpot;
  } else {
    // FFA rushers/roamers: hunt the current target, else wander.
    if (target) {
      goal = { x: target.state.pos.x, y: 0, z: target.state.pos.z };
    } else if (!ai.goal || Math.hypot(me.pos.x - ai.goal.x, me.pos.z - ai.goal.z) < 3) {
      goal = room.nav.randomPoint();
    }
  }
  ai.goal = goal;

  // === MOVEMENT ===
  let wishX = 0, wishZ = 0;
  const frozen = isPlanter || isDefuser;
  const targetDist = target ? Math.hypot(target.state.pos.x - me.pos.x, target.state.pos.z - me.pos.z) : Infinity;
  const combat = !frozen && !!target && targetVisible && targetDist < 26;

  if (frozen) {
    // Stand still on the bomb so the plant/defuse can't be cancelled by drifting.
  } else if (combat) {
    const tx = target!.state.pos.x - me.pos.x, tz = target!.state.pos.z - me.pos.z;
    const dl = Math.hypot(tx, tz) || 1;
    const fx = tx / dl, fz = tz / dl;
    if (now >= ai.strafeUntil) {
      ai.strafeDir = Math.random() < 0.5 ? 1 : -1;
      ai.strafeUntil = now + rng(450, 1100);
    }
    if (ai.behavior === "camp") {
      // Hold the angle and shoot; only give ground if the enemy closes in.
      if (targetDist < 9) { wishX = -fx; wishZ = -fz; } // kite back
      // else stand still (wish stays 0) for an accurate shot.
    } else {
      // Rushers crowd in close (shotgun range); roamers keep a mid distance.
      let mx = -fz * ai.strafeDir, mz = fx * ai.strafeDir;
      const near = ai.behavior === "rush" ? 5 : 7;
      const far = ai.behavior === "rush" ? 10 : 16;
      if (targetDist > far) { mx += fx * 1.3; mz += fz * 1.3; }   // close the gap
      else if (targetDist < near) { mx -= fx; mz -= fz; }         // back off if crowded
      const ml = Math.hypot(mx, mz) || 1;
      wishX = mx / ml; wishZ = mz / ml;
    }
  } else if (goal) {
    // Follow the A* path toward the goal; repath periodically / when goal moves.
    const goalMoved = ai.pathGoal ? Math.hypot(goal.x - ai.pathGoal.x, goal.z - ai.pathGoal.z) : Infinity;
    if (now >= ai.repathAt || ai.path.length === 0 || goalMoved > 4) {
      ai.path = room.nav.findPath(me.pos, goal) ?? [];
      ai.pathIdx = 0;
      ai.pathGoal = { x: goal.x, y: 0, z: goal.z };
      ai.repathAt = now + rng(600, 1200);
    }
    while (
      ai.pathIdx < ai.path.length &&
      Math.hypot(ai.path[ai.pathIdx].x - me.pos.x, ai.path[ai.pathIdx].z - me.pos.z) < 1.6
    ) ai.pathIdx++;
    const node = ai.path[ai.pathIdx] ?? goal;
    const dx = node.x - me.pos.x, dz = node.z - me.pos.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 0.001) { wishX = dx / dl; wishZ = dz / dl; }
  }

  const moving = wishX !== 0 || wishZ !== 0;

  // === BHOP / RUN ===
  // Run on the ground to build speed first, then (for bhop bots) hold jump to
  // auto-hop and keep that momentum. Jumping from a standstill just bounces in
  // place (air accel is capped), so we gate it on having real speed.
  const speed = Math.hypot(bot.vel.x, bot.vel.z);
  const jump = moving && !frozen && ai.bhop && speed > BHOP_MIN_SPEED;

  // === BODY FACING ===
  if (frozen && target) {
    const dx = target.state.pos.x - me.pos.x, dz = target.state.pos.z - me.pos.z;
    me.yaw = Math.atan2(-dx, -dz);
  } else if (!targetVisible && moving) {
    me.yaw = Math.atan2(-wishX, -wishZ);
  }

  // === STEP MOVEMENT ===
  const moveState = {
    pos: me.pos, vel: bot.vel, grounded: bot.grounded,
    sliding: ai.sliding, slideTime: ai.slideTime, jumpsUsed: ai.jumpsUsed,
  };
  stepMovement(
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

  // === STUCK DETECTION === force a fresh path if we've barely moved.
  if (now >= ai.stuckAt) {
    const moved = Math.hypot(me.pos.x - ai.stuckX, me.pos.z - ai.stuckZ);
    if (!frozen && !combat && moving && moved < 0.7) {
      ai.repathAt = 0;     // repath next tick
      ai.path = [];
    }
    ai.stuckX = me.pos.x; ai.stuckZ = me.pos.z; ai.stuckAt = now + 500;
  }

  if (me.pos.y < -10) {
    if (room.mode === "bomb") {
      bot.state.dead = true;
      bot.state.health = 0;
      bot.state.deaths++;
      broadcast(room, { t: "kill", killer: bot.id, victim: bot.id, head: false });
    } else {
      respawn(room, bot);
    }
  }

  // === ABILITIES ===
  if (now >= ai.abilityFAt) {
    const cls = CLASSES[me.cls] ?? CLASSES[DEFAULT_CLASS];
    if (cls.F) {
      const fwd = { x: -Math.sin(me.yaw), y: 0.2, z: -Math.cos(me.yaw) };
      handleAbility(room, bot, cls.F, eye(me), fwd);
    }
    ai.abilityFAt = now + rng(8_000, 20_000);
  }
  if (now >= ai.abilityCAt) {
    const cls = CLASSES[me.cls] ?? CLASSES[DEFAULT_CLASS];
    if (cls.C) {
      const fwd = { x: -Math.sin(me.yaw), y: 0.4, z: -Math.cos(me.yaw) };
      handleAbility(room, bot, cls.C, eye(me), fwd);
    }
    ai.abilityCAt = now + rng(10_000, 25_000);
  }

  // === WEAPON SWITCHING === (re-roll personality to suit the new weapon)
  if (now >= ai.weaponSwitchAt) {
    const others = LOADOUT_WEAPONS.filter((w) => w !== me.weapon);
    if (others.length > 0) {
      me.weapon = others[Math.floor(Math.random() * others.length)];
      ai.ammo = weaponOf(bot).magazine;
      ai.reloadUntil = 0;
      const persona = botBehaviorFor(me.weapon);
      ai.behavior = persona.behavior;
      ai.bhop = persona.bhop;
      ai.campSpot = null;
    }
    ai.weaponSwitchAt = now + rng(25_000, 50_000);
  }

  // === SHOOTING (aimDot sign fixed to match new yaw convention) ===
  if (target && targetVisible && now >= ai.reactAt && now >= ai.nextShotAt && now >= ai.reloadUntil) {
    const w = weaponOf(bot);
    const o = eye(me), t = chest(target.state);
    let dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // Negate because yaw now uses atan2(-dx,-dz), so forward = (-sin(yaw), -cos(yaw)).
    const aimDot = -(dx * Math.sin(me.yaw) + dz * Math.cos(me.yaw));
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
        ai.reloadUntil = now + w.reloadMs;
        ai.ammo = w.magazine;
      } else {
        ai.nextShotAt = now + Math.max(rng(diff.fire[0], diff.fire[1]), 60_000 / w.fireRate);
      }
    }
  }
}

// --- connections -----------------------------------------------------------

// Serve the built client from this same process so the whole game is a single
// deployable on one port: static files over HTTP, gameplay over WS on the same
// origin (no separate static host, no hard-coded socket port).
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR ?? join(__dirname, "../../client/dist");
// Audio (and other) assets live in shared/assets and are served at /assets/ in
// dev by a Vite middleware. In production that middleware doesn't run, so serve
// them here too — otherwise /assets/*.wav 404s into the SPA fallback (silence).
const SHARED_ASSETS_DIR = process.env.SHARED_ASSETS_DIR ?? join(__dirname, "../../shared/assets");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const httpServer = http.createServer(async (req, res) => {
  // Tiny static file server with SPA fallback to index.html.
  const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // Shared assets (sounds, music): served from shared/assets, not the SPA bundle.
  // Match on the raw URL path (always "/"-separated) so this works on Windows
  // too, where path.normalize would switch to backslashes. No index.html
  // fallback — a missing asset must 404, not return HTML (which can't decode).
  if (reqPath.startsWith("/assets/")) {
    // Drop the prefix, normalize, strip ".." to prevent escaping.
    const sub = normalize(reqPath.slice("/assets/".length)).replace(/^(\.\.[/\\])+/, "");
    // Vite bundles JS/CSS into client/dist/assets/ — check there first.
    // Audio/media live in shared/assets/ — fall back there if not in the bundle.
    // Note: CLIENT_DIR is client/dist so bundle path is CLIENT_DIR/assets/sub,
    //       but SHARED_ASSETS_DIR is already shared/assets so its path is just SHARED_ASSETS_DIR/sub.
    for (const candidate of [join(CLIENT_DIR, "assets", sub), join(SHARED_ASSETS_DIR, sub)]) {
      try {
        const body = await readFile(candidate);
        res.writeHead(200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" });
        res.end(body);
        return;
      } catch { /* not in this dir, try next */ }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Strip any leading "../" segments so requests can't escape CLIENT_DIR.
  const rel = normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(CLIENT_DIR, rel === "/" || rel === "" ? "index.html" : rel);
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    // Unknown path: fall back to the SPA entry so client routing still works.
    filePath = join(CLIENT_DIR, "index.html");
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let actor: Actor | null = null;
  let room: Room | null = null;

  function joinRoom(target: Room, name: string, prefs?: PlayerPrefs) {
    const id = nextId++;
    const state = makeState(target, id, sanitizeName(name), prefs);
    const now = Date.now();
    actor = {
      id, ws, state, vel: { x: 0, y: 0, z: 0 }, grounded: false, lastSeen: now,
      nextShot: 0, msgWindowStart: now, msgCount: 0, abilityCd: {}, posHistory: [],
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
        mapOptions: target.voteMaps.map((mid) => ({ id: mid, name: mid === "custom" ? target.map.name : (MAPS[mid]?.name ?? mid) })),
        scores: [...target.actors.values()].map((a) => a.state),
      });
      const votes: Record<string, number> = {};
      for (const mid of target.voteMaps) votes[mid] = 0;
      for (const v of target.mapVotes.values()) votes[v] = (votes[v] ?? 0) + 1;
      send(ws, { t: "voteupdate", votes });
    } else if (target.mode === "bomb") {
      // Balance teams for the joining player.
      const ctCount = [...target.bombTeams.values()].filter((t) => t === "CT").length;
      const tCount = target.bombTeams.size - ctCount;
      target.bombTeams.set(id, tCount <= ctCount ? "T" : "CT");
      actor.state.dead = true;
      // If this is the first real player, kick off the first round now.
      if (realCount(target) === 1 && target.bombRoundEndsAt === 0) {
        startBombRound(target);
      }
      send(ws, {
        t: "bombstart",
        teams: [...target.bombTeams.entries()].map(([pid, team]) => ({ id: pid, team })),
        roundNum: target.bombRound,
        scoreT: target.bombScoreT,
        scoreCT: target.bombScoreCT,
        roundEndsAt: target.bombRoundEndsAt,
        players: [...target.actors.values()].map((a) => a.state),
      });
      if (target.bombPlanted && target.bombPos) {
        send(ws, { t: "bombevent", event: "planted", pos: target.bombPos, detonatesAt: target.bombDetonatesAt });
      }
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
        actor.state.posture = msg.posture === 1 || msg.posture === 2 ? msg.posture : 0;
        break;
      }
      case "shoot": {
        if (actor.state.dead || room.intermission) break;
        if (room.mode === "bomb" && room.bombRoundOver) break;
        if (!validVec(msg.origin) || !Array.isArray(msg.dirs)) break;
        const w = weaponOf(actor);
        const now = Date.now();
        // Anti-cheat: enforce the weapon's cycle time between trigger pulls.
        const cycle = Math.max(60_000 / w.fireRate, w.magazine === 1 ? w.reloadMs : 0) * 0.85;
        if (now < actor.nextShot) break;
        actor.nextShot = now + cycle;
        const maxDirs = Math.max(1, w.pellets ?? 1);
        const dirs = msg.dirs.filter(validVec).slice(0, maxDirs);
        handleShoot(room, actor, msg.origin, dirs, !!msg.melee, msg.clientTime);
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
          // In bomb mode you stay dead until the next round (no mid-round respawn).
          if (rm.mode !== "bomb") setTimeout(() => respawn(rm, self), PLAYER.respawnDelayMs);
        }
        break;
      }
      case "weapon":
        // Players may only switch to loadout weapons or the always-available katana.
        if (WEAPONS[msg.weapon] && (LOADOUT_WEAPONS.includes(msg.weapon) || msg.weapon === "katana")) {
          actor.state.weapon = msg.weapon;
          // Enforce the equip delay before the new weapon can fire.
          actor.nextShot = Math.max(actor.nextShot, Date.now() + WEAPON_SWITCH_MS);
        }
        break;
      case "ability":
        if (!room.intermission && !(room.mode === "bomb" && room.bombRoundOver) && typeof msg.ability === "string")
          handleAbility(room, actor, msg.ability, msg.origin, msg.dir);
        break;
      case "use": {
        if (room.mode !== "bomb" || actor.state.dead || room.bombRoundOver) break;
        if (!room.map.bombSites) break;
        const team = room.bombTeams.get(actor.id);
        const useNow = Date.now();
        const pos = actor.state.pos;

        if (msg.held) {
          if (team === "T" && !room.bombPlanted && room.bombPlanterId === -1) {
            for (const site of room.map.bombSites) {
              const d = Math.hypot(pos.x - site.pos.x, pos.z - site.pos.z);
              if (d <= site.radius) {
                room.bombPlanterId = actor.id;
                room.bombPlanterStart = useNow;
                room.bombPos = site.pos;
                broadcast(room, { t: "bombevent", event: "planting", pos: site.pos, actorId: actor.id });
                break;
              }
            }
          }
          if (team === "CT" && room.bombPlanted && room.bombPos && room.bombDefuserId === -1) {
            const d = Math.hypot(pos.x - room.bombPos.x, pos.z - room.bombPos.z);
            if (d <= BOMB.proximityRadius) {
              room.bombDefuserId = actor.id;
              room.bombDefuserStart = useNow;
              broadcast(room, { t: "bombevent", event: "defusing", actorId: actor.id });
            }
          }
        } else {
          if (room.bombPlanterId === actor.id) {
            room.bombPlanterId = -1;
            room.bombPlanterStart = 0;
            if (!room.bombPlanted) room.bombPos = null;
            broadcast(room, { t: "bombevent", event: "plant_cancel", actorId: actor.id });
          }
          if (room.bombDefuserId === actor.id) {
            room.bombDefuserId = -1;
            room.bombDefuserStart = 0;
            broadcast(room, { t: "bombevent", event: "defuse_cancel", actorId: actor.id });
          }
        }
        break;
      }
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
    } else if (room.mode === "bomb") {
      tickBomb(room, now);
      for (const a of room.actors.values()) if (a.ai) updateBot(room, a, now, dt);
      if (room.projectiles.length) updateProjectiles(room, now, dt);
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
    const time = Date.now();
    // Record each actor's position at this snapshot's timestamp so shots can be
    // rewound to exactly the world state a client interpolated against.
    for (const a of room.actors.values()) {
      const h = a.posHistory;
      h.push({ t: time, x: a.state.pos.x, y: a.state.pos.y, z: a.state.pos.z });
      const cutoff = time - LAGCOMP_WINDOW_MS;
      while (h.length > 1 && h[0].t < cutoff) h.shift();
    }
    const proj: ProjectileState[] = room.projectiles.map((p) => ({ id: p.id, kind: p.kind, pos: p.pos }));
    broadcast(room, {
      t: "snapshot",
      time,
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

httpServer.listen(PORT, () => {
  console.log(`Drunkr listening on :${PORT}  (client + ws, same origin)  default map: ${MAPS[DEFAULT_MAP].name}  bots: ${DEFAULT_BOTS}`);
});
