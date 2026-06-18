import * as THREE from "three";
import {
  CLIENT_SEND_RATE,
  MAPS,
  MOVE,
  PLAYER,
  WEAPONS,
  CLASSES,
  ABILITIES,
  DEFAULT_CLASS,
  BOMB,
  INVIS,
  UPDRAFT,
  GRENADE,
  BLINK,
  SHOCKWAVE,
  type AbilityId,
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
import { Arena } from "../world/Arena.js";
import { LocalPlayer } from "../entities/LocalPlayer.js";
import { RemotePlayers } from "../entities/RemotePlayers.js";
import { Weapon } from "../weapons/Weapon.js";
import { Input } from "../input/Input.js";
import { HUD } from "../ui/HUD.js";
import { Sfx } from "../audio/Sfx.js";
import { Music } from "../audio/Music.js";
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
  private music: Music | null = null;
  private musicStarted = false;

  // Pause / death menu DOM refs.
  private pauseMenu = document.getElementById("pause-menu")!;
  private pmTitle = document.getElementById("pm-title")!;
  private pmName = document.getElementById("pm-name") as HTMLInputElement;
  private pmClass = document.getElementById("pm-class") as HTMLSelectElement;
  private pmSkinsEl = document.getElementById("pm-skins")!;
  private pmResumeBtn = document.getElementById("pm-resume") as HTMLButtonElement;
  private pmMusicOn = document.getElementById("pm-music-on") as HTMLInputElement;
  private pmMusicVol = document.getElementById("pm-music-vol") as HTMLInputElement;
  private pmMusicVal = document.getElementById("pm-music-val")!;
  private pmSelectedHue = Number(localStorage.getItem("drunkr.skin") ?? 0.58);

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
  private fellSent = false;
  private localCls = DEFAULT_CLASS;
  /** Client-side ability cooldown end times (performance.now ms). */
  private abilityCd: Record<string, number> = {};
  /** Live grenade meshes by projectile id. */
  private projMeshes = new Map<number, THREE.Mesh>();
  private losRay = new THREE.Raycaster();
  private footstepTimer = 0;
  private reloadSoundFired = false;
  /** Death-cam: line + muzzle marker showing where the lethal shot came from. */
  private deathTracer: THREE.Group | null = null;

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
        onShoot: (id) => this.sfx.shoot(id),
        onWallHit: (pos) => this.sfx.bulletImpact(pos.x, pos.y, pos.z),
      },
    );

    this.input.onReload = () => this.weapon.reload();
    this.input.onSwitch = (id) => this.switchWeapon(id);
    this.input.onAbility = (slot) => this.useAbility(slot);
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
      } else if (!this.local.dead) {
        this.showPauseMenu(false);
      }
    };
    this.initPauseMenu();

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

  // ---- Pause / death menu -----------------------------------------------

  private initPauseMenu() {
    // Pre-fill name and class from localStorage.
    this.pmName.value = localStorage.getItem("drunkr.name") ?? "";
    this.pmClass.value = localStorage.getItem("drunkr.class") ?? "wind";

    // Build skin swatches.
    const SKIN_HUES = [0.0, 0.08, 0.13, 0.33, 0.5, 0.58, 0.75, 0.85];
    for (const hue of SKIN_HUES) {
      const btn = document.createElement("button");
      btn.className = "skin";
      btn.style.background = `hsl(${hue * 360}, 85%, 55%)`;
      if (Math.abs(hue - this.pmSelectedHue) < 0.001) btn.classList.add("active");
      btn.addEventListener("click", () => {
        this.pmSelectedHue = hue;
        localStorage.setItem("drunkr.skin", String(hue));
        this.pmSkinsEl.querySelectorAll(".skin").forEach((s) => s.classList.remove("active"));
        btn.classList.add("active");
      });
      this.pmSkinsEl.appendChild(btn);
    }

    // Name changes save immediately.
    this.pmName.addEventListener("input", () => {
      const n = this.pmName.value.trim();
      if (n) localStorage.setItem("drunkr.name", n);
    });

    // Class changes save immediately.
    this.pmClass.addEventListener("change", () =>
      localStorage.setItem("drunkr.class", this.pmClass.value));

    // Music controls.
    this.pmMusicOn.checked = settings.musicEnabled;
    this.pmMusicVol.value = String(Math.round(settings.musicVolume * 100));
    this.pmMusicVal.textContent = this.pmMusicVol.value;

    this.pmMusicOn.addEventListener("change", () => {
      settings.musicEnabled = this.pmMusicOn.checked;
      this.music?.setEnabled(settings.musicEnabled);
      // Keep the main-menu toggle in sync.
      const el = document.getElementById("set-music-on") as HTMLInputElement | null;
      if (el) el.checked = settings.musicEnabled;
    });
    this.pmMusicVol.addEventListener("input", () => {
      const v = Number(this.pmMusicVol.value);
      this.pmMusicVal.textContent = String(v);
      settings.musicVolume = v / 100;
      this.music?.setVolume(settings.musicVolume);
      const el = document.getElementById("set-music-vol") as HTMLInputElement | null;
      if (el) { el.value = String(v); (document.getElementById("set-music-val")!).textContent = String(v); }
    });

    // Resume button re-locks the pointer (which hides the menu via onLockChange).
    this.pmResumeBtn.addEventListener("click", () => this.input.requestLock());
  }

  private showPauseMenu(isDead: boolean) {
    this.pmTitle.textContent = isDead ? "ELIMINATED" : "PAUSED";
    this.pmTitle.style.color = isDead ? "var(--neon-pink)" : "var(--neon-cyan)";
    this.pmResumeBtn.classList.toggle("hidden", isDead);
    this.pauseMenu.classList.remove("hidden");
  }

  private hidePauseMenu() {
    this.pauseMenu.classList.add("hidden");
  }

  // ---- Game lifecycle -------------------------------------------------------

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
          this.resetAbilityCooldowns();
          this.hud.setDead(true);
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
        }
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
    }
  }

  // ---- Intermission --------------------------------------------------------

  private showIntermission(msg: S_Intermission) {
    this.inIntermission = true;
    this.interEndsAt = msg.endsAt;
    this.interVoteMaps = msg.mapOptions;

    this.interWinner.textContent = `${msg.winnerName} WINS`;

    const sorted = [...msg.scores].sort((a, b) => b.kills - a.kills);
    this.interScoreBody.innerHTML = sorted
      .map((p) => `<tr class="${p.id === this.localId ? "me" : ""}"><td>${p.name}</td><td class="r">${p.kills}</td><td class="r">${p.deaths}</td></tr>`)
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

    for (const mesh of this.projMeshes.values()) {
      this.renderer.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.projMeshes.clear();

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
      case "blink":
        this.local.blink(BLINK.dist);
        this.sfx.blink();
        break;
      case "fortify":
        this.net.send({ t: "ability", ability: "fortify" });
        this.sfx.fortify();
        break;
      case "shockwave":
        this.net.send({ t: "ability", ability: "shockwave" });
        this.local.applyImpulse(0, SHOCKWAVE.selfVy, 0);
        this.sfx.shockwave();
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
    this.sfx.boomAt(pos.x, pos.y, pos.z);
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
    if (!p.dead && wasDead) { this.hud.setDead(false); this.clearDeathTracer(); }
    if (p.dead && !wasDead) { this.hud.setDead(true); this.resetAbilityCooldowns(); }
    this.hud.setHealth(p.health);
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

    const mv = this.local.update(this.input, dt);
    if (mv.jumped) this.sfx.jump();
    if (mv.landed) this.sfx.land();
    if (mv.slideStarted) this.sfx.slide();
    if (mv.padLaunched) this.sfx.pad();

    // Footsteps: play periodically while moving on the ground (not sliding).
    if (!this.local.dead && this.local.grounded && !this.local.sliding) {
      const spd = Math.hypot(this.local.vel.x, this.local.vel.z);
      if (spd > 1.5) {
        this.footstepTimer -= dt;
        if (this.footstepTimer <= 0) {
          this.sfx.footstep();
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

// Re-export for callers that want the constant without importing shared directly.
export { PLAYER };
