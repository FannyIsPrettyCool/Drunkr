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
(`neon_yard` or `overdrive`, default `neon_yard`), `PORT` (default 2567).
e.g. `BOTS=6 MAP=overdrive npm run dev:server`.

### Controls

`WASD` move · `SPACE` jump (hold to auto-bhop) · `SHIFT`/`C` crouch-slide ·
`MOUSE` aim · `CLICK` fire (hold to auto) · `R` reload · `TAB` scoreboard ·
`ESC` release mouse (click to re-lock)

**Movement tech:** Quake/Source-style — air-strafe (hold a strafe key + turn
the mouse the same way mid-air) to gain speed past the ground cap, and hold
`SPACE` to bunny-hop on landing without losing momentum. Crouch removes ground
friction for slides. Tuning lives in `MOVE` in `shared/src/constants.ts`.

## Architecture notes

- **Movement** is client-predicted: each client simulates its own physics
  (gravity, jumping, accel/friction, AABB collision against the map boxes) and
  streams its state to the server at 30 Hz.
- **The server** is authoritative over health, damage, deaths and respawns. It
  re-runs each shot as a ray-vs-capsule test rather than trusting the client's
  claimed hit, and clamps positions to the arena bounds.
- **Other players** are rendered ~100 ms behind the latest snapshot and
  interpolated between snapshots for smooth motion (server broadcasts at 20 Hz).
- **Bots** are server-side actors sharing the exact same movement model
  (`shared/src/movement.ts`) as players — they wander, bunny-hop, acquire the
  nearest visible enemy (line-of-sight tested against geometry), aim with a
  reaction delay, and shoot. They kill and are killed like anyone else.
- **Maps** are lists of axis-aligned boxes (`shared/src/map.ts`) used for both
  rendering and collision — easy to author new arenas. Ships with *Neon Yard*
  and *Overdrive*.

## Project layout

```
shared/src/   protocol.ts · constants.ts · map.ts · math.ts
server/src/   index.ts  (rooms, tick loop, hit validation, respawns)
client/src/
  core/Game.ts          orchestration + main loop
  render/Renderer.ts    Three.js scene, pixelation, lighting, fog
  world/Arena.ts        builds map meshes + colliders
  physics/Collision.ts  AABB capsule collision
  entities/             LocalPlayer (FPS controller) · RemotePlayers (interp)
  weapons/Weapon.ts     hitscan, viewmodel, tracers, recoil
  input/Input.ts        pointer lock, keyboard/mouse
  net/Network.ts        websocket client
  ui/HUD.ts             crosshair, health, ammo, killfeed, scoreboard
```

## Roadmap ideas

- Server-authoritative movement + lag compensation (rewind on shot)
- Multiple weapons & weapon switching (the system already supports a weapon table)
- Team modes, round/scoring logic, map rotation/voting
- Smarter bot pathfinding (nav mesh) & difficulty tiers
- Sound, particles, more movement tech (slide, wall-jump)
- Rooms / matchmaking (server currently hosts one shared arena)
