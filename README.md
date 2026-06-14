# DRUNKR

A minimalistic **cyberpunk browser multiplayer FPS** — fast-paced gunplay in
neon arenas. Think krunker.io / Pixel Gun, with a pixelated cyberpunk skin.

> Status: **playable base** — movement, shooting, hit detection, multiplayer
> snapshots, kill feed, scoreboard and respawns are all working.

## Stack

| Part | Tech |
|------|------|
| Rendering | [Three.js](https://threejs.org) (WebGL), low-res buffer upscaled with `image-rendering: pixelated` |
| Client | TypeScript + [Vite](https://vitejs.dev) |
| Server | Node.js + [`ws`](https://github.com/websockets/ws), authoritative snapshots |
| Shared | A `@drunkr/shared` workspace holds the network protocol, tuning constants and map data so client & server can't drift |

Monorepo via npm workspaces: `shared/`, `server/`, `client/`.

## Run it

```bash
npm install      # once
npm run dev      # starts the game server (ws://localhost:2567) + Vite (http://localhost:5173)
```

Open http://localhost:5173 in two tabs/devices to play against yourself.
The client auto-discovers the server on the same host, port 2567
(override with `?server=ws://host:port`).

**Server env vars:** `BOTS` (number of AI bots, default 4), `MAP`
(`neon_yard`, `overdrive`, or `blacksite`, default `neon_yard`), `PORT`
(default 2567). e.g. `BOTS=6 MAP=blacksite npm run dev:server`.

### Controls

`WASD` move · `SPACE` jump (hold to auto-bhop) · `SHIFT`/`C` crouch-slide ·
`F` dash · `MOUSE` aim · `LMB` fire · `RMB` aim-down-sights (scope) ·
`1` AK · `2` sniper · `3` shotgun · `Q` katana · `R` reload ·
`TAB` scoreboard · `ESC` release mouse (click to re-lock)

**Movement tech:**
- **Air-strafe** (strafe key + matching mouse turn) to exceed the ground cap.
- **Bunny-hop** — hold `SPACE` to keep momentum on landing.
- **Slide** — crouch while running fast: a speed boost + low friction; jump out
  of it to carry the momentum (slide-jump).
- **Dash** (`F`) — a burst in your move direction, 4 s cooldown.
- **Rocket-jump** — fire the shotgun at your feet; the recoil launches you.
- **Katana** (`Q`) — while equipped you move 35 % faster and get a double jump.

Tuning lives in `MOVE` / `SLIDE` / `DASH` in `shared/src/constants.ts`.

### Weapons

| Slot | Weapon  | Style                                                    |
| ---- | ------- | -------------------------------------------------------- |
| `1`  | AK-44   | full-auto assault rifle                                  |
| `2`  | LVR-50  | lever-action **scoped sniper**, one-shot, ADS with `RMB` |
| `3`  | DB-12   | double-barrel **shotgun**, 9 pellets, self-knockback     |
| `Q`  | NEON-EDGE | **melee katana** — one-shot, +speed, double jump       |

Each weapon keeps its own ammo when you switch. Bots roll a random loadout.

### Modes & cosmetics

- **FFA kill-limit** match (first to 30) — scores reset and play continues.
- **Skins** + **starting loadout** picked in the lobby.
- **Server browser** — create rooms (map, bots on/off, count, difficulty) or
  quick-play into the most populated one.

## Architecture notes

- **Movement** is client-predicted: each client simulates its own physics
  (gravity, jumping, accel/friction, AABB collision against the map boxes) and
  streams its state to the server at 30 Hz.
- **The server** is authoritative over health, damage, deaths, respawns and
  scores. It re-runs each shot (ray-vs-capsule, per shooter's weapon), checks
  wall occlusion and muzzle position, enforces fire-rate, and validates/clamps
  all input. See [SECURITY.md](SECURITY.md) for the full anti-cheat audit.
- **Other players** are rendered ~100 ms behind the latest snapshot and
  interpolated for smooth motion (server broadcasts at 20 Hz). Avatars have a
  procedural walk cycle and the held weapon model; nametags are wall-occluded.
- **Audio** is fully procedural (Web Audio synth, `client/src/audio/Sfx.ts`) —
  no asset files, no licensing.
- **Bots** are server-side actors sharing the exact same movement model
  (`shared/src/movement.ts`) as players — they wander, bunny-hop, acquire the
  nearest visible enemy (line-of-sight tested against geometry), aim with a
  difficulty-tuned reaction delay, and shoot their (random) loadout.
- **Maps** are lists of axis-aligned boxes (`shared/src/map.ts`) used for both
  rendering and collision. Ships with *Neon Yard* (large), *Overdrive* (bases),
  and *Blacksite* (indoor maze).

## Sharing with a tester

See [SHARING.md](SHARING.md) for a zero-config way to let a QA tester on another
PC play on your local server via a Cloudflare quick tunnel.

## Project layout

```
shared/src/   protocol · constants · map · math · collision · movement
server/src/   index.ts  (rooms, bot AI, hit validation, anti-cheat, modes)
client/src/
  core/Game.ts          orchestration + main loop
  render/Renderer.ts    Three.js scene, pixelation, lighting, fog
  world/Arena.ts        builds map meshes + colliders
  entities/             LocalPlayer (FPS controller) · RemotePlayers (animated)
  weapons/Weapon.ts     weapons, scope, recoil, knockback, tracers
  audio/Sfx.ts          procedural Web Audio sound
  input/Input.ts        pointer lock, keyboard/mouse
  net/Network.ts        websocket client
  ui/HUD.ts             crosshair, ammo, killfeed, scoreboard, scope, banner
```

## Roadmap ideas

- Server-authoritative movement + lag compensation (rewind on shot)
- Multiple weapons & weapon switching (the system already supports a weapon table)
- Team modes, round/scoring logic, map rotation/voting
- Smarter bot pathfinding (nav mesh) & difficulty tiers
- Sound, particles, more movement tech (slide, wall-jump)
- Rooms / matchmaking (server currently hosts one shared arena)
