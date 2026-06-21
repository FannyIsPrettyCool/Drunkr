# Particle system — plan

A design for a unified, pooled particle system for Drunkr and a roadmap of which
effects to add or improve. The goal is the same minimalistic neon-cyberpunk look,
cheap enough to run inside the low-res upscaled render buffer (see `Renderer`),
and driven from the events the game already emits.

## 1. Where we are today

Effects are currently ad-hoc, each building/disposing its own THREE objects:

- **Frag/flash/siphon explosion** — `Game.onExplosion()` spawns a single
  expanding translucent `SphereGeometry` that scales + fades over ~320 ms. Flash
  also drives the screen-blind via `HUD.blind()`. No sparks, smoke, debris, ring,
  or dynamic light.
- **Muzzle flash** — `Weapon.flash()`: one `PointLight` + a tiny sphere, decays.
- **Tracers** — `Weapon.spawnTracer()`: a `Line` that fades over 80 ms (local +
  remote shots).
- **Death-cam** — `Game.showDeathTracer()`: a static line + two markers.
- **Grenade in flight** — `Game.syncProjectiles()`: a plain emissive sphere, no trail.

Missing entirely: bullet impact sparks/dust (we only play a sound via
`onWallHit`), blood/hit sparks on players, footstep dust, jump-pad burst,
dash/blink/slide trails, shell casings, spawn/respawn & teleport effects,
shockwave/siphon ground rings, kill spark.

Everything allocates geometry/material per effect and disposes per effect — fine
at low volume, but it will GC-thrash once we add impacts on every bullet.

## 2. Proposed system

A single pooled CPU-simulated, GPU-drawn particle system. One class,
`client/src/render/Particles.ts`, owned by `Game` and ticked each frame in
`loop()` (it already has `dt`). It is map-agnostic and survives map restarts
(just `clear()` live particles when the arena rebuilds).

### Representation

- One `THREE.Points` per **blend/texture group** (e.g. `additive-spark`,
  `additive-glow`, `alpha-smoke`), each backed by preallocated typed arrays
  (`position`, `color`, `size`, plus a parallel CPU array for velocity / life /
  gravity / drag). A `ShaderMaterial` (or `PointsMaterial` with `sizeAttenuation`)
  renders them as additive or alpha sprites.
- Fixed capacity per group (e.g. 2000 additive, 1000 alpha). Allocation is a
  ring buffer / free-list — no per-particle GC. Dead particles have size 0 and
  are skipped; `geometry.setDrawRange` + a `needsUpdate` on the changed
  attributes keeps uploads minimal.
- For **ribbons/trails** (dash, blink, grenade) a small separate path: a pooled
  set of short `Line`/`MeshLine` segments, or just emit spark particles along the
  motion path each tick (simplest; reuse the Points system).

### API (event-driven, matches existing call sites)

```ts
particles.burst(kind, position, opts?)   // one-shot emitter preset
particles.beam(from, to, kind)           // tracer/impact-trail
particles.attach(id, kind)               // follow a remote/local entity (trails)
particles.update(dt)                     // simulate + upload once per frame
particles.clear()                        // on map restart
```

`kind` selects a **preset** (count, speed cone, color ramp, size ramp, lifetime,
gravity, drag, blend). Presets live in one table so tuning is centralized and the
cyberpunk palette (pinks/cyans/ambers from `map.ts`) stays consistent.

### Simulation

Per particle: `pos += vel*dt; vel += gravity*dt; vel *= (1 - drag*dt)`; `life -=
dt`; size & color lerp along their ramps by `1 - life/maxLife`. Optional cheap
floor collision (clamp `y >= 0`, reflect with restitution) for debris/casings —
the full `CollisionWorld` is overkill for cosmetics.

### Performance & quality

- Tie max particle counts and "fancy" emitters to `settings.quality`
  (low/medium/high) — low can halve counts and skip smoke/debris.
- Additive sprites, `depthWrite: false`, soft circular texture (generated on a
  canvas, like the nametag) so there are no asset downloads.
- Hard cap + oldest-particle recycling guarantees a frame budget regardless of
  how many explosions happen at once.

## 3. Effect catalogue

### Improve existing

- **Frag explosion** (`onExplosion("frag")`): replace the lone sphere with a
  layered burst — (a) a bright additive core flash + short `PointLight` pulse,
  (b) an expanding **shockwave ring** (a flat ring quad scaling out, fading),
  (c) 30–50 ember **sparks** (additive, gravity, drag, orange→red ramp),
  (d) a few **smoke** puffs (alpha, slow rise, dark→transparent),
  (e) optional **debris** bits with floor bounce, (f) camera shake scaled by
  distance (add a small `Renderer`/camera kick). Tie blind/▌screen-flash only to
  flash kind.
- **Flash explosion**: bright expanding additive ring + a lingering glow sprite
  for ~1 s, in addition to the existing `HUD.blind()`. Add a subtle white core.
- **Siphon/shockwave AoE**: a colored **ground ring** that expands to the ability
  radius (`SIPHON.radius` / `SHOCKWAVE.radius`) so the area is readable, plus
  inward-drawn spark "drain" lines for siphon.
- **Muzzle flash**: add 3–5 tiny forward-cone sparks + a quick smoke wisp at the
  muzzle (`Weapon.muzzleWorld()`); keep the existing light.
- **Tracers**: spawn a couple of dim sparks at the muzzle on fire and a
  brief flash sprite at the impact point.
- **Grenade in flight** (`syncProjectiles`): emit a faint colored trail each tick
  from the projectile position (frag=pink, flash=white).

### Add (missing)

| Effect | Trigger / hook | Notes |
| --- | --- | --- |
| Bullet impact (wall) | `Weapon.castRay` already returns `wallPoint` → `onWallHit` | sparks + dust puff + tiny scorch; color from surface |
| Bullet impact (flesh) | local hit (`onHit`) and remote `S_Kill`/damage | short red/neon spark spray at hit point |
| Footstep dust | `Game.loop()` footstep timer (already there) | tiny ground puff under the player when grounded |
| Jump-pad burst | `mv.padLaunched` (already surfaced) | upward cone of sparks at pad |
| Dash / blink trail | `useAbility("dash"/"blink")` | streak of fading sprites along travel |
| Slide sparks | `LocalPlayer.sliding` while grounded | sparks off the heels |
| Shell casings | `Weapon.fire()` for non-melee | small debris with floor bounce + clink (sfx exists pattern) |
| Spawn / respawn | `respawned` / `matchrestart` | quick implosion-then-pop at spawn |
| Teleport (admin tp/bring, phantom blink) | `S_Teleport`, blink | dissipate at origin + reform at destination |
| Death dissolve | `S_Kill` victim | burst of the victim's hue particles where the avatar was |
| Kill confirm | local kill (`sfx.kill()` path) | small spark at crosshair / hit marker pop |
| Ambient | map-driven | optional floating neon motes near emissive boxes for atmosphere (low density) |

Remote effects (other players' impacts, deaths, abilities) are driven from the
broadcast messages already handled in `Game.onMessage` (`S_Shot`, `S_Kill`,
`S_Explosion`), so they need no new protocol.

## 4. Rollout

1. **Foundation** — build `Particles.ts` (pooled Points + preset table + soft
   sprite texture), own it in `Game`, tick in `loop()`, `clear()` on restart.
2. **Combat readability** — bullet wall/flesh impacts + improved muzzle flash +
   tracer polish (highest gameplay value, exercises the pool hardest).
3. **Explosions** — rework frag/flash/siphon/shockwave into layered bursts +
   rings + camera shake.
4. **Movement & life-cycle** — footsteps, pad burst, dash/blink/slide trails,
   shell casings, spawn/teleport/death.
5. **Polish & perf** — quality-tier scaling, ambient motes, final tuning pass and
   a particle-count cap check on a crowded fight.

No new dependencies, no art assets (textures generated procedurally), no protocol
changes — every effect hangs off an event the client already receives.
