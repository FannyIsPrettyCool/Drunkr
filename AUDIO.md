# Drunkr — Audio Asset Audit

How sound is wired: `client/src/audio/Sfx.ts` preloads every `.wav` from `client/public/assets/`
and exposes one method per game event. Several events currently **share** a buffer with another
event (a "duplicate") because the ability shipped without its own asset. They still play a sound,
but two different actions sound identical, which hurts readability in a fight.

This file lists every duplicate and the new asset each one needs. Dropping a new `.wav` into
`client/public/assets/` and pointing the method at it is all that's required — `Sfx` auto-loads
any file added to the `files[]` list in its constructor.

## ✅ Resolved — own asset added + wired in `Sfx`
These shipped their own `.wav` in `shared/assets/` and `Sfx` now points each at it
(`grapple`, `wallkick`, `slipstream`, `recall`, `timebubble`, `pull`, `reflect`, `repulse`,
`decoy`, `bloodlust`, `siphon` — including Siphon's world `drainAt` pulse). No longer duplicates.

## Still borrowing (needs a new asset)

### Bomb mode
| Event | New asset | Currently borrows | Suggested character |
|---|---|---|---|
| Defuse complete (`bombDefused`) | `bomb_defuse.wav` | `blink.wav` | wire-snip + confirm tone |
| Defusing tick (`bombDefusing`) | `bomb_defusing.wav` | `menu_click.wav` | ratchet/screwdriver click |

### Minor shared buffers (works, but distinct would be nicer — optional)
| Event | Optional asset | Currently borrows |
|---|---|---|
| Crouch-slide (`slide`) | `slide.wav` | `land_slide.wav` (pitched down) |
| Weapon switch (`switchWeapon`) | `switch_weapon.wav` | `menu_click.wav` (UI click) |

## Already fixed in code (no new asset needed)
- **Flash-grenade detonation** now plays `flash.wav` spatially (`flashBoomAt`) instead of borrowing
  the frag explosion buffer.
- **Decoy burst** now plays `flash.wav` + `frag_grenade.wav` together (`decoyBurstAt`). A dedicated
  `decoy_burst.wav` is optional polish.
- **Explosions are louder and carry farther** — frag/flash/decoy use a wide panner falloff
  (`BOOM_PAN`: refDistance 10, maxDistance 240, rolloff 0.9) at higher gain.

## Net new assets still to produce
2 bomb (`bomb_defuse.wav`, `bomb_defusing.wav`) = **2 required**, plus 3 optional polish
(`slide.wav`, `switch_weapon.wav`, `decoy_burst.wav`).
