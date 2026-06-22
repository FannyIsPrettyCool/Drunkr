import type { Vec3 } from "./math.js";
import type { GameMap } from "./map.js";

/** Authoritative state the server tracks (and broadcasts) per player. */
export interface PlayerState {
  id: number;
  name: string;
  pos: Vec3;
  /** Look yaw (radians, around Y). */
  yaw: number;
  /** Look pitch (radians). */
  pitch: number;
  health: number;
  /** Hue (0..1) used to tint this player's avatar. */
  hue: number;
  /** Kills / deaths / assists for the scoreboard. */
  kills: number;
  deaths: number;
  assists: number;
  dead: boolean;
  /** Granted admin privileges (shows a crown + unlocks the admin panel). */
  admin?: boolean;
  /** Currently-held weapon id (see WEAPONS). */
  weapon: string;
  /** Chosen abilities [F, C] (see ABILITIES) — replaces the old class system. */
  abilities: string[];
  /** Invisible (Illusionist cloak) — remote clients hide the avatar. */
  invis: boolean;
  /** Spawn-protected (invincible just after respawning) — shows a shield. */
  invuln?: boolean;
  /** Posture for remote animation: 0 = standing, 1 = crouching, 2 = sliding. */
  posture?: number;
  /** Cosmetic weapon-skin id (recolours the held weapon). */
  wepSkin?: string;
  /** Custom palette for the currently-held weapon: [body,emissive,accent,metal,steel,glow] hex. */
  wepPalette?: number[];
  /** Cosmetic accessory id (worn on the avatar). */
  accessory?: string;
  /** Round-trip latency in ms (server-measured). */
  ping?: number;
  /** Match stats for the end screen. */
  shotsFired?: number;
  shotsHit?: number;
  headshots?: number;
}

/** A live grenade, sent in snapshots so clients can render it. */
export interface ProjectileState {
  id: number;
  kind: "flash" | "frag";
  pos: Vec3;
}

/** A Mirage decoy hologram, sent in snapshots so clients can render it. */
export interface DecoyState {
  id: number;
  pos: Vec3;
  hue: number;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type BotDifficulty = "easy" | "normal" | "hard";

/** Settings used when creating a room. */
export interface RoomConfig {
  name: string;
  mapId: string;
  bots: boolean;
  botCount: number;
  /** Bot difficulty; defaults to "normal" server-side when omitted. */
  difficulty?: BotDifficulty;
  /** An editor-exported map to host instead of a built-in (validated server-side). */
  customMap?: GameMap;
  /** Game mode — defaults to "ffa". */
  mode?: "ffa" | "bomb";
}

/** Summary of a room shown in the server browser. */
export interface RoomInfo {
  id: string;
  name: string;
  mapId: string;
  mapName: string;
  players: number;
  maxPlayers: number;
  bots: number;
  difficulty: BotDifficulty;
}

/** Cosmetic + loadout choices sent when entering a match. */
export interface PlayerPrefs {
  /** Skin hue 0..1. */
  skin?: number;
  /** Starting weapon id. */
  weapon?: string;
  /** Chosen abilities [F, C]. */
  abilities?: string[];
  /** Cosmetic weapon-skin id. */
  wepSkin?: string;
  /** Custom per-weapon palettes from the Locker: weaponId → [body,emissive,accent,metal,steel,glow]. */
  lockerSkins?: Record<string, number[]>;
  /** Cosmetic accessory id. */
  accessory?: string;
}

/** Join an existing room (or quick-play when roomId omitted). */
export interface C_Join extends PlayerPrefs {
  t: "join";
  name: string;
  roomId?: string;
}

/** Create a new room and join it. */
export interface C_Create extends PlayerPrefs {
  t: "create";
  name: string;
  config: RoomConfig;
}

/** Request the current list of rooms. */
export interface C_ListRooms {
  t: "rooms";
}

/** Sent at CLIENT_SEND_RATE: the player's locally-simulated state. */
export interface C_State {
  t: "state";
  pos: Vec3;
  yaw: number;
  pitch: number;
  /** Posture: 0 = standing, 1 = crouching, 2 = sliding. */
  posture?: number;
}

/** A trigger pull. The server re-runs each ray and applies damage. */
export interface C_Shoot {
  t: "shoot";
  /** Muzzle origin for server-side validation. */
  origin: Vec3;
  /** One normalized ray per pellet (1 for most guns, many for the shotgun). */
  dirs: Vec3[];
  /** Melee swing (short range, no bullet tracer on remotes). */
  melee?: boolean;
  /** Aiming down sights when this shot was fired (a sniper hit without it is a no-scope). */
  ads?: boolean;
  /** Off the ground when this shot was fired (for airborne-kill flair). */
  airborne?: boolean;
  /**
   * Server-clock time (ms) the client rendered the world it shot at. The server
   * rewinds targets to this instant (lag compensation) so hits land where the
   * shooter saw them, not where the target has since moved.
   */
  clientTime?: number;
}

export interface C_Respawn {
  t: "respawn";
}

/** The client fell into the void — the server registers a self-death. */
export interface C_Fell {
  t: "fell";
}

/** Switch the held weapon (server validates and uses it for damage). */
export interface C_SwitchWeapon {
  t: "weapon";
  weapon: string;
}

/** Choose the two abilities [F, C]. Applied by the server on the next respawn. */
export interface C_SetAbilities {
  t: "abilities";
  abilities: string[];
}

/** Latency reply: echoes the server's ping timestamp so it can measure RTT. */
export interface C_Pong {
  t: "pong";
  ts: number;
}

/** Use a server-side ability (cloak, confusion, grenades). */
export interface C_Ability {
  t: "ability";
  ability: string;
  origin?: Vec3;
  dir?: Vec3;
}

/** Cast or change a map vote during intermission. */
export interface C_VoteMap {
  t: "vote";
  mapId: string;
}

/** Hold or release the use key (E) for bomb planting / defusing. */
export interface C_Use {
  t: "use";
  held: boolean;
}

/** In-game text chat: broadcast to all players in the room. Not persisted. */
export interface C_Chat {
  t: "chat";
  text: string;
}

/** Admin-panel command. The server ignores it unless the actor has admin. */
export interface C_Admin {
  t: "admin";
  /**
   * One of: god | heal | give | slay | kick | tp | bring | bots | difficulty |
   * map | killbots | slayall | boom | announce.
   */
  cmd: string;
  /** Target player id (slay/kick/tp/bring/boom). */
  target?: number;
  /** String argument (weapon id, map id, difficulty, announce text). */
  value?: string;
  /** Numeric argument (e.g. bot count). */
  amount?: number;
}

export type ClientMessage =
  | C_Join
  | C_Create
  | C_ListRooms
  | C_State
  | C_Shoot
  | C_Respawn
  | C_Fell
  | C_SwitchWeapon
  | C_SetAbilities
  | C_Pong
  | C_Ability
  | C_VoteMap
  | C_Use
  | C_Admin
  | C_Chat;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface S_Welcome {
  t: "welcome";
  id: number;
  mapId: string;
  roomId: string;
  roomName: string;
  tickRate: number;
  snapshotRate: number;
  /** Server-clock timestamp (ms) when the current match ends. */
  matchEndsAt: number;
  /** Present when the room hosts a custom (non-built-in) map. */
  mapData?: GameMap;
  players: PlayerState[];
}

export interface S_RoomList {
  t: "roomlist";
  rooms: RoomInfo[];
}

export interface S_Snapshot {
  t: "snapshot";
  /** Server time (ms) the snapshot represents, for interpolation. */
  time: number;
  players: PlayerState[];
  /** Live grenades to render. */
  proj?: ProjectileState[];
  /** Live Mirage decoy holograms to render. */
  decoys?: DecoyState[];
}

export interface S_Join {
  t: "pjoin";
  player: PlayerState;
}

export interface S_Leave {
  t: "pleave";
  id: number;
}

/** Sent to a player when they take damage (for hit feedback / HUD). */
export interface S_Damage {
  t: "damage";
  health: number;
  /** Who dealt it. */
  from: number;
}

/** Broadcast when someone dies, drives the kill feed. */
export interface S_Kill {
  t: "kill";
  killer: number;
  victim: number;
  head: boolean;
  /** Players who damaged the victim recently (excluding the killer) — assists. */
  assists?: number[];
  /** Muzzle position of the lethal shot (for the victim's death-cam tracer). */
  from?: Vec3;
  /** Impact point of the lethal shot. */
  at?: Vec3;
  /** The killer's multikill count for this kill within the combo window (>=1). */
  multi?: number;
  /** Sniper kill landed without aiming down sights. */
  noscope?: boolean;
  /** Killer was airborne when the lethal shot landed. */
  airborne?: boolean;
  /** Environmental death (killer === victim): how they died. */
  cause?: "void" | "hazard";
}

/** Latency probe: the server asks the client to echo `ts` back in a C_Pong. */
export interface S_Ping {
  t: "ping";
  ts: number;
}

/** Broadcast a fired shot so other clients can render tracers / sound. */
export interface S_Shot {
  t: "shot";
  from: number;
  origin: Vec3;
  dirs: Vec3[];
  melee?: boolean;
  /** Weapon id, so others play the right sound. */
  weapon: string;
}

export interface S_Respawn {
  t: "respawned";
  id: number;
  pos: Vec3;
  health: number;
}

/** Confusion: the server forces this client to a new weapon. */
export interface S_ForceWeapon {
  t: "forceweapon";
  weapon: string;
}

/** A grenade detonated — clients spawn effects and may get blinded. */
export interface S_Explosion {
  t: "explosion";
  kind: "flash" | "frag" | "siphon";
  pos: Vec3;
}

/** 15-second intermission between rounds: shows winner, scores, and a map vote. */
export interface S_Intermission {
  t: "intermission";
  winnerName: string;
  /** Server-clock timestamp (ms) when intermission ends and the next match starts. */
  endsAt: number;
  /** Three maps players can vote for. */
  mapOptions: { id: string; name: string }[];
  /** Final scores snapshot so clients can show the scoreboard. */
  scores: PlayerState[];
}

/** Live vote-tally update broadcast whenever any player casts or changes their vote. */
export interface S_VoteUpdate {
  t: "voteupdate";
  /** mapId -> vote count for each option. */
  votes: Record<string, number>;
}

/** Sent after intermission to restart the match (possibly on a new map). */
export interface S_MatchRestart {
  t: "matchrestart";
  mapId: string;
  /** Server-clock timestamp (ms) when the new match ends. */
  matchEndsAt: number;
  /** Present when the new map is a custom (editor) map. */
  mapData?: GameMap;
  /** Fresh player list with reset scores and new spawn positions. */
  players: PlayerState[];
}

/** Bomb defusal: sent at the start of each round to assign teams and spawn positions. */
export interface S_BombRoundStart {
  t: "bombstart";
  teams: { id: number; team: "T" | "CT" }[];
  roundNum: number;
  scoreT: number;
  scoreCT: number;
  roundEndsAt: number;
  /** Full player list with updated spawn positions. */
  players: PlayerState[];
}

/** Bomb defusal: a significant bomb event (plant, defuse, explosion, etc.). */
export interface S_BombEvent {
  t: "bombevent";
  event: "planting" | "plant_cancel" | "planted" | "defusing" | "defuse_cancel" | "defused" | "exploded";
  pos?: Vec3;
  detonatesAt?: number;
  actorId?: number;
}

/** Bomb defusal: the round has ended. */
export interface S_BombRoundEnd {
  t: "bombroundend";
  winner: "T" | "CT";
  reason: "bomb_exploded" | "bomb_defused" | "t_eliminated" | "ct_eliminated" | "time";
  scoreT: number;
  scoreCT: number;
}

/** In-game chat message broadcast to all players in the room. */
export interface S_Chat {
  t: "chat";
  name: string;
  text: string;
}

/** Tells a client its admin privilege changed (un/locks the admin panel). */
export interface S_Admin {
  t: "admin";
  granted: boolean;
}

/** A transient on-screen message (admin announcements, admin-action feedback). */
export interface S_Toast {
  t: "toast";
  text: string;
  /** Visual style: a normal info toast or an admin/announce banner. */
  kind?: "info" | "admin";
}

/** Force the receiving client to teleport its local player (admin tp/bring). */
export interface S_Teleport {
  t: "teleport";
  pos: Vec3;
}

/** Push the receiving client's local player (Magnetar Pull / Bulwark Repulse). */
export interface S_Impulse {
  t: "impulse";
  vel: Vec3;
}

/** Slow the receiving client's local player for a while (Chronos Time Bubble). */
export interface S_Slow {
  t: "slow";
  /** Movement-speed multiplier (<1 slows). */
  mul: number;
  /** Duration in ms. */
  ms: number;
}

export type ServerMessage =
  | S_Welcome
  | S_RoomList
  | S_Snapshot
  | S_Join
  | S_Leave
  | S_Damage
  | S_Kill
  | S_Shot
  | S_Respawn
  | S_Intermission
  | S_VoteUpdate
  | S_MatchRestart
  | S_ForceWeapon
  | S_Explosion
  | S_BombRoundStart
  | S_BombEvent
  | S_BombRoundEnd
  | S_Admin
  | S_Toast
  | S_Teleport
  | S_Impulse
  | S_Slow
  | S_Ping
  | S_Chat;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T = ClientMessage | ServerMessage>(data: string): T {
  return JSON.parse(data) as T;
}
