import * as THREE from "three";
import { WEAPONS, DEFAULT_WEAPON, MOVE, type WeaponDef } from "@drunkr/shared";
import type { LocalPlayer } from "../entities/LocalPlayer.js";
import type { RemotePlayers } from "../entities/RemotePlayers.js";
import type { Network } from "../net/Network.js";

interface Tracer {
  line: THREE.Line;
  life: number;
}

export interface WeaponCallbacks {
  onAmmo: (cur: number, max: number) => void;
  onHit: (head: boolean) => void;
  /** Reload progress for the HUD bar (0..1). active=false hides it. */
  onReloadState: (active: boolean, progress: number) => void;
  /** The held weapon changed (for the HUD label). */
  onWeapon: (name: string, id: string) => void;
  /** Scope overlay on/off (scoped weapon + aiming down sights). */
  onScope: (active: boolean) => void;
  /** A shot was fired (for sound), with the weapon id. */
  onShoot: (weaponId: string) => void;
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
  switchTo(id: string): boolean {
    const def = WEAPONS[id];
    if (!def || def.id === this.def.id) return false;
    // Stash the current weapon's ammo, restore the target's (or a full mag).
    this.ammoByWeapon[this.def.id] = this.ammo;
    this.def = def;
    this.ammo = this.ammoByWeapon[id] ?? def.magazine;
    this.reloading = false;
    this.reloadTimer = 0;
    this.cooldown = 0;
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

    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x16182a, emissive: 0x18e0ff, emissiveIntensity: 0.25,
      roughness: 0.4, metalness: 0.6,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0xff2d9b, emissive: 0xff2d9b, emissiveIntensity: 0.8,
    });

    let muzzleZ = -0.9;
    if (this.def.id === "sniper") {
      // Long-barrelled scoped rifle.
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.9), bodyMat);
      body.position.set(0, 0, -0.45);
      g.add(body);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.8), bodyMat);
      barrel.position.set(0, 0.02, -1.0);
      g.add(barrel);
      // Scope.
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.28, 8), accentMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.11, -0.45);
      g.add(scope);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.18, 0.12), bodyMat);
      grip.position.set(0, -0.13, -0.1);
      grip.rotation.x = 0.3;
      g.add(grip);
      muzzleZ = -1.4;
    } else {
      // Compact full-auto rifle.
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.7), bodyMat);
      body.position.set(0, 0, -0.35);
      g.add(body);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), bodyMat);
      barrel.position.set(0, 0.02, -0.75);
      g.add(barrel);
      const accent = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.3), accentMat);
      accent.position.set(0, 0.09, -0.3);
      g.add(accent);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.1), bodyMat);
      mag.position.set(0, -0.18, -0.2);
      g.add(mag);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.12), bodyMat);
      grip.position.set(0, -0.14, -0.05);
      grip.rotation.x = 0.3;
      g.add(grip);
    }

    this.muzzle.position.set(0, 0, muzzleZ);
    this.muzzleFlash.position.set(0, 0, muzzleZ);
    g.add(this.muzzle);
    g.add(this.muzzleFlash);

    g.position.set(0.22, -0.2, -0.35);
    this.viewmodel = g;
    this.camera.add(g);
  }

  reload() {
    if (this.reloading || this.ammo === this.def.magazine) return;
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
      (this.def.magazine === 0 || this.ammo > 0)
    ) {
      this.fire();
    }

    // Auto-reload when empty (also racks the lever-action sniper). Melee has no mag.
    if (this.def.magazine > 0 && this.ammo === 0 && !this.reloading) this.reload();

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
    this.viewmodel.visible = this.zoom < 0.5;
    this.cb.onScope(this.zoom > 0.6);

    this.updateEffects(dt);
  }

  private fire() {
    this.cooldown = 60 / this.def.fireRate;
    if (this.def.magazine > 0) {
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

    for (let i = 0; i < pellets; i++) {
      const dir = forward.clone();
      dir.x += (Math.random() - 0.5) * spread * 2;
      dir.y += (Math.random() - 0.5) * spread * 2;
      dir.z += (Math.random() - 0.5) * spread * 2;
      dir.normalize();
      dirs.push({ x: dir.x, y: dir.y, z: dir.z });

      const r = this.castRay(origin, dir);
      if (r.hit) { anyHit = true; anyHead = anyHead || r.head; }
    }

    this.flash();
    this.kick = 1;

    // Recoil by weapon (melee has none).
    const k = this.def.id === "sniper" ? 0.05 : this.def.id === "shotgun" ? 0.06 : this.def.melee ? 0 : 0.013;
    if (k > 0) this.local.addRecoil(k + Math.random() * k * 0.4, (Math.random() - 0.5) * 0.012);

    // Self-knockback (shotgun rocket-jump): shove opposite the aim direction.
    if (this.def.selfKnockback) {
      const imp = this.def.selfKnockback;
      this.local.applyImpulse(-forward.x * imp, -forward.y * imp, -forward.z * imp);
    }

    if (anyHit) this.cb.onHit(anyHead);
    this.cb.onShoot(this.def.id);

    this.net.send({
      t: "shoot",
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dirs,
      melee: this.def.melee,
    });
  }

  /** Cast one pellet locally for tracer + hit feedback. Returns hit info. */
  private castRay(origin: THREE.Vector3, dir: THREE.Vector3): { hit: boolean; head: boolean } {
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
    if (Number.isFinite(wallDist) && wallDist < hitDist) hitPoint = wallHits[0].point.clone();

    // Melee swings don't draw bullet tracers.
    if (!this.def.melee) this.spawnTracer(origin, dir, hitPoint);
    return { hit: hitId >= 0, head };
  }

  /** Render a tracer for a shot fired by another player. */
  remoteShot(origin: THREE.Vector3, dir: THREE.Vector3) {
    const end = origin.clone().addScaledVector(dir, this.def.range);
    this.raycaster.set(origin, dir);
    this.raycaster.far = this.def.range;
    const hits = this.raycaster.intersectObjects(this.colliders, false);
    if (hits.length) end.copy(hits[0].point);
    this.spawnTracer(origin, dir, end);
  }

  private spawnTracer(origin: THREE.Vector3, _dir: THREE.Vector3, end: THREE.Vector3) {
    const geo = new THREE.BufferGeometry().setFromPoints([origin.clone(), end]);
    const mat = new THREE.LineBasicMaterial({
      color: 0xfff2b0,
      transparent: true,
      opacity: 0.9,
    });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.08 });
    if (this.tracers.length > 40) this.killTracer(0);
  }

  private flash() {
    this.muzzle.intensity = 4;
    this.muzzleFlash.visible = true;
    this.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.6);
  }

  private updateEffects(dt: number) {
    // Tracer fade.
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      const mat = t.line.material as THREE.LineBasicMaterial;
      mat.opacity = Math.max(0, t.life / 0.08) * 0.9;
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

    this.viewmodel.position.set(
      0.22 + this.reloadDip * 0.04,
      -0.2 - this.kick * 0.015 - this.reloadDip * 0.24,
      -0.35 + this.kick * 0.06 + this.reloadDip * 0.05,
    );
    this.viewmodel.rotation.set(this.reloadDip * 0.6 + work, this.reloadDip * 0.35, 0);
  }

  private killTracer(i: number) {
    const t = this.tracers[i];
    this.scene.remove(t.line);
    t.line.geometry.dispose();
    (t.line.material as THREE.Material).dispose();
    this.tracers.splice(i, 1);
  }
}
