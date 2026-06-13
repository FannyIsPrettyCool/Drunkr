import * as THREE from "three";
import {
  CLIENT_SEND_RATE,
  MAPS,
  PLAYER,
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
import type { Network } from "../net/Network.js";

export class Game {
  private renderer: Renderer;
  private arena: Arena;
  private local: LocalPlayer;
  private remotes: RemotePlayers;
  private weapon: Weapon;
  private input: Input;
  private hud: HUD;

  private localId: number;
  private roster = new Map<number, PlayerState>();
  private lastFrame = performance.now();
  private sendAccum = 0;
  private running = false;

  constructor(
    canvas: HTMLCanvasElement,
    private net: Network,
    welcome: S_Welcome,
  ) {
    this.localId = welcome.id;
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
        onReloadState: (active, progress) => this.hud.setReload(active, progress),
        onWeapon: (name) => this.hud.setWeapon(name),
        onScope: (active) => this.hud.setScope(active),
      },
    );

    this.input.onReload = () => this.weapon.reload();
    this.input.onSwitch = (id) => this.switchWeapon(id);

    // Seed roster and spawn from the welcome payload.
    for (const p of welcome.players) {
      this.roster.set(p.id, p);
      if (p.id === this.localId) {
        this.local.spawn(p.pos.x, p.pos.y, p.pos.z);
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
    this.input.requestLock();
    requestAnimationFrame(() => this.loop());
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case "snapshot": {
        this.remotes.onSnapshot(msg.players, msg.time);
        for (const p of msg.players) {
          this.roster.set(p.id, p);
          if (p.id === this.localId) this.syncLocal(p);
        }
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
        if (msg.victim === this.localId) {
          this.local.dead = true;
          this.hud.setDead(true);
        }
        break;
      }
      case "shot": {
        const o = new THREE.Vector3(msg.origin.x, msg.origin.y, msg.origin.z);
        const d = new THREE.Vector3(msg.dir.x, msg.dir.y, msg.dir.z);
        this.weapon.remoteShot(o, d);
        break;
      }
      case "respawned":
        if (msg.id === this.localId) {
          this.local.spawn(msg.pos.x, msg.pos.y, msg.pos.z);
          this.local.dead = false;
          this.hud.setDead(false);
          this.hud.setHealth(msg.health);
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
    }
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
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    dt = Math.min(dt, 0.05); // clamp to avoid tunneling on hitches

    // Look
    if (this.input.locked) {
      const m = this.input.consumeMouse();
      this.local.look(m.dx, m.dy);
    }

    this.local.update(this.input, dt);
    this.weapon.update(dt, this.input.firing && this.input.locked, this.input.ads);
    this.remotes.update();

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

    this.renderer.render();
    requestAnimationFrame(() => this.loop());
  }
}

// Re-export for callers that want the constant without importing shared directly.
export { PLAYER };
