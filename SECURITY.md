# Drunkr — anti-cheat & security audit

This documents the threat model, what the server **enforces today**, and the
**known gaps** with a prioritized path forward. The guiding principle: the
**server is authoritative for everything that affects the scoreboard**, and the
client is treated as hostile input.

## Threat model

Drunkr is a browser FPS. The client is fully attacker-controlled (anyone can
open dev-tools or craft WebSocket frames). The realistic threats:

1. **Damage/score forgery** — claiming kills or damage you didn't deal.
2. **Aim/trigger bots** — superhuman aim/fire (impossible to fully stop, but we
   can deny impossible geometry).
3. **Movement hacks** — speed/teleport/noclip.
4. **Wallhack / ESP** — seeing enemies through walls.
5. **Resource abuse** — message floods, malformed packets, oversized payloads.
6. **Injection** — names/strings breaking the UI of other clients.

## What is enforced server-side (implemented)

All in `server/src/index.ts`.

- **Authoritative combat.** Health, damage, deaths, respawns and kill counts
  live only on the server. Damage uses **the shooter's** weapon stats, looked
  up server-side (`weaponOf`), never values from the client.
- **Server re-runs every shot.** The client's "I hit X" is ignored. For each
  ray the server does its own ray-vs-capsule test (`rayHitsPlayer`) against
  authoritative positions and picks the victim itself.
- **Wall occlusion on hits.** A hit only lands if the segment from muzzle to
  victim is not blocked by geometry (`world.segmentBlocked`) — no shooting
  through walls even if a client claims a clear ray.
- **Muzzle-origin validation.** The shot origin must be within 3 m of the
  shooter's actual eye position, so you can't fire rays from across the map.
- **Fire-rate enforcement.** Each trigger pull is gated by the weapon's cycle
  time (`nextShot`), so rapid-fire scripts can't exceed a weapon's DPS. The
  shotgun's pellets are sent as **one** message (so the cap is per trigger, not
  per pellet), and pellet count is clamped to the weapon's real pellet count.
- **Weapon whitelist.** `weapon` switches are restricted to loadout weapons +
  the katana; bogus weapon ids are rejected.
- **Position sanitisation.** Incoming `state` is validated to be finite numbers,
  clamped to map bounds (+ a small margin) and a sane vertical range; pitch is
  clamped. Garbage/NaN/Infinity is dropped.
- **Loadout/skin validation.** Skin hue is clamped to 0..1; starting weapon must
  be a loadout weapon.
- **Flood protection.** Per-connection sliding-window message cap (~240/s, ~4×
  the legitimate steady rate); excess messages are dropped.
- **Malformed-packet hardening.** JSON parse is guarded; messages without a
  string `t` are ignored; vectors/arrays are type-checked before use.
- **Name sanitisation.** Names are stripped of markup characters and length-
  clamped server-side, and the client additionally HTML-escapes them on render
  (kill feed / scoreboard), so a crafted name can't inject markup.

## Known gaps (documented, not yet closed)

These are deliberate trade-offs for a fast-paced browser game; each has a path.

1. **Movement is client-predicted/authoritative.** We validate that positions
   are finite and in-bounds, but we don't fully re-simulate movement, so a
   determined cheater could still speed/teleport *within* the arena.
   → **Path:** server-side movement reconciliation — run `stepMovement` from the
   last accepted state against the client's inputs and reject deltas that exceed
   physically possible distance per tick (a "speed/teleport" delta check). The
   shared `stepMovement` already makes this feasible without code duplication.

2. **No server-side ammo/reload tracking.** Fire-rate cycle caps sustained DPS,
   but the magazine isn't tracked server-side, so a "no-reload" client could
   skip reload downtime.
   → **Path:** track ammo per actor server-side and reject shots with an empty
   mag; cheap to add on top of the existing `nextShot` gate.

3. **Wallhack / ESP.** Full snapshots (all player positions) are broadcast to
   every client, so a modified client can render enemies through walls.
   → **Path:** server-side interest management — only include a player in your
   snapshot if they're potentially visible (PVS / occlusion or distance cull).
   This also reduces bandwidth.

4. **Aimbot.** Geometry is validated, but the server can't tell a bot's aim from
   a pro's. → **Path:** statistical detection (flick/snap heuristics) and the
   ammo + movement checks above to limit damage; out of scope for a base.

5. **No identity / abuse controls.** No accounts, no auth, no IP rate-limiting
   beyond the per-connection flood cap; quick-tunnel sharing is for trusted QA.
   → **Path:** put the server behind a reverse proxy with connection rate limits
   for any public deployment; add lightweight tokens if persistence is added.

## Priorities if you take this public

1. Server-side **movement delta check** (kills speed/teleport — highest impact).
2. Server-side **ammo tracking** (kills no-reload).
3. **Interest-managed snapshots** (kills ESP, saves bandwidth).
4. Connection/IP **rate limiting** at the proxy.

Items 1–3 are all enabled by the existing shared-code architecture and the
authoritative combat already in place.
