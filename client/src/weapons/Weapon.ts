import * as THREE from "three";
import { WEAPONS, DEFAULT_WEAPON, MOVE, type WeaponDef } from "@drunkr/shared";
import type { LocalPlayer } from "../entities/LocalPlayer.js";
import type { RemotePlayers } from "../entities/RemotePlayers.js";
import type { Network } from "../net/Network.js";
import type { Particles } from "../render/Particles.js";
import { resolveWeaponParts } from "../render/cosmetics.js";
import { buildViewModel } from "../render/viewModelMesh.js";

/** Equip time (s) — you can't fire for a moment after switching weapons. */
const SWITCH_DELAY = 0.25;

interface Tracer {
  /** A thin bullet line, or a multi-mesh laser beam group (sniper). */
  obj: THREE.Object3D;
  life: number;
  ttl: number;
}

export interface WeaponCallbacks {
  onAmmo: (cur: number, max: number) => void;
  onHit: (head: boolean) => void;
  /** Predicted damage dealt to one target this shot, at the world impact point
   * (for floating damage numbers). Pellets on the same target are summed. */
  onDamage?: (x: number, y: number, z: number, amount: number, head: boolean) => void;
  /** Reload progress for the HUD bar (0..1). active=false hides it. */
  onReloadState: (active: boolean, progress: number) => void;
  /** The held weapon changed (for the HUD label). */
  onWeapon: (name: string, id: string) => void;
  /** Scope overlay on/off (scoped weapon + aiming down sights). */
  onScope: (active: boolean) => void;
  /** A shot was fired (for sound), with the weapon id. */
  onShoot: (weaponId: string) => void;
  /** A bullet hit a wall/surface at this world position (first hit per shot). */
  onWallHit?: (pos: { x: number; y: number; z: number }) => void;
}

/**
 * Hitscan weapon: switchable viewmodels, firing cadence, ammo/reload, scope
 * (ADS) zoom, client-side ray (for instant feedback + a server hint), tracers
 * and muzzle flash. The server stays authoritative over actual damage.
 */
export class Weapon {
  def: WeaponDef = WEAPONS[DEFAULT_WEAPON];
  private ammo: number;
  /** Persisted ammo per weapon id so switching doesn't refill. */
  private ammoByWeapon: Record<string, number> = {};
  private reloading = false;
  private reloadDelayTimer = 0;
  private cooldown = 0;
  private reloadTimer = 0;
  private wasFiring = false;

  private viewmodel!: THREE.Group;
  private muzzle: THREE.PointLight;
  private muzzleFlash: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private tracers: Tracer[] = [];
  private kick = 0;
  /** Smoothed reload dip applied to the viewmodel (0 = up, 1 = lowered). */
  private reloadDip = 0;
  /** Melee swing progress (1 = just swung, decays to 0). */
  private swing = 0;
  /** Equip (pullout) animation time remaining (s). */
  private equipT = 0;
  /** Inspect animation: time remaining (s) and total duration for the envelope. */
  private inspectT = 0;
  private inspectDur = 0;
  /** Weapon-bob phase, advanced by player movement. */
  private bobTime = 0;

  /** Admin toggle: never run out of ammo / reload. */
  infiniteAmmo = false;

  private readonly baseFov: number;
  private ads = false;
  /** Smoothed zoom factor (0 = hip, 1 = fully scoped). */
  private zoom = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private scene: THREE.Scene,
    private colliders: THREE.Object3D[],
    private remotes: RemotePlayers,
    private net: Network,
    private local: LocalPlayer,
    private particles: Particles,
    private cb: WeaponCallbacks,
  ) {
    this.baseFov = camera.fov;
    this.ammo = this.def.magazine;
    // Needed for any sprite raycasting; harmless for mesh/line hits.
    this.raycaster.camera = this.camera;

    this.muzzle = new THREE.PointLight(0xfff2b0, 0, 6);
    this.muzzleFlash = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff2b0 }),
    );
    this.muzzleFlash.visible = false;
    this.muzzle.position.set(0, 0, -0.9);
    this.muzzleFlash.position.set(0, 0, -0.9);

    this.buildViewmodel();
    this.cb.onAmmo(this.ammo, this.def.magazine);
    this.cb.onWeapon(this.def.name, this.def.id);
  }

  /** Switch to a different weapon by id. Returns whether it changed. */
  setColliders(colliders: THREE.Object3D[]) {
    this.colliders = colliders;
  }

  switchTo(id: string): boolean {
    const def = WEAPONS[id];
    if (!def || def.id === this.def.id) return false;
    // Stash the current weapon's ammo, restore the target's (or a full mag).
    this.ammoByWeapon[this.def.id] = this.ammo;
    this.def = def;
    this.ammo = this.ammoByWeapon[id] ?? def.magazine;
    this.reloading = false;
    this.reloadTimer = 0;
    // Brief equip delay before the new weapon can fire, with a pullout anim.
    this.cooldown = SWITCH_DELAY;
    this.equipT = SWITCH_DELAY;
    this.wasFiring = false;
    this.buildViewmodel();
    this.cb.onAmmo(this.ammo, def.magazine);
    this.cb.onWeapon(def.name, def.id);
    return true;
  }

  /** (Re)build the first-person viewmodel for the current weapon. */
  private buildViewmodel() {
    if (this.viewmodel) {
      this.camera.remove(this.viewmodel);
      this.viewmodel.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }

    // Build the shared, skin-coloured model (identical to the Locker preview).
    const parts = resolveWeaponParts(this.def.id);
    const { group: g, muzzleZ } = buildViewModel(this.def.id, parts);

    this.muzzle.position.set(0, 0, muzzleZ);
    this.muzzleFlash.position.set(0, 0, muzzleZ);
    g.add(this.muzzle);
    g.add(this.muzzleFlash);

    g.position.set(0.22, -0.2, -0.35);
    this.viewmodel = g;
    this.camera.add(g);
  }

  /** Rebuild the viewmodel to pick up a freshly-edited Locker skin. */
  refreshSkin() {
    this.buildViewmodel();
  }

  /** True while zoomed in through a scope (for scoped-sensitivity). */
  get scoped(): boolean {
    return this.zoom > 0.5;
  }

  /** Refill every weapon to a full magazine (called on respawn). */
  resetAmmo() {
    this.ammoByWeapon = {};
    this.ammo = this.def.magazine;
    this.reloading = false;
    this.reloadTimer = 0;
    this.reloadDelayTimer = 0;
    this.cb.onAmmo(this.ammo, this.def.magazine);
  }

  /** Top off only the currently-held weapon's magazine (kill reward). */
  refillCurrent() {
    this.reloading = false;
    this.reloadTimer = 0;
    this.reloadDelayTimer = 0;
    this.ammo = this.def.magazine;
    this.cb.onAmmo(this.ammo, this.def.magazine);
  }

  /** Start the local inspect animation. Spammable — re-triggering restarts it. */
  startInspect() {
    if (this.local.dead || this.reloading) return;
    this.inspectDur = this.def.melee ? 1.5 : 1.7;
    this.inspectT = this.inspectDur;
  }

  reload() {
    if (this.reloading || this.ammo === this.def.magazine) return;
    this.reloadDelayTimer = 0;
    this.reloading = true;
    this.reloadTimer = this.def.reloadMs / 1000;
  }

  update(dt: number, firing: boolean, ads: boolean) {
    this.ads = ads;
    if (this.cooldown > 0) this.cooldown -= dt;

    // Full-auto fires while held; semi-auto needs a fresh click.
    const wantFire = this.def.auto ? firing : firing && !this.wasFiring;
    this.wasFiring = firing;

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.ammo = this.def.magazine;
        this.cb.onAmmo(this.ammo, this.def.magazine);
      }
    } else if (
      wantFire && this.cooldown <= 0 && !this.local.dead &&
      (this.def.magazine === 0 || this.ammo > 0 || this.infiniteAmmo)
    ) {
      this.fire();
    }

    // Auto-reload when empty — delayed so the shot sound finishes before the reload sound starts.
    if (this.def.magazine > 0 && this.ammo === 0 && !this.reloading && !this.infiniteAmmo) {
      if (this.reloadDelayTimer > 0) {
        this.reloadDelayTimer -= dt;
        if (this.reloadDelayTimer <= 0) this.reload();
      } else {
        this.reloadDelayTimer = 0.3;
      }
    } else if (this.ammo > 0) {
      this.reloadDelayTimer = 0;
    }

    const progress = this.reloading
      ? 1 - this.reloadTimer / (this.def.reloadMs / 1000)
      : 0;
    this.cb.onReloadState(this.reloading, Math.max(0, Math.min(1, progress)));

    // Scope zoom (smoothed). Only scoped weapons zoom; hide the model when in.
    const zoomTarget = this.ads && this.def.scoped && !this.local.dead ? 1 : 0;
    this.zoom += (zoomTarget - this.zoom) * Math.min(1, 16 * dt);
    const targetFov = this.def.zoomFov ?? this.baseFov;
    const fov = this.baseFov + (targetFov - this.baseFov) * this.zoom;
    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // Hide the viewmodel while scoped in, and entirely while dead (it reappears on respawn).
    this.viewmodel.visible = this.zoom < 0.5 && !this.local.dead;
    this.cb.onScope(this.zoom > 0.6);

    this.updateEffects(dt);
  }

  private fire() {
    this.cooldown = 60 / this.def.fireRate;
    this.inspectT = 0; // shooting cancels the inspect animation
    if (this.def.magazine > 0 && !this.infiniteAmmo) {
      this.ammo--;
      this.cb.onAmmo(this.ammo, this.def.magazine);
    }

    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);

    // Scoped weapons are only accurate while aiming down sights.
    const scopedIn = this.def.scoped && this.zoom > 0.5;
    const spread =
      this.def.spread + (this.def.scoped && !scopedIn ? this.def.hipPenalty ?? 0 : 0);

    const pellets = this.def.pellets ?? 1;
    const dirs: { x: number; y: number; z: number }[] = [];
    let anyHit = false;
    let anyHead = false;
    let wallHitPoint: THREE.Vector3 | undefined;
    // Predicted damage per target this shot (pellets on the same enemy sum).
    const dmgByTarget = new Map<number, { dmg: number; head: boolean; point: THREE.Vector3 }>();

    for (let i = 0; i < pellets; i++) {
      const dir = forward.clone();
      dir.x += (Math.random() - 0.5) * spread * 2;
      dir.y += (Math.random() - 0.5) * spread * 2;
      dir.z += (Math.random() - 0.5) * spread * 2;
      dir.normalize();
      dirs.push({ x: dir.x, y: dir.y, z: dir.z });

      const r = this.castRay(origin, dir);
      if (r.hit) {
        anyHit = true; anyHead = anyHead || r.head;
        if (r.hitId >= 0) {
          // Mirror the server's hitscan formula (no distance falloff for bullets).
          const pelletDmg = this.def.damage * (r.head ? this.def.headshotMul : 1);
          const cur = dmgByTarget.get(r.hitId);
          if (cur) { cur.dmg += pelletDmg; cur.head = cur.head || r.head; cur.point.copy(r.hitPoint); }
          else dmgByTarget.set(r.hitId, { dmg: pelletDmg, head: r.head, point: r.hitPoint.clone() });
        }
      }
      if (!wallHitPoint && r.wallPoint) wallHitPoint = r.wallPoint;
    }

    if (wallHitPoint && !this.def.melee) {
      this.cb.onWallHit?.({ x: wallHitPoint.x, y: wallHitPoint.y, z: wallHitPoint.z });
    }

    if (this.def.melee) {
      this.swing = 1; // slash instead of a muzzle flash
    } else {
      this.flash();
      this.kick = 1;
      this.particles.muzzle(this.muzzleWorld(), { x: forward.x, y: forward.y, z: forward.z });
    }

    // Recoil by weapon (melee has none).
    const k = this.def.id === "sniper" ? 0.05 : this.def.id === "shotgun" ? 0.06 : this.def.melee ? 0 : 0.013;
    if (k > 0) this.local.addRecoil(k + Math.random() * k * 0.4, (Math.random() - 0.5) * 0.012);

    // Self-knockback (shotgun rocket-jump): shove opposite the aim direction.
    if (this.def.selfKnockback) {
      const imp = this.def.selfKnockback;
      this.local.applyImpulse(-forward.x * imp, -forward.y * imp, -forward.z * imp);
    }

    if (anyHit) this.cb.onHit(anyHead);
    for (const t of dmgByTarget.values()) {
      this.cb.onDamage?.(t.point.x, t.point.y, t.point.z, Math.round(t.dmg), t.head);
    }
    this.cb.onShoot(this.def.id);

    this.net.send({
      t: "shoot",
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dirs,
      melee: this.def.melee,
      ads: this.ads,
      airborne: !this.local.grounded,
      // The instant (server clock) the targets were rendered at, for lag comp.
      clientTime: this.remotes.renderTimeServer(),
    });
  }

  /** Cast one pellet locally for tracer + hit feedback. Returns hit info. */
  private castRay(origin: THREE.Vector3, dir: THREE.Vector3): { hit: boolean; head: boolean; hitId: number; hitPoint: THREE.Vector3; wallPoint?: THREE.Vector3 } {
    this.raycaster.set(origin, dir);
    this.raycaster.far = this.def.range;

    const wallHits = this.raycaster.intersectObjects(this.colliders, false);
    const wallDist = wallHits.length ? wallHits[0].distance : Infinity;

    let hitId = -1;
    let head = false;
    let hitDist = Infinity;
    let hitPoint = origin.clone().addScaledVector(dir, this.def.range);

    for (const { mesh, id } of this.remotes.hittables()) {
      const hits = this.raycaster.intersectObject(mesh, true);
      if (hits.length && hits[0].distance < hitDist && hits[0].distance < wallDist) {
        hitDist = hits[0].distance;
        hitId = id;
        hitPoint = hits[0].point.clone();
        const pPos = this.remotes.position(id);
        head = pPos ? hitPoint.y - pPos.y > MOVE.height * 0.78 : false;
      }
    }
    let wallPoint: THREE.Vector3 | undefined;
    if (Number.isFinite(wallDist) && wallDist < hitDist) {
      hitPoint = wallHits[0].point.clone();
      wallPoint = hitPoint.clone();
    }

    // Impact particles: spark spray off walls, neon spray off players.
    if (!this.def.melee) {
      if (wallPoint) this.particles.impact(wallPoint, dir);
      else if (hitId >= 0) this.particles.flesh(hitPoint);
    }

    // Melee swings don't draw bullet tracers. Start the tracer at the gun's
    // muzzle (not the camera/eye) so it's visible — an eye-origin tracer runs
    // straight down the view axis and only shows up when strafing while firing.
    if (!this.def.melee) this.spawnTracer(this.muzzleWorld(), dir, hitPoint);
    return { hit: hitId >= 0, head, hitId, hitPoint, wallPoint };
  }

  /** World position of the viewmodel's muzzle (barrel tip), for tracer origins. */
  private muzzleWorldVec = new THREE.Vector3();
  private muzzleWorld(): THREE.Vector3 {
    // getWorldPosition refreshes the world matrix up the chain for us.
    return this.muzzleFlash.getWorldPosition(this.muzzleWorldVec);
  }

  /** Render a tracer for a shot fired by another player (their weapon id picks
   * the visual — e.g. a sniper draws its laser beam, not a bullet streak). */
  remoteShot(origin: THREE.Vector3, dir: THREE.Vector3, weaponId = this.def.id) {
    const range = WEAPONS[weaponId]?.range ?? this.def.range;
    const end = origin.clone().addScaledVector(dir, range);
    this.raycaster.set(origin, dir);
    this.raycaster.far = range;
    const hits = this.raycaster.intersectObjects(this.colliders, false);
    if (hits.length) {
      end.copy(hits[0].point);
      this.particles.impact(end, { x: dir.x, y: dir.y, z: dir.z });
    }
    this.spawnTracer(origin, dir, end, weaponId);
  }

  private spawnTracer(origin: THREE.Vector3, _dir: THREE.Vector3, end: THREE.Vector3, weaponId = this.def.id) {
    // The sniper is a raygun — draw a glowing laser beam instead of a bullet
    // streak. Tint a local shot with the player's own Energy/Core skin colour.
    if (weaponId === "sniper") {
      // Tint a local shot with the player's chosen sniper lens/energy colour.
      let color = 0x18e0ff;
      if (weaponId === this.def.id) {
        const parts = resolveWeaponParts("sniper");
        color = (parts.find((p) => p.key === "lens") ?? parts[parts.length - 1]).color;
      }
      this.spawnLaser(origin, end, color);
      return;
    }
    const geo = new THREE.BufferGeometry().setFromPoints([origin.clone(), end]);
    const mat = new THREE.LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9 });
    mat.userData.base = 0.9;
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ obj: line, life: 0.08, ttl: 0.08 });
    if (this.tracers.length > 40) this.killTracer(0);
  }

  /** A glowing laser beam (white-hot core + coloured glow sheath) from the muzzle
   * to the impact point — the sniper's raygun bolt. Fades over its lifetime. */
  private spawnLaser(origin: THREE.Vector3, end: THREE.Vector3, color: number) {
    const dir = end.clone().sub(origin);
    const len = dir.length();
    if (len < 0.05) return;
    const group = new THREE.Group();
    const mid = origin.clone().addScaledVector(dir, 0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const beam = (radius: number, col: number, opacity: number) => {
      const geo = new THREE.CylinderGeometry(radius, radius, len, 8, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      mat.userData.base = opacity;
      const m = new THREE.Mesh(geo, mat);
      m.quaternion.copy(quat);
      m.position.copy(mid);
      m.raycast = () => {};
      group.add(m);
    };
    beam(0.06, color, 0.5);      // coloured glow sheath
    beam(0.02, 0xffffff, 0.95);  // white-hot core
    this.scene.add(group);
    this.tracers.push({ obj: group, life: 0.16, ttl: 0.16 });
    if (this.tracers.length > 40) this.killTracer(0);
  }

  private flash() {
    this.muzzle.intensity = 4;
    this.muzzleFlash.visible = true;
    this.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.6);
  }

  private updateEffects(dt: number) {
    // Tracer fade (each material fades from its own base opacity).
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      const k = Math.max(0, t.life / t.ttl);
      t.obj.traverse((o) => {
        const mat = (o as THREE.Mesh | THREE.Line).material as THREE.Material & { opacity: number } | undefined;
        if (mat) mat.opacity = (mat.userData.base ?? 0.9) * k;
      });
      if (t.life <= 0) this.killTracer(i);
    }

    // Muzzle flash decay.
    if (this.muzzle.intensity > 0) {
      this.muzzle.intensity = Math.max(0, this.muzzle.intensity - dt * 40);
      if (this.muzzle.intensity <= 0.1) this.muzzleFlash.visible = false;
    }

    // Viewmodel recoil kick + reload dip.
    this.kick = Math.max(0, this.kick - dt * 8);
    const dipTarget = this.reloading ? 1 : 0;
    this.reloadDip += (dipTarget - this.reloadDip) * Math.min(1, 10 * dt);
    const work = this.reloading ? Math.sin(performance.now() * 0.018) * 0.05 * this.reloadDip : 0;

    // Melee slash arc: a quick diagonal sweep from upper-right to lower-left.
    this.swing = Math.max(0, this.swing - dt * 6);
    const slash = this.swing > 0 ? Math.sin((1 - this.swing) * Math.PI) : 0;

    // Weapon bob: sways with movement (and a faint idle breathe).
    const moveSpeed = Math.hypot(this.local.vel.x, this.local.vel.z);
    const moving = this.local.grounded ? Math.min(1, moveSpeed / MOVE.speed) : 0;
    this.bobTime += dt * (5 + moveSpeed * 1.1);
    const bobX = Math.cos(this.bobTime) * 0.018 * moving + Math.sin(performance.now() * 0.001) * 0.004;
    const bobY = Math.abs(Math.sin(this.bobTime)) * 0.02 * moving;

    // Pullout / equip animation: regular rise for guns, a spin for melee + shotgun.
    this.equipT = Math.max(0, this.equipT - dt);
    const e = SWITCH_DELAY > 0 ? this.equipT / SWITCH_DELAY : 0;
    const spinEquip = this.def.melee || this.def.id === "shotgun";
    let eqX = 0, eqY = 0, eqZ = 0, eqRX = 0, eqRZ = 0;
    if (e > 0) {
      if (spinEquip) {
        eqRZ = e * Math.PI * 2;  // a full spin that unwinds into place
        eqY = -0.22 * e;
        eqX = 0.06 * e;
      } else {
        eqY = -0.36 * e;         // rises up from below
        eqZ = 0.08 * e;
        eqRX = 0.8 * e;          // tilts level as it comes up
      }
    }

    // Inspect: bring the weapon up + turn it to show it off. Guns tilt toward
    // the camera; the katana does a full spinning flourish. `env` is a smooth
    // 0→1→0 envelope so it eases in and settles back.
    this.inspectT = Math.max(0, this.inspectT - dt);
    let insX = 0, insY = 0, insZ = 0, insRX = 0, insRY = 0, insRZ = 0;
    if (this.inspectT > 0 && this.inspectDur > 0) {
      const p = 1 - this.inspectT / this.inspectDur; // 0 → 1 over the anim
      const env = Math.sin(p * Math.PI);             // 0 → 1 → 0 (smooth in/out)
      if (this.def.melee) {
        // Bottle-flip: toss the katana up, one full forward flip, lands in hand.
        const toss = Math.sin(p * Math.PI);       // up then back down
        insX = -0.05 * env;
        insY = 0.22 * toss;                       // arc up and return
        insZ = -0.05 * env;                       // slightly away
        insRX = p * Math.PI * 2;                  // exactly one flip → lands level
      } else {
        // Gun: hold it out AWAY from the camera and rotate to show the side,
        // settling back. Lower (not raised in front of the face).
        insX = -0.05 * env;
        insY = -0.03 * env;
        insZ = -0.18 * env;        // push away from the camera
        insRY = env * 1.4;         // turn the side into view
        insRX = env * 0.4;
        insRZ = env * -0.3;
      }
    }

    this.viewmodel.position.set(
      0.22 + this.reloadDip * 0.04 - slash * 0.18 + bobX + eqX + insX,
      -0.2 - this.kick * 0.015 - this.reloadDip * 0.24 + slash * 0.1 - bobY + eqY + insY,
      -0.35 + this.kick * 0.06 + this.reloadDip * 0.05 - slash * 0.25 + eqZ + insZ,
    );
    this.viewmodel.rotation.set(
      this.reloadDip * 0.6 + work - slash * 1.5 + eqRX + insRX,
      this.reloadDip * 0.35 + slash * 0.4 + insRY,
      slash * 1.3 + eqRZ + insRZ,
    );
  }

  private killTracer(i: number) {
    const t = this.tracers[i];
    this.scene.remove(t.obj);
    t.obj.traverse((o) => {
      const mesh = o as THREE.Mesh | THREE.Line;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      if (mat) mat.dispose();
    });
    this.tracers.splice(i, 1);
  }
}
