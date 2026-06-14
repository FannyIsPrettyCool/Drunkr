/**
 * Tiny procedural sound engine. Everything is synthesised with the Web Audio
 * API at runtime — no asset files, no licensing. Call `resume()` from a user
 * gesture (pointer lock) before sounds will play.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuffer!: AudioBuffer;
  enabled = true;

  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private now() {
    return this.ctx!.currentTime;
  }

  /** A short oscillator with an exponential decay envelope. */
  private tone(
    freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number,
  ) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = this.now();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A filtered noise burst. */
  private noise(dur: number, gain: number, filterFreq: number, type: BiquadFilterType = "bandpass", q = 1) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = this.now();
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = filterFreq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private ready(): boolean {
    return this.enabled && !!this.ctx && this.ctx.state === "running";
  }

  // --- Game sounds ---------------------------------------------------------

  shoot(weapon: string) {
    switch (weapon) {
      case "sniper":
        this.tone(180, 0.18, "sawtooth", 0.5, 60);
        this.noise(0.12, 0.4, 2600, "highpass");
        break;
      case "shotgun":
        this.noise(0.22, 0.6, 900, "lowpass");
        this.tone(90, 0.2, "square", 0.4, 40);
        break;
      case "katana":
        this.noise(0.14, 0.25, 3200, "bandpass", 4);
        this.tone(1400, 0.12, "triangle", 0.12, 2600);
        break;
      default: // ak
        this.noise(0.07, 0.35, 1800, "bandpass", 0.8);
        this.tone(140, 0.08, "square", 0.3, 70);
    }
  }

  /** A quieter version of another player's shot. */
  remoteShoot(weapon: string) {
    const e = this.enabled;
    if (this.ctx) this.master.gain.value = 0.16;
    this.shoot(weapon);
    if (this.ctx) this.master.gain.value = 0.35;
    this.enabled = e;
  }

  hit(head: boolean) {
    this.tone(head ? 1500 : 900, 0.06, "square", 0.25, head ? 2000 : 1100);
  }

  kill() {
    this.tone(800, 0.18, "triangle", 0.3, 200);
  }

  reload() {
    this.tone(420, 0.05, "square", 0.18);
    setTimeout(() => this.tone(300, 0.07, "square", 0.18), 140);
  }

  jump() {
    this.tone(520, 0.09, "sine", 0.18, 900);
  }

  land() {
    this.tone(160, 0.08, "sine", 0.2, 70);
  }

  slide() {
    this.noise(0.4, 0.25, 1200, "lowpass");
  }

  dash() {
    this.tone(300, 0.18, "sawtooth", 0.25, 1200);
    this.noise(0.18, 0.2, 1600, "bandpass");
  }

  switchWeapon() {
    this.tone(600, 0.04, "square", 0.12);
  }

  death() {
    this.tone(400, 0.5, "sawtooth", 0.3, 60);
  }
}
