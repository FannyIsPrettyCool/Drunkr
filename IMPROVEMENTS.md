# Drunkr — Codebase Audit & Improvement Plan

A grounded pass over the client (`client/src`), server (`server/src/index.ts`), and shared
protocol/sim (`shared/src`). Organized by category, then a prioritized roadmap. File references point
at the current code.

---

## 1. Security & abuse-resistance

The server is authoritative for damage/health/state, which is the right foundation. Gaps:

- **No WebSocket origin check / CORS.** `server/src/index.ts` accepts any WS connection (`ws.on`).
  Add an `Origin` allowlist (env-driven) so random pages can't drive your server.
- **Movement is client-authoritative.** `C_State` positions are trusted as-is (`case "state"`), so a
  modified client can teleport/speedhack. Mitigate with server-side speed/teleport sanity clamps
  (max delta per tick given `MOVE.speed`) and snap-back on violation. This is the single biggest
  integrity hole.
- **Shooting trusts client ray origin loosely.** `fireHitscan` only checks origin within ~3 units of
  the actor (`L574`) and rewinds by `clientTime`. Verify `clientTime` is bounded (reject far-past /
  future values) to cap lag-comp rewind abuse.
- **Flood protection is coarse.** One global 240 msg/s cap per connection (`L1998`). Add per-type
  caps (e.g. ability spam, weapon-switch spam, chat) and disconnect on sustained abuse.
- **Name / chat injection.** Chat is length-capped server-side (`L2150`) and the client escapes on
  render (`esc()` in `HUD.ts`/`main.ts`). Good — but **names are not sanitized** for control
  characters / zero-width / RTL-override. Strip non-printables in `makeState` (`L484`).
- **Admin via callsign env (`ADMIN_NAMES`).** Anyone who knows/guesses an admin callsign gets admin
  (`L1987`) — name is unauthenticated. Move to a shared-secret handshake (env token sent on join)
  rather than name matching.
- **No connection cap / per-IP limit.** A client can open many sockets. Add a per-IP connection cap
  and a max rooms-per-host limit.
- **Custom map upload** is validated (`validateMap`) — confirm it bounds box counts / coordinates to
  avoid a pathological map exhausting the nav grid (`new NavGrid`).

## 2. Correctness & robustness

- **No automated tests anywhere** (no test scripts in any `package.json`). The shared sim
  (`movement.ts`, `collision.ts`, hit detection) is pure and ideal for unit tests. Start here — it's
  the highest-value, lowest-friction win and guards the trickiest code.
- **No CI / typecheck gate.** Add a CI step running `tsc --noEmit` for all three packages + the
  tests above. (Note: `shared` must be built before a client production build — see below.)
- **`shared` build coupling.** Client production build fails unless `shared/dist` exists
  (`@drunkr/shared` `main` → `./dist/index.js`); the dev server uses the `development` export
  condition. Document this in the README or add a root `prebuild` that builds `shared` first.
- **Magic numbers scattered** through `Weapon.ts` viewmodel + tuning. Mostly fine, but movement/feel
  constants would be safer centralized in `shared/constants.ts` (some already are).

## 3. Performance

- **Single 643 kB JS bundle** (build warns >500 kB). Three.js dominates. Code-split the editor and
  lazy-load Three where possible; set `build.rollupOptions.output.manualChunks`.
- **Per-shot allocations.** `castRay`/`spawnTracer` allocate `Vector3`/`BufferGeometry`/materials per
  pellet+tracer (`Weapon.ts`). Pool tracer lines and reuse scratch vectors to cut GC churn during
  sustained fire.
- **`syncProjectiles`/`syncDecoys`** rebuild `Set`s and iterate maps each snapshot — fine now, but
  pool meshes if projectile counts grow.
- **Snapshot bandwidth.** Full `PlayerState` per snapshot. If player counts rise, add delta
  encoding / quantized positions.

## 4. Code quality & maintainability

- **`server/src/index.ts` is ~2200 lines** doing networking, rooms, sim, bots, bomb mode, admin, and
  HTTP. Split into modules (`net`, `room`, `combat`, `bots`, `bombMode`, `admin`). Biggest
  readability win on the server.
- **`Game.ts` is ~1400 lines** and growing (it now owns HUD wiring, abilities, bomb HUD, grapple
  line, settings mount). Extract ability handling and bomb-mode HUD into their own classes.
- **Duplicated class `<option>` lists** in `index.html` (lobby + pause menu, 14 entries each). Build
  them from `CLASSES` in shared so they never drift.
- **Duplicated skin-swatch + roster-render** logic between `main.ts` and `Game.ts`. Extract shared
  helpers.

## 5. Polish & UX

- **Keybind UX:** the rebind grid has no conflict detection — two actions can share a key. Warn or
  swap on conflict. Also surface mouse-button binds (fire/ADS) as read-only rows so the menu is
  complete.
- **Controls hint** at the bottom of the lobby is hardcoded ("WASD / SPACE / …") — it now lies if the
  player rebinds. Generate it from `settings.keymap`.
- **Settings parity:** sensitivity/audio/graphics now shared — good. Consider a "Reset to defaults"
  button per section.
- **Accessibility:** no colourblind-safe option for team/skin hues; killfeed relies on colour. Add a
  high-contrast / shape-coded option.
- **Mobile / small screens:** the new wider settings card relies on `vw`/`vh` caps + scroll. Verify
  on narrow viewports.

## 6. New features & creative ideas

### Game modes
- **Team Deathmatch / CTF** — the bomb-mode team plumbing (`bombTeams`, `S_BombRoundStart`) is
  reusable scaffolding for generic team modes.
- **Gun Game / Arms Race** — cycle the player's weapon up the loadout on each kill (you already have
  weapon-switch + kill events; mostly a server rule).
- **Infected / Juggernaut** — one buffed player vs the rest; reuse `Fortify`/overheal.
- **Race / Movement trials** — lean into the bhop/slide/grapple movement; checkpoint maps, ghost
  replays (you already record position history for Recall).
- **Wave survival (PvE)** against the existing bots with difficulty ramps.

### Cosmetics (high engagement, low gameplay risk)
- **Weapon skins.** Viewmodels are built procedurally in `Weapon.buildViewmodel` from a few
  materials — add a `skinId` that swaps the material palette (and optional emissive patterns) per
  weapon. Purely client-cosmetic, broadcast the id so others see it. Start with 4–5 palettes.
- **Character accessories.** Remote avatars are simple meshes (`RemotePlayers`) — add attachable
  cosmetic meshes (hats, trails, visors) keyed by a cosmetic id in `PlayerState`.
- **Kill effects / death dissolve variants** — you already do a hue-tinted death dissolve; make it a
  cosmetic slot.
- **Inspect animations** (just added) are a natural cosmetic hook — per-skin inspect flourishes.

### Progression / meta
- **Account-less profiles** in `localStorage` first (XP, unlock state), then optional server persist.
- **Match summary screen** with per-player accuracy/damage (server already tracks `damageLog`).

### Social / quality of life
- **Spectator mode** after death (free-cam over teammates) — the death-cam tracer shows the camera
  machinery exists.
- **Server browser filters** (mode, has-bots, ping).
- **Reconnect to last room** on accidental disconnect.

---

## Prioritized roadmap

**P0 — integrity & safety net (do first)**
1. Server-side movement sanity clamps (anti-teleport/speedhack).
2. WS origin allowlist + per-IP connection cap.
3. Name sanitization; admin via shared-secret instead of callsign.
4. Unit tests for `shared` sim + a CI `tsc` gate.

**P1 — structure & perf**
5. Split `server/src/index.ts` and `Game.ts` into modules.
6. Tracer/vector pooling in `Weapon.ts`; bundle code-splitting.
7. Generate class lists + controls hint from shared data.

**P2 — engagement** ✅ *shipped (except a new mode, deferred by request)*
8. ✅ Weapon skins — per-material colour editor in a **Locker** menu (visible to all via
   `PlayerState.wepPalette`); rotating weapon preview + mouse-follow character preview.
9. ⏸️ New mode — intentionally skipped for now.
10. ✅ Character accessories (some with particles); ✅ ping indicator (HUD + scoreboard);
   ✅ accuracy/headshot% on the end screen; ✅ multikill announcements + combo bar.

**P3 — depth**
11. Spectator mode, progression/unlocks, server browser filters, reconnect.
