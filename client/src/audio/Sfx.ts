/**
 * Sound engine: preloads game audio from /assets/, plays local sounds through
 * the master GainNode, and spatialises remote/world sounds with a PannerNode.
 * All audio files are fetched immediately and decoded once the AudioContext
 * is created (on first user gesture).
 */

/** Per-sound panner overrides — explosions use a wider/louder falloff so they
 * carry across the map instead of going quiet a few metres away. */
interface PannerOpts { ref?: number; max?: number; rolloff?: number; }

/** Wide falloff shared by all explosions: audible from much farther off. */
const BOOM_PAN: PannerOpts = { ref: 10, max: 240, rolloff: 0.9 };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** Lowpass on the master bus — normally transparent; dipped for flash tinnitus. */
  private muffle!: BiquadFilterNode;
  private buffers = new Map<string, AudioBuffer>();
  private raw = new Map<string, ArrayBuffer>();
  private ambienceEl: HTMLAudioElement | null = null;
  enabled = true;
  /** Master SFX volume (0–1); applied to the master gain (set lazily). */
  private volume = 0.8;
  /** Optional "is a wall between the listener and this point" test (set by Game).
   * Spatial sounds that fail it get low-passed so they sound muffled through cover. */
  private occludes?: (x: number, y: number, z: number) => boolean;

  constructor() {
    const files = [
      'AK.wav', 'beep.wav', 'blink.wav', 'bloodlust.wav', 'bullet_impact.wav', 'cloak.wav',
      'confuse.wav', 'dash.wav', 'death.wav', 'decoy.wav', 'flash.wav', 'footstep.wav',
      'fortify.wav', 'frag_grenade.wav', 'grapple.wav', 'headshot.wav', 'hit.wav', 'jump.wav',
      'kill.wav', 'land_slide.wav', 'melee.wav', 'menu_click.wav', 'pad.wav', 'planted.wav',
      'pull.wav', 'recall.wav', 'reflect.wav', 'reload.wav', 'reload_sniper.wav', 'repulse.wav',
      'shockwave.wav', 'shotgun.wav', 'siphon.wav', 'slipstream.wav', 'sniper.wav',
      'timebubble.wav', 'updraft.wav', 'wallkick.wav',
    ];
    for (const f of files) {
      fetch(`/assets/${f}`)
        .then(r => r.arrayBuffer())
        .then(ab => {
          if (this.ctx) {
            void this.ctx.decodeAudioData(ab, buf => this.buffers.set(f, buf));
          } else {
            this.raw.set(f, ab);
          }
        })
        .catch(() => {});
    }
  }

  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      // master → muffle (lowpass) → speakers. The lowpass sits wide open at
      // 20 kHz (inaudible effect) until a flash dips it for the tinnitus muffle.
      this.muffle = this.ctx.createBiquadFilter();
      this.muffle.type = 'lowpass';
      this.muffle.frequency.value = 20000;
      this.master.connect(this.muffle);
      this.muffle.connect(this.ctx.destination);
      for (const [name, ab] of this.raw) {
        void this.ctx.decodeAudioData(ab, buf => this.buffers.set(name, buf));
      }
      this.raw.clear();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  getContext(): AudioContext | null { return this.ctx; }

  /** Register a "wall between listener and point" test for sound occlusion. */
  setOcclusionTest(fn: (x: number, y: number, z: number) => boolean) {
    this.occludes = fn;
  }

  /** Set the master SFX volume (0–1). Safe to call before audio starts. */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** Update the 3D audio listener to match the camera each frame. */
  updateListener(px: number, py: number, pz: number, fwdX: number, fwdY: number, fwdZ: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setValueAtTime(px, t);
      L.positionY.setValueAtTime(py, t);
      L.positionZ.setValueAtTime(pz, t);
      L.forwardX.setValueAtTime(fwdX, t);
      L.forwardY.setValueAtTime(fwdY, t);
      L.forwardZ.setValueAtTime(fwdZ, t);
      L.upX.setValueAtTime(0, t);
      L.upY.setValueAtTime(1, t);
      L.upZ.setValueAtTime(0, t);
    } else {
      (L as unknown as { setPosition(...a: number[]): void }).setPosition(px, py, pz);
      (L as unknown as { setOrientation(...a: number[]): void }).setOrientation(fwdX, fwdY, fwdZ, 0, 1, 0);
    }
  }

  private ready(): boolean {
    return this.enabled && !!this.ctx && this.ctx.state === 'running';
  }

  private makePanner(x: number, y: number, z: number, opts?: PannerOpts): PannerNode | null {
    if (!this.ready()) return null;
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = opts?.ref ?? 4;
    p.maxDistance = opts?.max ?? 80;
    p.rolloffFactor = opts?.rolloff ?? 1.4;
    const t = ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else {
      (p as unknown as { setPosition(...a: number[]): void }).setPosition(x, y, z);
    }
    p.connect(this.master);
    return p;
  }

  private play(name: string, gain = 1.0, pitchMod = 1.0): void {
    const buf = this.buffers.get(name);
    if (!buf || !this.ready()) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitchMod;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
  }

  private playAt(name: string, x: number, y: number, z: number, gain = 1.0, opts?: PannerOpts): void {
    const buf = this.buffers.get(name);
    const panner = this.makePanner(x, y, z, opts);
    if (!buf || !panner) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    // Occlusion: if a wall sits between the listener and the source, route it
    // through a lowpass and drop the volume so it sounds muffled through cover.
    if (this.occludes?.(x, y, z)) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 620;
      g.gain.value = gain * 0.55;
      src.connect(g).connect(lp).connect(panner);
    } else {
      src.connect(g).connect(panner);
    }
    src.start();
  }

  // ---- Ambient -------------------------------------------------------

  startAmbience() {
    if (this.ambienceEl) return;
    this.ambienceEl = new Audio('/assets/ambience.wav');
    this.ambienceEl.loop = true;
    this.ambienceEl.volume = 0.12;
    void this.ambienceEl.play().catch(() => {});
  }

  // ---- Local game sounds ---------------------------------------------

  shoot(weapon: string) {
    switch (weapon) {
      case 'sniper':  this.play('sniper.wav', 0.85); break;
      case 'shotgun': this.play('shotgun.wav', 0.9); break;
      case 'katana':  this.play('melee.wav', 0.7); break;
      default:        this.play('AK.wav', 0.7);
    }
  }

  reload(weaponId = '') {
    this.play(weaponId === 'sniper' ? 'reload_sniper.wav' : 'reload.wav', 0.8);
  }

  hit(head: boolean) { this.play(head ? 'headshot.wav' : 'hit.wav', 0.95); }
  kill()             { this.play('kill.wav', 1.0); }
  death()            { this.play('death.wav', 1.0); }
  jump()             { this.play('jump.wav', 0.55); }
  land()             { this.play('land_slide.wav', 0.75); }
  slide()            { this.play('land_slide.wav', 0.5, 0.85); }
  dash()             { this.play('dash.wav', 0.8); }
  switchWeapon()     { this.play('menu_click.wav', 0.5); }
  footstep()         { this.play('footstep.wav', 0.28 + Math.random() * 0.12, 0.92 + Math.random() * 0.16); }

  // ---- Ability sounds ------------------------------------------------

  pad()          { this.play('pad.wav', 1.0); }
  blink()        { this.play('blink.wav', 0.8); }
  cloak()        { this.play('cloak.wav', 0.8); }
  confuse()      { this.play('confuse.wav', 0.8); }
  flashAbility() { this.play('flash.wav', 0.9); }
  fragThrow()    { this.play('frag_grenade.wav', 0.45); }
  updraft()      { this.play('updraft.wav', 0.7); }
  fortify()      { this.play('fortify.wav', 0.8); }
  shockwave()    { this.play('shockwave.wav', 1.0); }
  // Newer abilities — each now has its own asset (was sharing the ones above).
  bloodlust()    { this.play('bloodlust.wav', 0.85); }
  siphon()       { this.play('siphon.wav', 0.9); }
  grapple()      { this.play('grapple.wav', 0.8); }
  wallkick()     { this.play('wallkick.wav', 0.8); }
  slipstream()   { this.play('slipstream.wav', 0.8); }
  recall()       { this.play('recall.wav', 0.9); }
  timebubble()   { this.play('timebubble.wav', 0.8); }
  pull()         { this.play('pull.wav', 0.9); }
  reflect()      { this.play('reflect.wav', 0.85); }
  repulse()      { this.play('repulse.wav', 1.0); }
  decoy()        { this.play('decoy.wav', 0.85); }

  /** Flash-bang tinnitus: muffle everything + a fading high ring for `ms`. */
  tinnitus(ms: number) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const secs = Math.max(0.5, ms / 1000);
    // Dip the master lowpass right down, hold, then open back up.
    const f = this.muffle.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.linearRampToValueAtTime(480, t + 0.05);
    f.setValueAtTime(480, t + secs * 0.55);
    f.exponentialRampToValueAtTime(20000, t + secs);
    // High ringing tone (bypasses the muffle so it cuts through), fading out.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(8200, t);
    osc.frequency.linearRampToValueAtTime(7400, t + secs);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * this.volume, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0006, t + secs);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + secs + 0.05);
  }

  // ---- Bomb sounds ---------------------------------------------------

  bombTick()        { this.play('beep.wav', 0.9); }
  bombPlanted()     { this.play('planted.wav', 1.0); }
  bombDefused()     { this.play('blink.wav', 0.9); }
  bombDefusing()    { this.play('menu_click.wav', 0.5); }

  // ---- Spatial (world) sounds ----------------------------------------

  remoteShootAt(weapon: string, x: number, y: number, z: number) {
    switch (weapon) {
      case 'sniper':  this.playAt('sniper.wav', x, y, z, 1.0); break;
      case 'shotgun': this.playAt('shotgun.wav', x, y, z, 1.0); break;
      case 'katana':  this.playAt('melee.wav', x, y, z, 0.8); break;
      default:        this.playAt('AK.wav', x, y, z, 1.0);
    }
  }

  bulletImpact(x: number, y: number, z: number) {
    this.playAt('bullet_impact.wav', x, y, z, 0.65);
  }

  /** Frag / shockwave explosion — loud and carries far across the map. */
  boomAt(x: number, y: number, z: number) {
    this.playAt('frag_grenade.wav', x, y, z, 1.6, BOOM_PAN);
  }

  /** Flash-grenade detonation, positioned in the world (its own pop, not a frag). */
  flashBoomAt(x: number, y: number, z: number) {
    this.playAt('flash.wav', x, y, z, 1.3, BOOM_PAN);
  }

  /** Mirage decoy pop: the flash bang plus a softer explosion thump. */
  decoyBurstAt(x: number, y: number, z: number) {
    this.playAt('flash.wav', x, y, z, 1.3, BOOM_PAN);
    this.playAt('frag_grenade.wav', x, y, z, 0.95, { ref: 8, max: 180, rolloff: 1.0 });
  }

  /** Vampire Siphon drain pulse, positioned in the world. */
  drainAt(x: number, y: number, z: number) {
    this.playAt('siphon.wav', x, y, z, 0.9);
  }
}
