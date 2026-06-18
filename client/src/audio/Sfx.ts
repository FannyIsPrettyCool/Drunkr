/**
 * Sound engine: preloads game audio from /assets/, plays local sounds through
 * the master GainNode, and spatialises remote/world sounds with a PannerNode.
 * All audio files are fetched immediately and decoded once the AudioContext
 * is created (on first user gesture).
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private raw = new Map<string, ArrayBuffer>();
  private ambienceEl: HTMLAudioElement | null = null;
  enabled = true;

  constructor() {
    const files = [
      'AK.wav', 'beep.wav', 'blink.wav', 'bullet_impact.wav', 'cloak.wav', 'confuse.wav',
      'dash.wav', 'death.wav', 'flash.wav', 'footstep.wav', 'fortify.wav',
      'frag_grenade.wav', 'headshot.wav', 'hit.wav', 'jump.wav', 'kill.wav',
      'land_slide.wav', 'melee.wav', 'menu_click.wav', 'pad.wav', 'planted.wav', 'reload.wav',
      'reload_sniper.wav', 'shockwave.wav', 'shotgun.wav', 'sniper.wav',
      'updraft.wav',
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
      this.master.gain.value = 1.0;
      this.master.connect(this.ctx.destination);
      for (const [name, ab] of this.raw) {
        void this.ctx.decodeAudioData(ab, buf => this.buffers.set(name, buf));
      }
      this.raw.clear();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  getContext(): AudioContext | null { return this.ctx; }

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

  private makePanner(x: number, y: number, z: number): PannerNode | null {
    if (!this.ready()) return null;
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.maxDistance = 80;
    p.rolloffFactor = 1.4;
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

  private playAt(name: string, x: number, y: number, z: number, gain = 1.0): void {
    const buf = this.buffers.get(name);
    const panner = this.makePanner(x, y, z);
    if (!buf || !panner) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(panner);
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

  boomAt(x: number, y: number, z: number) {
    this.playAt('frag_grenade.wav', x, y, z, 1.2);
  }

  /** Vampire Siphon drain pulse, positioned in the world. */
  drainAt(x: number, y: number, z: number) {
    this.playAt('shockwave.wav', x, y, z, 0.9);
  }
}
