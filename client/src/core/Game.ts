import * as THREE from "three";
import {
  CLIENT_SEND_RATE,
  MAPS,
  PLAYER,
  WEAPONS,
  CLASSES,
  ABILITIES,
  DEFAULT_CLASS,
  INVIS,
  UPDRAFT,
  GRENADE,
  BLINK,
  SHOCKWAVE,
  type AbilityId,
  type PlayerState,
  type S_Welcome,
  type ServerMessage,
} from "@drunkr/shared";
import { Renderer } from "../render/Renderer.js";
import { Arena } from "../world/Arena.js";
import { LocalPlayer } from "../entities/LocalPlayer.js";
import { RemotePlayers } from "../entities/RemotePlayers.js";
import { Weapon } from "../weapons/Weapon.js";
import { Input } from "../input/Input.js";
import { HUD } from "../ui/HUD.js";
import { Sfx } from "../audio/Sfx.js";
import { settings, QUALITY_HEIGHT } from "./Settings.js";
import type { Network } from "../net/Network.js";

export class Game {
  private renderer: Renderer;
  private arena: Arena;
  private local: LocalPlayer;
  private remotes: RemotePlayers;
  private weapon: Weapon;
  private input: Input;
  private hud: HUD;
  private sfx = new Sfx();

  private localId: number;
  private roster = new Map<number, PlayerState>();
  private lastFrame = performance.now();
  private sendAccum = 0;
  private running = false;
  /** Server-clock offset (serverNow ≈ Date.now() + offset) and match deadline. */
  private clockOffset = 0;
  private matchEndsAt: number;
  private fps = 60;
  private localCls = DEFAULT_CLASS;
  /** Client-side ability cooldown end times (performance.now ms). */
  private abilityCd: Record<string, number> = {};
  /** Live grenade meshes by projectile id. */
  private projMeshes = new Map<number, THREE.Mesh>();
  private losRay = new THREE.Raycaster();

  constructor(
    canvas: HTMLCanvasElement,
    private net: Network,
    welcome: S_Welcome,
  ) {
    this.localId = welcome.id;
    this.matchEndsAt = welcome.matchEndsAt;
    const map = MAPS[welcome.mapId];

    this.renderer = new Renderer(canvas);
    this.arena = new Arena(map);
    this.renderer.scene.add(this.arena.group);

    this.remotes = new RemotePlayers(this.renderer.scene, () => this.localId);
    this.local = new LocalPlayer(this.renderer.camera, this.arena.collision);
    this.renderer.scene.add(this.renderer.camera);

    this.hud = new HUD();
    this.input = new Input(canvas);

    this.weapon = new Weapon(
      this.renderer.camera,
      this.renderer.scene,
      this.arena.colliders,
      this.remotes,
      this.net,
      this.local,
      {
        onAmmo: (cur, max) => this.hud.setAmmo(cur, max),
        onHit: (head) => this.hud.hitmark(head),
        onReloadState: (active, progress) => {
          this.hud.setReload(active, progress);
          if (active && progress < 0.05) this.sfx.reload();
        },
        onWeapon: (name) => this.hud.setWeapon(name),
        onScope: (active) => this.hud.setScope(active),
        onShoot: (id) => this.sfx.shoot(id),
      },
    );

    this.input.onReload = () => this.weapon.reload();
    this.input.onSwitch = (id) => this.switchWeapon(id);
    this.input.onAbility = (slot) => this.useAbility(slot);
    this.input.onLockChange = (locked) => {
      if (locked) this.sfx.resume();
    };

    // Seed roster and spawn from the welcome payload.
    for (const p of welcome.players) {
      this.roster.set(p.id, p);
      if (p.id === this.localId) {
        this.local.spawn(p.pos.x, p.pos.y, p.pos.z);
        this.localCls = p.cls ?? DEFAULT_CLASS;
        // Match the loadout the server assigned us (no need to re-send it).
        this.weapon.switchTo(p.weapon);
        this.applyWeaponMods(p.weapon);
      } else {
        this.remotes.add(p);
      }
    }

    this.net.on((msg) => this.onMessage(msg));

    // Dev-only debug handle for inspecting/poking the running game.
    if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = this;
  }

  start() {
    this.hud.show();
    this.running = true;
    this.renderer.setPixelHeight(QUALITY_HEIGHT[settings.quality]);
    this.input.requestLock();
    requestAnimationFrame(() => this.loop());
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case "snapshot": {
        // Track the server clock for the match timer.
        const sample = msg.time - Date.now();
        this.clockOffset = this.clockOffset === 0 ? sample : this.clockOffset * 0.9 + sample * 0.1;
        this.remotes.onSnapshot(msg.players, msg.time);
        for (const p of msg.players) {
          this.roster.set(p.id, p);
          if (p.id === this.localId) this.syncLocal(p);
        }
        this.syncProjectiles(msg.proj ?? []);
        break;
      }
      case "pjoin":
        this.roster.set(msg.player.id, msg.player);
        this.remotes.add(msg.player);
        break;
      case "pleave":
        this.roster.delete(msg.id);
        this.remotes.remove(msg.id);
        break;
      case "damage":
        this.hud.setHealth(msg.health);
        this.hud.flashDamage();
        break;
      case "kill": {
        const killer = this.roster.get(msg.killer)?.name ?? "?";
        const victim = this.roster.get(msg.victim)?.name ?? "?";
        this.hud.addKill(killer, victim, msg.head);
        if (msg.killer === this.localId) this.sfx.kill();
        if (msg.victim === this.localId) {
          this.local.dead = true;
          this.hud.setDead(true);
          this.sfx.death();
        }
        break;
      }
      case "shot": {
        const o = new THREE.Vector3(msg.origin.x, msg.origin.y, msg.origin.z);
        if (!msg.melee) {
          for (const dir of msg.dirs) {
            this.weapon.remoteShot(o, new THREE.Vector3(dir.x, dir.y, dir.z));
          }
        }
        // Positional-ish volume by distance to the shooter.
        const sp = this.remotes.position(msg.from);
        const dist = sp ? sp.distanceTo(this.local.pos) : 999;
        if (dist < 60) this.sfx.remoteShoot(msg.weapon);
        break;
      }
      case "forceweapon":
        // Illusionist confusion swapped our weapon out from under us.
        if (this.weapon.switchTo(msg.weapon)) {
          this.applyWeaponMods(msg.weapon);
          const me = this.roster.get(this.localId);
          if (me) me.weapon = msg.weapon;
          this.hud.banner("WEAPON SCRAMBLED");
        }
        break;
      case "explosion":
        this.onExplosion(msg.kind, new THREE.Vector3(msg.pos.x, msg.pos.y, msg.pos.z));
        break;
      case "matchend":
        this.matchEndsAt = msg.endsAt;
        this.hud.showIntermission(msg.name);
        break;
      case "respawned":
        if (msg.id === this.localId) {
          this.local.spawn(msg.pos.x, msg.pos.y, msg.pos.z);
          this.local.dead = false;
          this.hud.setDead(false);
          this.hud.setHealth(msg.health);
          this.weapon.resetAmmo(); // respawn with fresh mags
        }
        break;
    }
  }

  private switchWeapon(id: string) {
    if (this.local.dead) return;
    if (this.weapon.switchTo(id)) {
      this.net.send({ t: "weapon", weapon: id });
      const me = this.roster.get(this.localId);
      if (me) me.weapon = id;
      this.applyWeaponMods(id);
      this.sfx.switchWeapon();
    }
  }

  /** Movement modifiers granted by the equipped weapon (katana = fast + double-jump). */
  private applyWeaponMods(id: string) {
    const def = WEAPONS[id];
    this.local.speedMul = def?.speedMul ?? 1;
    this.local.maxJumps = def?.doubleJump ? 2 : 1;
  }

  private eyePos() {
    const v = new THREE.Vector3();
    this.renderer.camera.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  }

  private aimRay() {
    const o = new THREE.Vector3();
    this.renderer.camera.getWorldPosition(o);
    const d = new THREE.Vector3();
    this.renderer.camera.getWorldDirection(d);
    return { o: { x: o.x, y: o.y, z: o.z }, d: { x: d.x, y: d.y, z: d.z } };
  }

  /** Fire the F or C ability of the local player's class. */
  private useAbility(slot: "F" | "C") {
    if (this.local.dead) return;
    const cls = CLASSES[this.localCls] ?? CLASSES[DEFAULT_CLASS];
    const id = (slot === "F" ? cls.F : cls.C) as AbilityId;
    const def = ABILITIES[id];
    const now = performance.now();
    if (now < (this.abilityCd[id] ?? 0)) return;

    let used = true;
    switch (id) {
      case "dash":
        used = this.local.tryDash();
        if (used) this.sfx.dash();
        break;
      case "updraft":
        this.local.applyImpulse(0, UPDRAFT.vy, 0);
        this.sfx.dash();
        break;
      case "invis":
        this.net.send({ t: "ability", ability: "invis" });
        this.startInvis();
        break;
      case "confusion":
        this.net.send({ t: "ability", ability: "confusion", origin: this.eyePos() });
        this.sfx.switchWeapon();
        break;
      case "flash":
      case "frag": {
        const { o, d } = this.aimRay();
        this.net.send({ t: "ability", ability: id, origin: o, dir: d });
        this.sfx.dash();
        break;
      }
      case "blink":
        this.local.blink(BLINK.dist);
        this.sfx.dash();
        break;
      case "fortify":
        this.net.send({ t: "ability", ability: "fortify" });
        this.sfx.reload();
        break;
      case "shockwave":
        this.net.send({ t: "ability", ability: "shockwave" });
        this.local.applyImpulse(0, SHOCKWAVE.selfVy, 0); // small self-leap
        this.sfx.boom();
        break;
    }
    if (used) this.abilityCd[id] = now + def.cooldownMs;
  }

  private startInvis() {
    const base = WEAPONS[this.weapon.def.id]?.speedMul ?? 1;
    this.local.speedMul = base * INVIS.speedMul;
    setTimeout(() => this.applyWeaponMods(this.weapon.def.id), INVIS.durationMs);
  }

  /** Reconcile rendered grenade meshes with the snapshot's projectile list. */
  private syncProjectiles(proj: { id: number; kind: "flash" | "frag"; pos: { x: number; y: number; z: number } }[]) {
    const seen = new Set<number>();
    for (const p of proj) {
      seen.add(p.id);
      let mesh = this.projMeshes.get(p.id);
      if (!mesh) {
        const color = p.kind === "frag" ? 0xff2d9b : 0xffffff;
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.22, 8, 8),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.3 }),
        );
        this.renderer.scene.add(mesh);
        this.projMeshes.set(p.id, mesh);
      }
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    }
    for (const [id, mesh] of this.projMeshes) {
      if (!seen.has(id)) {
        this.renderer.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.projMeshes.delete(id);
      }
    }
  }

  private onExplosion(kind: "flash" | "frag", pos: THREE.Vector3) {
    this.sfx.boom();
    const color = kind === "frag" ? 0xff7a3d : 0xffffff;
    const radius = kind === "frag" ? GRENADE.fragRadius : 5;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 14), mat);
    mesh.position.copy(pos);
    this.renderer.scene.add(mesh);
    const start = performance.now();
    const fade = () => {
      const t = (performance.now() - start) / 320;
      if (t >= 1) {
        this.renderer.scene.remove(mesh);
        mesh.geometry.dispose();
        mat.dispose();
        return;
      }
      mat.opacity = 0.85 * (1 - t);
      mesh.scale.setScalar(1 + t * 0.6);
      requestAnimationFrame(fade);
    };
    fade();

    // Flash blinds you if you're close, looking at it, and have line of sight.
    if (kind === "flash" && !this.local.dead) {
      const cam = new THREE.Vector3();
      this.renderer.camera.getWorldPosition(cam);
      const dist = cam.distanceTo(pos);
      if (dist < GRENADE.flashRadius) {
        const look = new THREE.Vector3();
        this.renderer.camera.getWorldDirection(look);
        const toFlash = pos.clone().sub(cam).normalize();
        const facing = look.dot(toFlash);
        if (facing > 0.1 && !this.losBlocked(cam, pos)) {
          // 2–3s depending on how directly you were looking at it.
          this.hud.blind(GRENADE.flashBlindMs * (0.7 + 0.3 * facing));
        }
      }
    }
  }

  private updateAbilityHud() {
    const cls = CLASSES[this.localCls] ?? CLASSES[DEFAULT_CLASS];
    const now = performance.now();
    for (const slot of ["F", "C"] as const) {
      const id = slot === "F" ? cls.F : cls.C;
      const def = ABILITIES[id];
      const remain = Math.max(0, (this.abilityCd[id] ?? 0) - now);
      this.hud.setAbility(slot, def.name, remain <= 0, Math.ceil(remain / 1000));
    }
  }

  private losBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dir = b.clone().sub(a);
    const dist = dir.length();
    this.losRay.set(a, dir.normalize());
    this.losRay.far = dist - 0.5;
    return this.losRay.intersectObjects(this.arena.colliders, false).length > 0;
  }

  /** Apply server-authoritative fields to the local player. */
  private syncLocal(p: PlayerState) {
    const wasDead = this.local.dead;
    this.local.dead = p.dead;
    if (!p.dead && wasDead) this.hud.setDead(false);
    if (p.dead && !wasDead) this.hud.setDead(true);
    this.hud.setHealth(p.health);
  }

  private loop() {
    if (!this.running) return;
    const now = performance.now();

    // Optional frame cap (vsync/refresh-rate stand-in).
    const cap = settings.fpsCap;
    if (cap > 0 && now - this.lastFrame < 1000 / cap - 0.3) {
      requestAnimationFrame(() => this.loop());
      return;
    }

    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    dt = Math.min(dt, 0.05); // clamp to avoid tunneling on hitches

    this.fps = this.fps * 0.9 + (1 / Math.max(dt, 0.001)) * 0.1;
    this.hud.setFps(settings.showFps ? Math.round(this.fps) : null);

    // Look — sensitivity from settings, reduced while scoped.
    this.local.sensMul = settings.sensitivity * (this.weapon.scoped ? settings.scopedSens : 1);
    if (this.input.locked) {
      const m = this.input.consumeMouse();
      this.local.look(m.dx, m.dy);
    }

    const mv = this.local.update(this.input, dt);
    if (mv.jumped) this.sfx.jump();
    if (mv.landed) this.sfx.land();
    if (mv.slideStarted) this.sfx.slide();
    this.weapon.update(dt, this.input.firing && this.input.locked, this.input.ads);
    this.remotes.update(dt);
    this.updateAbilityHud();

    // Send local state to the server at a fixed rate.
    this.sendAccum += dt;
    const interval = 1 / CLIENT_SEND_RATE;
    if (this.sendAccum >= interval && this.net.connected && !this.local.dead) {
      this.sendAccum = 0;
      this.net.send({
        t: "state",
        pos: { x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z },
        yaw: this.local.yaw,
        pitch: this.local.pitch,
      });
    }

    this.hud.toggleScoreboard(
      this.input.showScores,
      [...this.roster.values()],
      this.localId,
    );

    const remainingMs = this.matchEndsAt - (Date.now() + this.clockOffset);
    this.hud.setTimer(remainingMs);

    this.renderer.render();
    requestAnimationFrame(() => this.loop());
  }
}

// Re-export for callers that want the constant without importing shared directly.
export { PLAYER };
