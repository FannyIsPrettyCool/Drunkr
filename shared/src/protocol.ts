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
  /** Kills / deaths for the scoreboard. */
  kills: number;
  deaths: number;
  dead: boolean;
  /** Currently-held weapon id (see WEAPONS). */
  weapon: string;
  /** Class id (see CLASSES). */
  cls: string;
  /** Invisible (Illusionist cloak) — remote clients hide the avatar. */
  invis: boolean;
}

/** A live grenade, sent in snapshots so clients can render it. */
export interface ProjectileState {
  id: number;
  kind: "flash" | "frag";
  pos: Vec3;
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
  difficulty: BotDifficulty;
  /** An editor-exported map to host instead of a built-in (validated server-side). */
  customMap?: GameMap;
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
  /** Class id. */
  cls?: string;
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

/** Use a server-side ability (cloak, confusion, grenades). */
export interface C_Ability {
  t: "ability";
  ability: string;
  origin?: Vec3;
  dir?: Vec3;
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
  | C_Ability;

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
  kind: "flash" | "frag";
  pos: Vec3;
}

/** The match timer expired; highest kills wins, scores reset, next round starts. */
export interface S_MatchEnd {
  t: "matchend";
  winner: number;
  name: string;
  /** Server-clock timestamp (ms) when the next match ends. */
  endsAt: number;
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
  | S_MatchEnd
  | S_ForceWeapon
  | S_Explosion;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T = ClientMessage | ServerMessage>(data: string): T {
  return JSON.parse(data) as T;
}
