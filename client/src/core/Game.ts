import * as THREE from "three";
import {
  CLIENT_SEND_RATE,
  MAPS,
  MOVE,
  PLAYER,
  WEAPONS,
  ABILITIES,
  DEFAULT_ABILITIES,
  sanitizeAbilities,
  BOMB,
  INVIS,
  UPDRAFT,
  GRENADE,
  BLINK,
  SHOCKWAVE,
  BLOODLUST,
  SIPHON,
  GRAPPLE,
  WALLKICK,
  RECALL,
  type AbilityId,
  type DecoyState,
  type PlayerState,
  type S_Welcome,
  type S_Intermission,
  type S_MatchRestart,
  type S_BombRoundStart,
  type S_BombEvent,
  type S_BombRoundEnd,
  type ServerMessage,
} from "@drunkr/shared";
import { Renderer } from "../render/Renderer.js";
import { Particles } from "../render/Particles.js";
import { SpeedLines } from "../render/SpeedLines.js";
import { Arena } from "../world/Arena.js";
import { LocalPlayer } from "../entities/LocalPlayer.js";
import { RemotePlayers } from "../entities/RemotePlayers.js";
import { Weapon } from "../weapons/Weapon.js";
import { Input } from "../input/Input.js";
import { HUD, killBrag } from "../ui/HUD.js";
import { AdminPanel } from "../ui/AdminPanel.js";
import { Sfx } from "../audio/Sfx.js";
import { Music } from "../audio/Music.js";
import { settings, QUALITY_HEIGHT } from "./Settings.js";
import { SettingsPanel } from "../ui/SettingsPanel.js";
import { ACCESSORIES, ACCESSORY_EMIT_Y } from "../render/cosmetics.js";
import { Locker } from "../ui/Locker.js";
import type { Network } from "../net/Network.js";

export class Game {
  private renderer: Renderer;
  private particles: Particles;
  private speedLines = new SpeedLines();
  /** True while the local player has spawn protection (cleared on first shot). */
  private protectActive = false;
  /** Shockwave launched and waiting to slam on landing. */
  private shockwavePending = false;
  private arena: Arena;
  private local: LocalPlayer;
  private remotes: RemotePlayers;
  private weapon: Weapon;
  private input: Input;
  private hud: HUD;
  private adminPanel: AdminPanel;
  private isAdmin = false;
  private adminBadge = document.getElementById("admin-badge")!;
  private sfx = new Sfx();
  private music: Music | null = null;
  private musicStarted = false;

  // Pause / death menu DOM refs.
  private pauseMenu = document.getElementById("pause-menu")!;
  private pmTitle = document.getElementById("pm-title")!;
  private pmName = document.getElementById("pm-name") as HTMLInputElement;
  private pmResumeBtn = document.getElementById("pm-resume") as HTMLButtonElement;
  private settingsPanel!: SettingsPanel;
  private locker = new Locker();

  private chatOpen = false;
  private chatBar = document.getElementById("chat-bar")!;
  private chatInput = document.getElementById("chat-input") as HTMLInputElement;

  private localId: number;
  private currentMapId: string;
  private roster = new Map<number, PlayerState>();
  private lastFrame = performance.now();
  private sendAccum = 0;
  private running = false;
  /** Server-clock offset (serverNow ≈ Date.now() + offset) and match deadline. */
  private clockOffset = 0;
  private matchEndsAt: number;
  private fps = 60;
  /** Decaying camera-shake amount (0..~1.4), driven by nearby explosions. */
  private shake = 0;
  private fellSent = false;
  /** Local player's chosen abilities [F, C]; mirrors the server. */
  private localAbilities: string[] = [...DEFAULT_ABILITIES];
  /** Client-side ability cooldown end times (performance.now ms). */
  private abilityCd: Record<string, number> = {};
  /** Live grenade meshes by projectile id. */
  private projMeshes = new Map<number, THREE.Mesh>();
  private decoyMeshes = new Map<number, THREE.Mesh>();
  private slowTimer = 0;
  private losRay = new THREE.Raycaster();
  private aimRaycaster = new THREE.Raycaster();
  private footstepTimer = 0;
  private reloadSoundFired = false;
  /** Death-cam: line + muzzle marker showing where the lethal shot came from. */
  private deathTracer: THREE.Group | null = null;
  /** Slinger grapple rope: black line from the hand to the anchor while reeling. */
  private grappleLine: THREE.Line | null = null;

  // Bomb defusal mode state.
  private inBombMode = false;
  private bombTeam: "T" | "CT" | null = null;
  private bombRoundNum = 0;
  private bombScoreT = 0;
  private bombScoreCT = 0;
  private bombRoundEndsAt = 0;
  private bombPlanted = false;
  private bombPos: THREE.Vector3 | null = null;
  private bombDetonatesAt = 0;
  private lastUseHeld = false;
  private bombTickTimer: ReturnType<typeof setTimeout> | null = null;

  // Bomb HUD refs.
  private bombHudEl = document.getElementById("bomb-hud")!;
  private bombTeamEl = document.getElementById("bomb-team")!;
  private bombScoreEl = document.getElementById("bomb-score")!;
  private bombTimerEl = document.getElementById("bomb-timer")!;
  private bombPromptEl = document.getElementById("bomb-prompt")!;
  private bombRoundEndEl = document.getElementById("bomb-round-end")!;
  private bombRoundResultEl = document.getElementById("bomb-round-result")!;
  private bombRoundScoreEl = document.getElementById("bomb-round-score")!;

  // Intermission overlay refs.
  private interEl = document.getElementById("inter")!;
  private interWinner = document.getElementById("inter-winner")!;
  private interCountdown = document.getElementById("inter-countdown")!;
  private interScoreBody = document.getElementById("inter-score-body")!;
  private interVoteBtns = document.getElementById("inter-vote-btns")!;
  private inIntermission = false;
  private interEndsAt = 0;
  private interVoteMaps: { id: string; name: string }[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    private net: Network,
    welcome: S_Welcome,
    music?: Music,
  ) {
    this.music = music ?? null;
    this.localId = welcome.id;
    this.currentMapId = welcome.mapId;
    this.matchEndsAt = welcome.matchEndsAt;
    // Custom (editor) maps arrive inline; built-ins are looked up by id.
    const map = welcome.mapData ?? MAPS[welcome.mapId] ?? MAPS.neon_yard;

    this.renderer = new Renderer(canvas);
    this.particles = new Particles(this.renderer.scene, this.renderer.renderHeight);
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
      this.particles,
      {
        onAmmo: (cur, max) => this.hud.setAmmo(cur, max),
        onHit: (head) => { this.hud.hitmark(head); this.sfx.hit(head); },
        onReloadState: (active, progress) => {
          this.hud.setReload(active, progress);
          if (!active) {
            this.reloadSoundFired = false;
          } else if (!this.reloadSoundFired) {
            this.reloadSoundFired = true;
            this.sfx.reload(this.weapon.def.id);
          }
        },
        onWeapon: (name) => this.hud.setWeapon(name),
        onScope: (active) => this.hud.setScope(active),
        onShoot: (id) => {
          this.sfx.shoot(id);
          // Firing drops spawn protection instantly (the server does the same).
          if (this.protectActive) { this.protectActive = false; this.hud.setProtected(false); }
        },
        onWallHit: (pos) => this.sfx.bulletImpact(pos.x, pos.y, pos.z),
      },
    );

    this.input.onReload = () => this.weapon.reload();
    this.input.onSwitch = (id) => this.switchWeapon(id);
    this.input.onCycle = (dir) => this.cycleWeapon(dir);
    this.input.onAbility = (slot) => this.useAbility(slot);
    this.input.onInspect = () => this.weapon.startInspect();
    this.input.onLockChange = (locked) => {
      if (locked) {
        this.sfx.resume();
        const ctx = this.sfx.getContext();
        if (ctx && this.music) this.music.connectContext(ctx);
        if (!this.musicStarted && this.music) {
          this.musicStarted = true;
          this.music.start();
        }
        this.sfx.startAmbience();
        this.hidePauseMenu();
      } else if (!this.local.dead && !this.adminPanel.open && !this.chatOpen) {
        this.showPauseMenu(false);
      }
    };
    this.initPauseMenu();
    this.initChat();

    // Admin panel (only usable once the server grants admin).
    this.adminPanel = new AdminPanel({
      send: (m) => this.net.send(m),
      roster: () => [...this.roster.values()],
      localId: this.localId,
      maps: Object.entries(MAPS).filter(([id]) => id !== "dust2").map(([id, m]) => ({ id, name: m.name })),
      onClientToggle: (key, on) => {
        if (key === "noclip") this.local.noclip = on;
        else if (key === "fly") this.local.fly = on;
        else if (key === "infammo") this.weapon.infiniteAmmo = on;
      },
      onSpeed: (mul) => { this.local.adminSpeedMul = mul; },
      onClose: () => this.closeAdmin(),
    });
    window.addEventListener("keydown", (e) => {
      // Don't steal keys while typing into any input / select.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === settings.keymap.chat && this.input.locked && !this.local.dead && !this.inIntermission) {
        e.preventDefault();
        this.openChat();
        return;
      }
      if (e.code !== "Backquote" || !this.isAdmin || !this.running || this.inIntermission) return;
      e.preventDefault();
      if (this.adminPanel.open) this.closeAdmin(); else this.openAdmin();
    });

    // Seed roster and spawn from the welcome payload.
    for (const p of welcome.players) {
      this.roster.set(p.id, p);
      if (p.id === this.localId) {
        this.local.spawn(p.pos.x, p.pos.y, p.pos.z);
        this.localAbilities = sanitizeAbilities(p.abilities);
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

  // ---- Pause / death menu -----------------------------------------------

  private initPauseMenu() {
    // Pre-fill name from localStorage. Loadout + cosmetics live in the Locker.
    this.pmName.value = localStorage.getItem("drunkr.name") ?? "";

    // Name changes save immediately.
    this.pmName.addEventListener("input", () => {
      const n = this.pmName.value.trim();
      if (n) localStorage.setItem("drunkr.name", n);
    });

    // Locker: weapon skins live-update the held viewmodel; accessory/skin
    // changes for the avatar apply on the next respawn (broadcast via prefs at join).
    // Ability changes are queued server-side and hotswap on the next respawn.
    document.getElementById("pm-open-locker")!.addEventListener("click", () => {
      this.locker.open(
        () => this.weapon.refreshSkin(),
        undefined,
        (abilities) => {
          this.net.send({ t: "abilities", abilities });
          this.hud.toast("Abilities apply on next spawn", "info");
        },
      );
    });

    // Shared settings UI (same component as the lobby), with live audio/graphics
    // hooks into this game's instances.
    this.sfx.setVolume(settings.sfxVolume);
    this.settingsPanel = new SettingsPanel(document.getElementById("pm-settings")!, {
      onMusicEnabled: (on) => this.music?.setEnabled(on),
      onMusicVol: (v) => this.music?.setVolume(v),
      onSfxVol: (v) => this.sfx.setVolume(v),
      onQuality: (q) => {
        this.renderer.setPixelHeight(QUALITY_HEIGHT[q]);
        this.particles.setScale(this.renderer.renderHeight);
      },
    });

    // Resume button re-locks the pointer (which hides the menu via onLockChange).
    this.pmResumeBtn.addEventListener("click", () => this.input.requestLock());
  }

  private initChat() {
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.code === "Enter") {
        const text = this.chatInput.value.trim();
        if (text) this.net.send({ t: "chat", text });
        this.closeChat();
        e.preventDefault();
      } else if (e.code === "Escape") {
        this.closeChat();
        e.preventDefault();
      }
      e.stopPropagation();
    });
  }

  private openChat() {
    this.chatOpen = true;
    this.chatInput.value = "";
    this.chatBar.classList.remove("hidden");
    document.exitPointerLock?.();
    setTimeout(() => this.chatInput.focus(), 40);
  }

  private closeChat() {
    this.chatOpen = false;
    this.chatInput.value = "";
    this.chatBar.classList.add("hidden");
    this.input.requestLock();
  }

  private showPauseMenu(isDead: boolean) {
    this.settingsPanel.refresh();
    this.pmTitle.textContent = isDead ? "ELIMINATED" : "PAUSED";
    this.pmTitle.style.color = isDead ? "var(--neon-pink)" : "var(--neon-cyan)";
    this.pmResumeBtn.classList.toggle("hidden", isDead);
    this.pauseMenu.classList.remove("hidden");
  }

  private hidePauseMenu() {
    this.pauseMenu.classList.add("hidden");
  }

  // ---- Admin panel ----------------------------------------------------------

  private openAdmin() {
    this.hidePauseMenu();
    this.adminPanel.show();
    document.exitPointerLock?.();
  }

  private closeAdmin() {
    this.adminPanel.hide();
    this.input.requestLock();
  }

  // ---- Game lifecycle -------------------------------------------------------

  start() {
    this.hud.show();
    this.running = true;
    this.renderer.setPixelHeight(QUALITY_HEIGHT[settings.quality]);
    this.particles.setScale(this.renderer.renderHeight);
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
        this.syncDecoys(msg.decoys ?? []);
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
        const assistNames = (msg.assists ?? []).map((id) => this.roster.get(id)?.name ?? "?");
        this.hud.addKill(killer, victim, msg.head, assistNames, msg.multi ?? 1, !!msg.noscope, !!msg.airborne, msg.cause);
        // Death dissolve in the victim's hue (skip the local player — no avatar).
        if (msg.victim !== this.localId) {
          const vp = this.remotes.position(msg.victim);
          const vhue = this.roster.get(msg.victim)?.hue ?? 0.5;
          if (vp) this.particles.death(vp, new THREE.Color().setHSL(vhue, 0.85, 0.55).getHex());
        }
        if (msg.killer === this.localId && msg.victim !== this.localId) {
          this.sfx.kill();
          this.hud.killConfirm(killBrag(victim, msg.noscope, msg.airborne), "kill");
          if ((msg.multi ?? 1) >= 2) this.hud.multiKill(msg.multi!);
          // Kill reward: refill the magazine of the weapon we're holding. The
          // +25 HP refund is applied server-side and arrives via the snapshot.
          this.weapon.refillCurrent();
        } else if ((msg.assists ?? []).includes(this.localId) && msg.victim !== this.localId) {
          this.hud.killConfirm(`assist (${victim})`, "assist");
        }
        if (msg.victim === this.localId) {
          this.local.dead = true;
          this.resetAbilityCooldowns();
          this.hud.setDead(true);
          const selfDeath = msg.killer === msg.victim;
          this.hud.setDeathInfo(selfDeath ? null : killer, msg.head, msg.cause, msg.noscope, msg.airborne);
          this.protectActive = false;
          this.shockwavePending = false;
          this.hud.setProtected(false);
          this.sfx.death();
          if (msg.from && msg.at) {
            this.showDeathTracer(
              new THREE.Vector3(msg.from.x, msg.from.y, msg.from.z),
              new THREE.Vector3(msg.at.x, msg.at.y, msg.at.z),
            );
          }
        }
        break;
      }
      case "shot": {
        const o = new THREE.Vector3(msg.origin.x, msg.origin.y, msg.origin.z);
        if (msg.melee) {
          // Show the attacker's katana swing.
          this.remotes.meleeSwing(msg.from);
        } else {
          // Start tracers at the shooter's muzzle (falling back to the eye
          // origin) so they come out of the barrel, not the head.
          const start = this.remotes.muzzleWorld(msg.from, new THREE.Vector3()) ?? o;
          for (const dir of msg.dirs) {
            this.weapon.remoteShot(start, new THREE.Vector3(dir.x, dir.y, dir.z));
          }
        }
        // True 3D positional audio — PannerNode handles distance falloff.
        this.sfx.remoteShootAt(msg.weapon, msg.origin.x, msg.origin.y, msg.origin.z);
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
      case "intermission":
        this.showIntermission(msg);
        break;
      case "voteupdate":
        this.updateVotes(msg.votes);
        break;
      case "matchrestart":
        this.restartFromMap(msg);
        break;
      case "respawned":
        if (msg.id === this.localId) {
          this.local.spawn(msg.pos.x, msg.pos.y, msg.pos.z);
          this.local.dead = false;
          this.fellSent = false;
          this.hud.setDead(false);
          this.hud.setHealth(msg.health);
          this.weapon.resetAmmo();
          this.clearDeathTracer();
          this.protectActive = true;
          this.hud.setProtected(true);
          const hue = this.roster.get(this.localId)?.hue ?? 0.5;
          this.particles.spawnBurst(msg.pos, new THREE.Color().setHSL(hue, 0.85, 0.55).getHex());
        } else {
          const r = this.roster.get(msg.id);
          if (r) this.particles.spawnBurst(msg.pos, new THREE.Color().setHSL(r.hue, 0.85, 0.55).getHex());
        }
        break;
      case "admin": {
        this.isAdmin = msg.granted;
        this.adminBadge.classList.toggle("hidden", !msg.granted);
        if (!msg.granted) {
          if (this.adminPanel.open) this.closeAdmin();
          // Drop any client-side mods when admin is revoked.
          this.local.noclip = false;
          this.local.fly = false;
          this.local.adminSpeedMul = 1;
          this.weapon.infiniteAmmo = false;
        }
        this.hud.toast(msg.granted ? "ADMIN GRANTED — press ` for panel" : "Admin revoked", "admin");
        break;
      }
      case "toast":
        this.hud.toast(msg.text, msg.kind ?? "info");
        break;
      case "teleport": {
        const hue = this.roster.get(this.localId)?.hue ?? 0.5;
        const col = new THREE.Color().setHSL(hue, 0.85, 0.55).getHex();
        this.particles.spawnBurst({ x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z }, col);
        this.local.teleport(msg.pos.x, msg.pos.y, msg.pos.z);
        this.particles.spawnBurst(msg.pos, col);
        this.fellSent = false;
        break;
      }
      case "impulse":
        // Pull / Repulse from another player's ability.
        this.local.applyImpulse(msg.vel.x, msg.vel.y, msg.vel.z);
        break;
      case "slow":
        // Time Bubble: temporarily slow our movement.
        this.local.extSlowMul = msg.mul;
        clearTimeout(this.slowTimer);
        this.slowTimer = window.setTimeout(() => { this.local.extSlowMul = 1; }, msg.ms);
        break;
      case "bombstart":
        this.onBombRoundStart(msg);
        break;
      case "bombevent":
        this.onBombEvent(msg);
        break;
      case "bombroundend":
        this.onBombRoundEnd(msg);
        break;
      case "chat":
        this.hud.addChatMessage(msg.name, msg.text);
        break;
      case "ping":
        // Echo back so the server can measure our round-trip latency.
        this.net.send({ t: "pong", ts: msg.ts });
        break;
    }
  }

  // ---- Intermission --------------------------------------------------------

  private showIntermission(msg: S_Intermission) {
    this.inIntermission = true;
    this.interEndsAt = msg.endsAt;
    this.interVoteMaps = msg.mapOptions;

    this.interWinner.textContent = `${msg.winnerName} WINS`;

    const sorted = [...msg.scores].sort((a, b) => b.kills - a.kills);
    const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
    this.interScoreBody.innerHTML = sorted
      .map((p) => {
        const fired = p.shotsFired ?? 0, hit = p.shotsHit ?? 0, hs = p.headshots ?? 0;
        return `<tr class="${p.id === this.localId ? "me" : ""}"><td>${p.admin ? "★ " : ""}${esc(p.name)}</td>` +
          `<td class="r">${p.kills}</td><td class="r">${p.deaths}</td><td class="r">${p.assists ?? 0}</td>` +
          `<td class="r">${pct(hit, fired)}</td><td class="r">${pct(hs, hit)}</td></tr>`;
      })
      .join("");

    this.interVoteBtns.innerHTML = "";
    for (const map of msg.mapOptions) {
      const btn = document.createElement("button");
      btn.className = "vote-btn";
      btn.dataset.mapId = map.id;
      btn.innerHTML = `<span>${map.name}</span><span class="vote-count">0</span>`;
      btn.addEventListener("click", () => this.castVote(map.id));
      this.interVoteBtns.appendChild(btn);
    }

    this.interEl.classList.remove("hidden");
    document.exitPointerLock?.();
  }

  private castVote(mapId: string) {
    this.net.send({ t: "vote", mapId });
    for (const btn of this.interVoteBtns.querySelectorAll<HTMLElement>(".vote-btn")) {
      btn.classList.toggle("voted", btn.dataset.mapId === mapId);
    }
  }

  private updateVotes(votes: Record<string, number>) {
    for (const btn of this.interVoteBtns.querySelectorAll<HTMLElement>(".vote-btn")) {
      const count = votes[btn.dataset.mapId ?? ""] ?? 0;
      btn.querySelector(".vote-count")!.textContent = String(count);
    }
  }

  private restartFromMap(msg: S_MatchRestart) {
    this.inIntermission = false;
    this.interEl.classList.add("hidden");
    this.matchEndsAt = msg.matchEndsAt;
    // Reset bomb state on map restart (bombstart follows right after in bomb mode).
    this.stopBombTick();
    this.bombPlanted = false;
    this.bombPos = null;
    this.bombDetonatesAt = 0;
    this.bombTimerEl.classList.add("hidden");
    this.bombRoundEndEl.classList.add("hidden");
    this.bombPromptEl.classList.add("hidden");

    const map = msg.mapData ?? MAPS[msg.mapId] ?? MAPS.neon_yard;
    if (msg.mapId !== this.currentMapId || msg.mapData) {
      this.currentMapId = msg.mapId;
      this.renderer.scene.remove(this.arena.group);
      this.arena.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.arena = new Arena(map);
      this.renderer.scene.add(this.arena.group);
      this.weapon.setColliders(this.arena.colliders);
      this.local.setWorld(this.arena.collision);
    }

    for (const mesh of [...this.projMeshes.values(), ...this.decoyMeshes.values()]) {
      this.renderer.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.projMeshes.clear();
    this.decoyMeshes.clear();
    this.particles.clear();

    this.roster.clear();
    this.remotes.clear();
    for (const p of msg.players) {
      this.roster.set(p.id, p);
      if (p.id === this.localId) {
        this.local.spawn(p.pos.x, p.pos.y, p.pos.z);
        this.local.dead = false;
        this.fellSent = false;
        this.hud.setDead(false);
        this.hud.setHealth(p.health);
        this.weapon.resetAmmo();
        this.protectActive = true;
        this.hud.setProtected(true);
      } else {
        this.remotes.add(p);
      }
    }
    this.clearDeathTracer();
    this.input.requestLock();
  }

  // ---- Bomb defusal mode ---------------------------------------------------

  private onBombRoundStart(msg: S_BombRoundStart) {
    this.inBombMode = true;
    const myEntry = msg.teams.find((t) => t.id === this.localId);
    this.bombTeam = myEntry?.team ?? null;
    this.bombRoundNum = msg.roundNum;
    this.bombScoreT = msg.scoreT;
    this.bombScoreCT = msg.scoreCT;
    this.bombRoundEndsAt = msg.roundEndsAt;
    this.bombPlanted = false;
    this.bombPos = null;
    this.bombDetonatesAt = 0;
    this.lastUseHeld = false;
    this.stopBombTick();
    this.bombTimerEl.classList.add("hidden");
    this.bombPromptEl.classList.add("hidden");
    this.bombRoundEndEl.classList.add("hidden");
    this.bombHudEl.classList.remove("hidden");
    this.updateBombTeamHud();

    this.roster.clear();
    this.remotes.clear();
    for (const p of msg.players) {
      this.roster.set(p.id, p);
      if (p.id === this.localId) {
        this.local.spawn(p.pos.x, p.pos.y, p.pos.z);
        this.local.dead = false;
        this.fellSent = false;
        this.hud.setDead(false);
        this.hud.setHealth(p.health);
        this.weapon.resetAmmo();
        this.protectActive = true;
        this.hud.setProtected(true);
      } else {
        this.remotes.add(p);
      }
    }
    this.clearDeathTracer();
    this.input.requestLock();
  }

  private onBombEvent(msg: S_BombEvent) {
    switch (msg.event) {
      case "planting":
        if (msg.actorId === this.localId) {
          this.bombPromptEl.textContent = "PLANTING… HOLD [E]";
          this.bombPromptEl.classList.remove("hidden");
        }
        break;
      case "plant_cancel":
        if (msg.actorId === this.localId) {
          this.bombPromptEl.classList.add("hidden");
        }
        break;
      case "planted":
        this.bombPlanted = true;
        this.bombPos = msg.pos ? new THREE.Vector3(msg.pos.x, msg.pos.y, msg.pos.z) : null;
        this.bombDetonatesAt = msg.detonatesAt ?? 0;
        this.sfx.bombPlanted();
        this.bombTimerEl.classList.remove("hidden");
        this.bombPromptEl.classList.add("hidden");
        this.startBombTick();
        break;
      case "defusing":
        if (msg.actorId === this.localId) {
          this.bombPromptEl.textContent = "DEFUSING… HOLD [E]";
          this.bombPromptEl.classList.remove("hidden");
        }
        break;
      case "defuse_cancel":
        if (msg.actorId === this.localId) {
          this.bombPromptEl.classList.add("hidden");
        }
        break;
      case "defused":
        this.sfx.bombDefused();
        this.bombPlanted = false;
        this.bombPos = null;
        this.bombTimerEl.classList.add("hidden");
        this.bombPromptEl.classList.add("hidden");
        this.stopBombTick();
        break;
      case "exploded":
        this.stopBombTick();
        this.bombTimerEl.classList.add("hidden");
        this.bombPromptEl.classList.add("hidden");
        if (msg.pos) {
          const ep = new THREE.Vector3(msg.pos.x, msg.pos.y, msg.pos.z);
          this.onExplosion("frag", ep);
        }
        break;
    }
  }

  private onBombRoundEnd(msg: S_BombRoundEnd) {
    this.bombScoreT = msg.scoreT;
    this.bombScoreCT = msg.scoreCT;
    this.stopBombTick();
    this.bombTimerEl.classList.add("hidden");
    this.bombPromptEl.classList.add("hidden");
    this.updateBombTeamHud();

    const reasonText: Record<string, string> = {
      bomb_exploded: "BOMB EXPLODED",
      bomb_defused: "BOMB DEFUSED",
      t_eliminated: "T ELIMINATED",
      ct_eliminated: "CT ELIMINATED",
      time: "TIME OVER",
    };
    this.bombRoundResultEl.textContent = `${msg.winner} WIN · ${reasonText[msg.reason] ?? ""}`;
    this.bombRoundResultEl.className = msg.winner === "T" ? "t-win" : "ct-win";
    this.bombRoundScoreEl.textContent = `T  ${msg.scoreT}  :  ${msg.scoreCT}  CT`;
    this.bombRoundEndEl.classList.remove("hidden");
  }

  private updateBombTeamHud() {
    this.bombTeamEl.textContent = this.bombTeam === "T" ? "TERRORIST" : "COUNTER-TERRORIST";
    this.bombTeamEl.className = this.bombTeam === "T" ? "t-side" : "ct-side";
    this.bombScoreEl.textContent = `T  ${this.bombScoreT}  :  ${this.bombScoreCT}  CT`;
  }

  private startBombTick() {
    this.stopBombTick();
    const schedule = () => {
      if (!this.bombPlanted) return;
      const rem = this.bombDetonatesAt - Date.now();
      if (rem <= 0) return;
      this.sfx.bombTick();
      const interval = rem < 5000 ? 180 : rem < 10000 ? 350 : rem < 20000 ? 650 : 1000;
      this.bombTickTimer = setTimeout(schedule, interval);
    };
    schedule();
  }

  private stopBombTick() {
    if (this.bombTickTimer !== null) {
      clearTimeout(this.bombTickTimer);
      this.bombTickTimer = null;
    }
  }

  private updateBombPrompt() {
    if (!this.inBombMode || this.local.dead) {
      this.bombPromptEl.classList.add("hidden");
      return;
    }
    const pos = this.local.pos;
    if (this.bombTeam === "T" && !this.bombPlanted) {
      const map = MAPS[this.currentMapId];
      let nearSite = false;
      if (map?.bombSites) {
        for (const site of map.bombSites) {
          const d = Math.hypot(pos.x - site.pos.x, pos.z - site.pos.z);
          if (d <= site.radius + 1) { nearSite = true; break; }
        }
      }
      if (nearSite) {
        this.bombPromptEl.textContent = "HOLD [E] TO PLANT";
        this.bombPromptEl.classList.remove("hidden");
      } else {
        this.bombPromptEl.classList.add("hidden");
      }
    } else if (this.bombTeam === "CT" && this.bombPlanted && this.bombPos) {
      const d = Math.hypot(pos.x - this.bombPos.x, pos.z - this.bombPos.z);
      if (d <= BOMB.proximityRadius + 2) {
        this.bombPromptEl.textContent = "HOLD [E] TO DEFUSE";
        this.bombPromptEl.classList.remove("hidden");
      } else {
        this.bombPromptEl.classList.add("hidden");
      }
    } else {
      this.bombPromptEl.classList.add("hidden");
    }
  }

  /** Scroll-wheel weapon cycle through the always-available loadout. */
  private cycleWeapon(dir: 1 | -1) {
    if (this.local.dead) return;
    const order = ["ak", "sniper", "shotgun", "katana"];
    const cur = order.indexOf(this.weapon.def.id);
    const next = order[((cur < 0 ? 0 : cur) + dir + order.length) % order.length];
    if (next !== this.weapon.def.id) this.switchWeapon(next);
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
    this.local.airThrust = !!def?.melee;
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

  /** Fire the local player's F (slot 0) or C (slot 1) ability. */
  private useAbility(slot: "F" | "C") {
    if (this.local.dead) return;
    const id = (slot === "F" ? this.localAbilities[0] : this.localAbilities[1]) as AbilityId;
    const def = ABILITIES[id];
    if (!def) return;
    const now = performance.now();
    if (now < (this.abilityCd[id] ?? 0)) return;

    let used = true;
    switch (id) {
      case "dash":
        used = this.local.tryDash();
        if (used) {
          this.sfx.dash();
          this.particles.trail({ x: this.local.pos.x, y: this.local.pos.y + 1, z: this.local.pos.z }, 0x18e0ff, 10);
        }
        break;
      case "updraft":
        this.local.applyImpulse(0, UPDRAFT.vy, 0);
        this.sfx.updraft();
        break;
      case "invis":
        this.net.send({ t: "ability", ability: "invis" });
        this.startInvis();
        this.sfx.cloak();
        break;
      case "confusion":
        this.net.send({ t: "ability", ability: "confusion", origin: this.eyePos() });
        this.sfx.confuse();
        break;
      case "flash":
      case "frag": {
        const { o, d } = this.aimRay();
        this.net.send({ t: "ability", ability: id, origin: o, dir: d });
        if (id === "flash") this.sfx.flashAbility(); else this.sfx.fragThrow();
        break;
      }
      case "blink": {
        const from = { x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z };
        this.local.blink(BLINK.dist);
        this.sfx.blink();
        const col = new THREE.Color().setHSL(this.roster.get(this.localId)?.hue ?? 0.5, 0.85, 0.55).getHex();
        this.particles.spawnBurst(from, col);
        this.particles.spawnBurst({ x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z }, col);
        break;
      }
      case "fortify":
        this.net.send({ t: "ability", ability: "fortify" });
        this.sfx.fortify();
        break;
      case "shockwave": {
        this.net.send({ t: "ability", ability: "shockwave" });
        // Dramatic launch forward (look heading) + up. The AoE slam fires when
        // we land (see the landing check in loop()).
        const fx = -Math.sin(this.local.yaw), fz = -Math.cos(this.local.yaw);
        this.local.applyImpulse(fx * SHOCKWAVE.launchForward, SHOCKWAVE.launchUp, fz * SHOCKWAVE.launchForward);
        this.shockwavePending = true;
        this.sfx.shockwave();
        break;
      }
      case "bloodlust":
        this.net.send({ t: "ability", ability: "bloodlust" });
        this.startBloodlust();
        this.sfx.fortify();
        this.hud.banner("BLOODLUST");
        break;
      case "siphon":
        this.net.send({ t: "ability", ability: "siphon" });
        this.sfx.shockwave();
        break;
      case "grapple": {
        // Reel toward the surface we're looking at (if any within range).
        const { o, d } = this.aimRay();
        this.aimRaycaster.set(new THREE.Vector3(o.x, o.y, o.z), new THREE.Vector3(d.x, d.y, d.z).normalize());
        this.aimRaycaster.far = GRAPPLE.range;
        const hit = this.aimRaycaster.intersectObjects(this.arena.colliders, false)[0];
        if (hit) {
          this.local.startGrapple(hit.point.x, hit.point.y, hit.point.z);
          this.sfx.dash();
          this.particles.trail({ x: this.local.pos.x, y: this.local.pos.y + 1, z: this.local.pos.z }, 0x18e0ff, 8);
        } else used = false;
        break;
      }
      case "wallkick":
        used = this.tryWallKick();
        if (used) this.sfx.dash();
        break;
      case "slipstream":
        this.local.slipstream();
        this.sfx.dash();
        this.particles.trail({ x: this.local.pos.x, y: this.local.pos.y + 1, z: this.local.pos.z }, 0x18e0ff, 10);
        break;
      case "recall": {
        const before = { x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z };
        this.local.recall(RECALL.rewindMs);
        this.net.send({ t: "ability", ability: "recall" });
        this.sfx.blink();
        const col = new THREE.Color().setHSL(this.roster.get(this.localId)?.hue ?? 0.5, 0.85, 0.55).getHex();
        this.particles.spawnBurst(before, col);
        this.particles.spawnBurst({ x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z }, col);
        break;
      }
      case "timebubble":
        this.net.send({ t: "ability", ability: "timebubble", origin: this.eyePos() });
        this.sfx.cloak();
        break;
      case "pull":
        this.net.send({ t: "ability", ability: "pull", origin: this.eyePos() });
        this.sfx.shockwave();
        break;
      case "reflect":
        this.net.send({ t: "ability", ability: "reflect" });
        this.sfx.fortify();
        this.hud.banner("REFLECT");
        break;
      case "repulse":
        this.net.send({ t: "ability", ability: "repulse", origin: this.eyePos() });
        this.sfx.shockwave();
        break;
      case "decoy": {
        const { o, d } = this.aimRay();
        this.net.send({ t: "ability", ability: "decoy", origin: o, dir: d });
        this.sfx.cloak();
        break;
      }
    }
    if (used) this.abilityCd[id] = now + def.cooldownMs;
  }

  private startInvis() {
    const base = WEAPONS[this.weapon.def.id]?.speedMul ?? 1;
    this.local.speedMul = base * INVIS.speedMul;
    setTimeout(() => this.applyWeaponMods(this.weapon.def.id), INVIS.durationMs);
  }

  /** Vampire Bloodlust: a short move-speed buff while lifesteal is active. */
  private startBloodlust() {
    const base = WEAPONS[this.weapon.def.id]?.speedMul ?? 1;
    this.local.speedMul = base * BLOODLUST.speedMul;
    setTimeout(() => this.applyWeaponMods(this.weapon.def.id), BLOODLUST.durationMs);
  }

  /** Skater Wall Kick: if airborne next to a wall, shove off it. */
  private tryWallKick(): boolean {
    if (this.local.grounded) return false;
    const origin = new THREE.Vector3(this.local.pos.x, this.local.pos.y + 1, this.local.pos.z);
    const dirs: [number, number, number][] = [
      [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
      [0.7, 0, 0.7], [0.7, 0, -0.7], [-0.7, 0, 0.7], [-0.7, 0, -0.7],
    ];
    for (const [dx, dy, dz] of dirs) {
      this.aimRaycaster.set(origin, new THREE.Vector3(dx, dy, dz).normalize());
      this.aimRaycaster.far = WALLKICK.range;
      if (this.aimRaycaster.intersectObjects(this.arena.colliders, false).length > 0) {
        // Kick directly away from the probed wall, plus a vertical boost.
        const away = new THREE.Vector3(-dx, 0, -dz).normalize();
        this.local.applyImpulse(away.x * WALLKICK.push, WALLKICK.up, away.z * WALLKICK.push);
        this.particles.trail({ x: this.local.pos.x, y: this.local.pos.y + 1, z: this.local.pos.z }, 0x18e0ff, 8);
        return true;
      }
    }
    return false;
  }

  /** Reconcile rendered Mirage decoy holograms with the snapshot. */
  private syncDecoys(decoys: DecoyState[]) {
    const seen = new Set<number>();
    for (const d of decoys) {
      seen.add(d.id);
      let mesh = this.decoyMeshes.get(d.id);
      if (!mesh) {
        const col = new THREE.Color().setHSL(d.hue, 0.85, 0.6);
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(MOVE.radius, MOVE.radius, MOVE.height, 10),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, depthWrite: false }),
        );
        mesh.renderOrder = 4;
        this.renderer.scene.add(mesh);
        this.decoyMeshes.set(d.id, mesh);
      }
      mesh.position.set(d.pos.x, d.pos.y + MOVE.height / 2, d.pos.z);
    }
    for (const [id, mesh] of this.decoyMeshes) {
      if (!seen.has(id)) {
        this.renderer.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.decoyMeshes.delete(id);
      }
    }
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
      this.particles.trail(p.pos, p.kind === "frag" ? 0xff2d9b : 0xbfe6ff, 1);
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

  private addShake(amt: number) {
    this.shake = Math.min(1.4, this.shake + amt);
  }

  private onExplosion(kind: "flash" | "frag" | "siphon", pos: THREE.Vector3) {
    if (kind === "siphon") this.sfx.drainAt(pos.x, pos.y, pos.z);
    else this.sfx.boomAt(pos.x, pos.y, pos.z);

    const radius = kind === "frag" ? GRENADE.fragRadius : kind === "siphon" ? SIPHON.radius : 5;
    this.particles.explosion(pos, kind, radius);

    // Camera shake, scaled by proximity (frag/shockwave only — flash is visual).
    if (kind !== "flash") {
      const cam = new THREE.Vector3();
      this.renderer.camera.getWorldPosition(cam);
      const dist = cam.distanceTo(pos);
      const amt = Math.max(0, 1 - dist / (radius + 14));
      if (amt > 0) this.addShake(amt * (kind === "frag" ? 1.2 : 0.8));
    }

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
    const now = performance.now();
    (["F", "C"] as const).forEach((slot, i) => {
      const id = this.localAbilities[i];
      const def = ABILITIES[id as keyof typeof ABILITIES];
      if (!def) return;
      const remain = Math.max(0, (this.abilityCd[id] ?? 0) - now);
      this.hud.setAbility(slot, def.name, remain <= 0, Math.ceil(remain / 1000));
    });
  }

  /** Clear ability cooldowns so they're ready again after respawning. */
  private resetAbilityCooldowns() {
    this.abilityCd = {};
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
    // Reflect server-applied ability changes (hotswap takes effect on respawn).
    if (p.abilities && p.abilities.join() !== this.localAbilities.join()) this.localAbilities = p.abilities;
    if (!p.dead && wasDead) { this.hud.setDead(false); this.clearDeathTracer(); }
    if (p.dead && !wasDead) { this.hud.setDead(true); this.resetAbilityCooldowns(); }
    this.hud.setHealth(p.health);
    // Spawn protection ends when the server says so (timeout / we fired) or on death.
    if (this.protectActive && (p.invuln === false || p.dead)) {
      this.protectActive = false;
      this.hud.setProtected(false);
    }
  }

  /**
   * Death-cam: draw a persistent red line from the killer's muzzle to the
   * impact point so the corpse can see where the lethal shot came from. Cleared
   * on respawn.
   */
  private showDeathTracer(from: THREE.Vector3, to: THREE.Vector3) {
    this.clearDeathTracer();
    const g = new THREE.Group();

    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xff2d4b, transparent: true, opacity: 0.9 }),
    );
    line.raycast = () => {};
    g.add(line);

    // A glowing marker at the shooter's muzzle (where the bullet came from).
    const src = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff2d4b }),
    );
    src.position.copy(from);
    src.raycast = () => {};
    g.add(src);

    // A small marker at the impact point.
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd23b }),
    );
    hit.position.copy(to);
    hit.raycast = () => {};
    g.add(hit);

    this.renderer.scene.add(g);
    this.deathTracer = g;
  }

  /**
   * Slinger grapple rope: a black line from the player's hand to the anchor
   * point, refreshed every frame while the grapple is reeling.
   */
  private updateGrappleLine() {
    const anchor = this.local.grappling ? this.local.grappleAnchorPos : null;
    if (anchor) {
      // Start the rope just below/right of the eye so it reads as a hand throw.
      const cam = new THREE.Vector3();
      this.renderer.camera.getWorldPosition(cam);
      const right = new THREE.Vector3(Math.cos(this.local.yaw), 0, -Math.sin(this.local.yaw));
      const from = cam.addScaledVector(right, 0.25).add(new THREE.Vector3(0, -0.25, 0));

      if (!this.grappleLine) {
        const geo = new THREE.BufferGeometry().setFromPoints([from, anchor]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x000000 }));
        line.raycast = () => {};
        line.renderOrder = 5;
        this.renderer.scene.add(line);
        this.grappleLine = line;
      } else {
        const pos = this.grappleLine.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, from.x, from.y, from.z);
        pos.setXYZ(1, anchor.x, anchor.y, anchor.z);
        pos.needsUpdate = true;
      }
    } else if (this.grappleLine) {
      this.renderer.scene.remove(this.grappleLine);
      this.grappleLine.geometry.dispose();
      (this.grappleLine.material as THREE.Material).dispose();
      this.grappleLine = null;
    }
  }

  private clearDeathTracer() {
    if (!this.deathTracer) return;
    this.renderer.scene.remove(this.deathTracer);
    this.deathTracer.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.deathTracer = null;
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
    this.hud.setPing(this.roster.get(this.localId)?.ping ?? null);

    // Update 3D audio listener to match the camera.
    {
      const camPos = new THREE.Vector3();
      const camFwd = new THREE.Vector3();
      this.renderer.camera.getWorldPosition(camPos);
      this.renderer.camera.getWorldDirection(camFwd);
      this.sfx.updateListener(camPos.x, camPos.y, camPos.z, camFwd.x, camFwd.y, camFwd.z);
    }

    // Look — sensitivity from settings, reduced while scoped.
    this.local.sensMul = settings.sensitivity * (this.weapon.scoped ? settings.scopedSens : 1);
    if (this.input.locked) {
      const m = this.input.consumeMouse();
      this.local.look(m.dx, m.dy);
    }

    // Position moving platforms (and animate fx) on the synced match clock so
    // local prediction collides against them where the server has them.
    const serverNow = Date.now() + this.clockOffset;
    this.arena.collision.setTime(serverNow);
    this.arena.update(serverNow, dt);

    const mv = this.local.update(this.input, dt);
    if (mv.jumped) this.sfx.jump();
    if (mv.landed) this.sfx.land();
    if (mv.slideStarted) this.sfx.slide();
    if (mv.padLaunched) { this.sfx.pad(); this.particles.pad(this.local.pos); }
    // Shockwave: detonate the AoE slam where we land (server validates + applies
    // damage; it broadcasts the explosion back so the visual plays for everyone).
    if (mv.landed && this.shockwavePending) {
      this.shockwavePending = false;
      this.net.send({ t: "ability", ability: "shockwaveSlam", origin: { x: this.local.pos.x, y: this.local.pos.y, z: this.local.pos.z } });
    }

    // Camera shake (decays), applied on top of the camera the player set.
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const s = this.shake * this.shake * 0.7;
      this.renderer.camera.position.x += (Math.random() - 0.5) * s;
      this.renderer.camera.position.y += (Math.random() - 0.5) * s;
      this.renderer.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.particles.update(dt);
    // Speed lines + speedometer scale with horizontal momentum (0 when dead).
    const hspeed = this.local.dead ? 0 : Math.hypot(this.local.vel.x, this.local.vel.z);
    this.speedLines.update(dt, hspeed);
    this.hud.setSpeed(hspeed);

    // Footsteps: play periodically while moving on the ground (not sliding).
    if (!this.local.dead && this.local.grounded && !this.local.sliding) {
      const spd = Math.hypot(this.local.vel.x, this.local.vel.z);
      if (spd > 1.5) {
        this.footstepTimer -= dt;
        if (this.footstepTimer <= 0) {
          this.sfx.footstep();
          this.particles.footstep(this.local.pos);
          this.footstepTimer = 0.38 * (MOVE.speed / Math.max(spd, 3));
        }
      } else {
        this.footstepTimer = 0.1;
      }
    }
    // Fell into the void → tell the server (it registers the death).
    if (!this.local.dead && this.local.pos.y < -30 && !this.fellSent) {
      this.fellSent = true;
      this.local.dead = true;
      this.resetAbilityCooldowns();
      this.hud.setDead(true);
      this.sfx.death();
      this.net.send({ t: "fell" });
    }
    this.weapon.update(dt, !this.inIntermission && this.input.firing && this.input.locked, this.input.ads);
    this.remotes.update(dt);
    this.updateGrappleLine();
    // Particle accessories (spark crown, etc.) trail above visible remotes.
    for (const p of this.roster.values()) {
      if (p.id === this.localId || p.dead || !p.accessory) continue;
      const col = ACCESSORIES[p.accessory]?.particle;
      if (col === undefined) continue;
      const pos = this.remotes.position(p.id);
      if (pos) this.particles.trail({ x: pos.x, y: pos.y + ACCESSORY_EMIT_Y, z: pos.z }, col, 1);
    }
    this.updateAbilityHud();

    // Bomb mode: E key state + HUD prompts.
    if (this.inBombMode && !this.local.dead && !this.inIntermission) {
      const useHeld = this.input.useHeld;
      if (useHeld !== this.lastUseHeld) {
        this.lastUseHeld = useHeld;
        this.net.send({ t: "use", held: useHeld });
      }
      this.updateBombPrompt();
    }

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
        posture: this.local.sliding ? 2 : this.local.crouching ? 1 : 0,
      });
    }

    this.hud.toggleScoreboard(
      this.input.showScores,
      [...this.roster.values()],
      this.localId,
    );

    if (this.inIntermission) {
      const secsLeft = Math.max(0, Math.ceil((this.interEndsAt - Date.now()) / 1000));
      this.interCountdown.textContent = String(secsLeft);
    }

    if (this.inBombMode) {
      if (this.bombPlanted && this.bombDetonatesAt > 0) {
        const sec = Math.max(0, Math.ceil((this.bombDetonatesAt - Date.now()) / 1000));
        this.bombTimerEl.textContent = `BOMB  ${sec}s`;
      }
      const roundMs = Math.max(0, this.bombRoundEndsAt - Date.now());
      this.hud.setTimer(roundMs);
    } else {
      const remainingMs = this.inIntermission ? 0 : this.matchEndsAt - (Date.now() + this.clockOffset);
      this.hud.setTimer(remainingMs);
    }

    this.renderer.render();
    requestAnimationFrame(() => this.loop());
  }
}

/** Escape user-supplied text before inserting via innerHTML. */
function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

// Re-export for callers that want the constant without importing shared directly.
export { PLAYER };
