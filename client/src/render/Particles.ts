import * as THREE from "three";

/**
 * Pooled particle system (see PARTICLES.md). All effects are CPU-simulated and
 * drawn as additive/alpha point sprites from a fixed pool — no per-effect
 * allocation, so it's cheap enough for the low-res pixelated buffer. Emitter
 * presets (impacts, explosions, muzzle, trails, death…) hang off the events the
 * game already receives. Expanding AoE rings use a small separate mesh pool.
 */

const TMP = new THREE.Color();
const TMP2 = new THREE.Color();

/** A pooled set of point particles sharing one draw call and blend mode. */
class PointLayer {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  // CPU-only simulation state (never uploaded).
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private floorY: Float32Array;
  private rest: Float32Array;
  private cursor = 0;

  constructor(scene: THREE.Scene, private cap: number, tex: THREE.Texture, additive: boolean, scale: number) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);
    this.floorY = new Float32Array(cap).fill(NaN);
    this.rest = new Float32Array(cap);

    this.geo = new THREE.BufferGeometry();
    const mkAttr = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute("position", mkAttr(this.pos, 3));
    this.geo.setAttribute("aColor", mkAttr(this.col, 3));
    this.geo.setAttribute("aSize", mkAttr(this.size, 1));
    this.geo.setAttribute("aAlpha", mkAttr(this.alpha, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uScale: { value: scale }, uPremult: { value: additive ? 1 : 0 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        uniform float uScale; varying float vAlpha; varying vec3 vColor;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (uScale / max(-mv.z, 0.1));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uPremult;
        varying float vAlpha; varying vec3 vColor;
        void main() {
          float a = texture2D(uTex, gl_PointCoord).a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * mix(1.0, a, uPremult), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false; // we manage lifetime; bounds vary wildly
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  setScale(s: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = s;
  }

  spawn(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number, color0: THREE.Color, color1: THREE.Color,
    grav: number, drag: number, floorY: number, rest: number,
  ) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = size0; this.s1[i] = size1;
    this.c0[i3] = color0.r; this.c0[i3 + 1] = color0.g; this.c0[i3 + 2] = color0.b;
    this.c1[i3] = color1.r; this.c1[i3 + 1] = color1.g; this.c1[i3 + 2] = color1.b;
    this.grav[i] = grav; this.drag[i] = drag;
    this.floorY[i] = floorY; this.rest[i] = rest;
  }

  update(dt: number) {
    for (let i = 0; i < this.cap; i++) {
      let l = this.life[i];
      if (l <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      l -= dt;
      const i3 = i * 3;
      if (l <= 0) { this.life[i] = 0; this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.life[i] = l;
      // Integrate.
      this.vel[i3 + 1] -= this.grav[i] * dt;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= d; this.vel[i3 + 1] *= d; this.vel[i3 + 2] *= d;
      let px = this.pos[i3] + this.vel[i3] * dt;
      let py = this.pos[i3 + 1] + this.vel[i3 + 1] * dt;
      let pz = this.pos[i3 + 2] + this.vel[i3 + 2] * dt;
      const fy = this.floorY[i];
      if (!Number.isNaN(fy) && py < fy) {
        py = fy; this.vel[i3 + 1] = -this.vel[i3 + 1] * this.rest[i];
        this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6;
      }
      this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
      // Ramp size/color/alpha by age.
      const t = 1 - l / this.maxLife[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.col[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.col[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.col[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      this.alpha[i] = l / this.maxLife[i];
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
  }
}

/** A pool of flat expanding rings for AoE / shockwave reads. */
class RingPool {
  private rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; r0: number; r1: number; t: number }[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene, count: number) {
    const geo = new THREE.RingGeometry(0.78, 1.0, 44);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; // lie flat on the ground plane
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.rings.push({ mesh, mat, life: 0, maxLife: 1, r0: 0.5, r1: 4, t: 0 });
    }
  }

  emit(x: number, y: number, z: number, color: number, r0: number, r1: number, life: number) {
    const r = this.rings[this.cursor];
    this.cursor = (this.cursor + 1) % this.rings.length;
    r.mesh.position.set(x, y + 0.06, z);
    r.mat.color.setHex(color);
    r.r0 = r0; r.r1 = r1; r.life = life; r.maxLife = life; r.t = 0;
    r.mesh.visible = true;
  }

  update(dt: number) {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      r.t = 1 - r.life / r.maxLife;
      const ease = 1 - Math.pow(1 - r.t, 2);
      const s = r.r0 + (r.r1 - r.r0) * ease;
      r.mesh.scale.set(s, s, s);
      r.mat.opacity = 0.85 * (1 - r.t);
    }
  }

  clear() {
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
  }
}

function softTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Particles {
  private spark: PointLayer; // additive (sparks, embers, glow, muzzle)
  private smoke: PointLayer; // alpha (dust, smoke)
  private rings: RingPool;

  constructor(scene: THREE.Scene, scale = 360) {
    const tex = softTexture();
    this.spark = new PointLayer(scene, 1400, tex, true, scale);
    this.smoke = new PointLayer(scene, 500, tex, false, scale);
    this.rings = new RingPool(scene, 16);
  }

  setScale(s: number) { this.spark.setScale(s); this.smoke.setScale(s); }

  update(dt: number) {
    this.spark.update(dt);
    this.smoke.update(dt);
    this.rings.update(dt);
  }

  clear() { this.spark.clear(); this.smoke.clear(); this.rings.clear(); }

  // --- Emitter presets ------------------------------------------------------

  /** Bullet hitting a wall: a spark spray opposite the bullet + a faint puff. */
  impact(p: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }) {
    const hot = TMP.setHex(0xffe6a8), cool = TMP2.setHex(0xff5a2a);
    for (let i = 0; i < 11; i++) {
      const sp = rnd(2, 7);
      this.spark.spawn(
        p.x, p.y, p.z,
        -dir.x * rnd(1, 3) + rnd(-sp, sp) * 0.5,
        Math.abs(rnd(1, 5)) + rnd(0, 2),
        -dir.z * rnd(1, 3) + rnd(-sp, sp) * 0.5,
        rnd(0.18, 0.42), rnd(0.16, 0.26), 0.01, hot, cool, 20, 2.5, p.y - 0.02, 0.3,
      );
    }
    // A single small, short-lived dust mote (kept subtle — smoke was too heavy).
    const dust = TMP.setHex(0x6a6f80);
    this.smoke.spawn(p.x, p.y, p.z, rnd(-0.6, 0.6), rnd(0.3, 0.9), rnd(-0.6, 0.6), rnd(0.18, 0.28), 0.12, 0.3, dust, dust, 2.5, 2.5, NaN, 0);
  }

  /** Bullet hitting a player: a short neon-red spark spray at the impact. */
  flesh(p: { x: number; y: number; z: number }, hue = 0xff2d5b) {
    const a = TMP.setHex(hue), b = TMP2.setHex(0x5a0010);
    for (let i = 0; i < 8; i++) {
      this.spark.spawn(p.x, p.y, p.z, rnd(-3, 3), rnd(0.5, 4), rnd(-3, 3), rnd(0.16, 0.34), 0.2, 0.02, a, b, 14, 2, NaN, 0);
    }
  }

  /** Muzzle blast: a tight, brief forward cone of sparks (no smoke). */
  muzzle(p: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }) {
    const hot = TMP.setHex(0xfff2c0), cool = TMP2.setHex(0xffae3a);
    for (let i = 0; i < 4; i++) {
      const sp = rnd(4, 9);
      this.spark.spawn(
        p.x, p.y, p.z,
        dir.x * sp + rnd(-1.5, 1.5), dir.y * sp + rnd(-1.5, 1.5), dir.z * sp + rnd(-1.5, 1.5),
        rnd(0.07, 0.15), rnd(0.16, 0.26), 0.02, hot, cool, 6, 4, NaN, 0,
      );
    }
  }

  /** Grenade / dash / blink trail: a couple of faint colored sparks. */
  trail(p: { x: number; y: number; z: number }, color: number, n = 2) {
    const c = TMP.setHex(color), c2 = TMP2.setHex(color).multiplyScalar(0.3);
    for (let i = 0; i < n; i++) {
      this.spark.spawn(p.x + rnd(-0.1, 0.1), p.y + rnd(-0.1, 0.1), p.z + rnd(-0.1, 0.1), rnd(-0.6, 0.6), rnd(-0.3, 0.6), rnd(-0.6, 0.6), rnd(0.25, 0.5), 0.22, 0.02, c, c2, 1, 1.2, NaN, 0);
    }
  }

  /** Footstep puff under the feet. */
  footstep(p: { x: number; y: number; z: number }) {
    const dust = TMP.setHex(0x70758a);
    for (let i = 0; i < 3; i++) {
      this.smoke.spawn(p.x + rnd(-0.2, 0.2), p.y + 0.05, p.z + rnd(-0.2, 0.2), rnd(-0.5, 0.5), rnd(0.2, 0.7), rnd(-0.5, 0.5), rnd(0.25, 0.45), 0.18, 0.5, dust, dust, 1.5, 2, NaN, 0);
    }
  }

  /** Jump-pad launch burst. */
  pad(p: { x: number; y: number; z: number }, color = 0x18e0ff) {
    const c = TMP.setHex(color), c2 = TMP2.setHex(color).multiplyScalar(0.2);
    for (let i = 0; i < 18; i++) {
      this.spark.spawn(p.x + rnd(-0.6, 0.6), p.y + 0.1, p.z + rnd(-0.6, 0.6), rnd(-2, 2), rnd(5, 12), rnd(-2, 2), rnd(0.3, 0.6), 0.25, 0.02, c, c2, 12, 1, p.y, 0.3);
    }
    this.rings.emit(p.x, p.y, p.z, color, 0.5, 4, 0.4);
  }

  /** Death dissolve: an intense burst in the victim's hue that drifts upward
   * and fades out slowly (low gravity + long life). */
  death(p: { x: number; y: number; z: number }, hueHex: number) {
    const c = TMP.setHex(hueHex), c2 = TMP2.setHex(hueHex).multiplyScalar(0.5);
    for (let i = 0; i < 44; i++) {
      this.spark.spawn(
        p.x + rnd(-0.3, 0.3), p.y + rnd(0.4, 1.4), p.z + rnd(-0.3, 0.3),
        rnd(-2.5, 2.5), rnd(4, 11), rnd(-2.5, 2.5),
        rnd(1.6, 2.6), 0.44, 0.08, c, c2, 3, 0.5, NaN, 0,
      );
    }
  }

  /** Spawn / teleport-in pop in a player's hue. */
  spawnBurst(p: { x: number; y: number; z: number }, hueHex: number) {
    const c = TMP.setHex(hueHex), c2 = TMP2.setHex(0xffffff);
    for (let i = 0; i < 20; i++) {
      const ang = (i / 20) * Math.PI * 2;
      this.spark.spawn(p.x, p.y + 1, p.z, Math.cos(ang) * rnd(2, 5), rnd(2, 6), Math.sin(ang) * rnd(2, 5), rnd(0.35, 0.6), 0.26, 0.02, c2, c, 10, 2, p.y, 0.2);
    }
    this.rings.emit(p.x, p.y, p.z, hueHex, 0.4, 3, 0.4);
  }

  /** Grenade explosion / flash / siphon — a layered burst + AoE ring. */
  explosion(p: { x: number; y: number; z: number }, kind: "frag" | "flash" | "siphon", radius: number) {
    if (kind === "flash") {
      const w = TMP.setHex(0xffffff), wc = TMP2.setHex(0xbfe6ff);
      for (let i = 0; i < 34; i++) {
        this.spark.spawn(p.x, p.y, p.z, rnd(-10, 10), rnd(-4, 12), rnd(-10, 10), rnd(0.3, 0.6), 0.5, 0.05, w, wc, 10, 1.6, NaN, 0);
      }
      this.rings.emit(p.x, p.y, p.z, 0xffffff, 0.5, radius * 0.7, 0.55);
      return;
    }
    if (kind === "siphon") {
      const c = TMP.setHex(0xff1f4f), c2 = TMP2.setHex(0x33000a);
      // Inward-drawn "drain" sparks from the rim toward the center.
      for (let i = 0; i < 26; i++) {
        const ang = Math.random() * Math.PI * 2, r = radius * 0.9;
        this.spark.spawn(p.x + Math.cos(ang) * r, p.y + rnd(0.3, 2), p.z + Math.sin(ang) * r, -Math.cos(ang) * rnd(5, 10), rnd(1, 4), -Math.sin(ang) * rnd(5, 10), rnd(0.3, 0.6), 0.26, 0.02, c, c2, 2, 1.2, NaN, 0);
      }
      this.rings.emit(p.x, p.y, p.z, 0xff1f4f, radius, 0.5, 0.5);
      return;
    }
    // frag: core flash + embers + smoke + shockwave ring.
    const hot = TMP.setHex(0xfff1c0), cool = TMP2.setHex(0xff3a18);
    for (let i = 0; i < 40; i++) {
      const sp = rnd(5, 18);
      const ang = Math.random() * Math.PI * 2, up = rnd(-0.4, 1);
      const hr = Math.sqrt(1 - Math.min(1, up * up));
      this.spark.spawn(p.x, p.y, p.z, Math.cos(ang) * hr * sp, up * sp + rnd(0, 4), Math.sin(ang) * hr * sp, rnd(0.3, 0.7), 0.4, 0.03, hot, cool, 16, 1.4, p.y, 0.25);
    }
    const smoke = TMP.setHex(0x3a3a44);
    for (let i = 0; i < 9; i++) {
      this.smoke.spawn(p.x + rnd(-1, 1), p.y + rnd(0, 1.5), p.z + rnd(-1, 1), rnd(-1.5, 1.5), rnd(1, 3), rnd(-1.5, 1.5), rnd(0.8, 1.4), 0.4, 1.6, smoke, smoke, 1, 0.8, NaN, 0);
    }
    this.rings.emit(p.x, p.y, p.z, 0xff7a3d, 0.6, radius, 0.45);
  }
}
