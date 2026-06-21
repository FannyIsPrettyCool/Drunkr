/**
 * Screen-space "speed lines": white radial streaks over the 2D overlay canvas
 * that intensify as you move faster, giving an impression of speed/momentum.
 * Driven each frame from the local player's horizontal speed. The center is kept
 * clear (streaks fade toward the middle) so aiming isn't obscured.
 */

interface Streak {
  angle: number; // radial direction from screen center
  r: number;     // current inner radius (fraction of half-diagonal)
  len: number;   // streak length (fraction)
  w: number;     // line width (px)
}

export class SpeedLines {
  private canvas = document.getElementById("speedlines") as HTMLCanvasElement;
  private ctx = this.canvas.getContext("2d")!;
  private streaks: Streak[] = [];
  private w = 0;
  private h = 0;
  private intensity = 0;

  /** Speed (m/s) at which streaks start, and where they reach full intensity. */
  private threshold = 13;
  private maxSpeed = 32;

  constructor(pool = 70) {
    for (let i = 0; i < pool; i++) this.streaks.push(this.makeStreak(Math.random()));
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private makeStreak(r0 = 0): Streak {
    return {
      angle: Math.random() * Math.PI * 2,
      r: r0 * 1.1,
      len: 0.08 + Math.random() * 0.24,
      w: 1 + Math.random() * 1.6,
    };
  }

  private resize() {
    this.w = this.canvas.width = window.innerWidth;
    this.h = this.canvas.height = window.innerHeight;
  }

  update(dt: number, speed: number) {
    const target = Math.max(0, Math.min(1, (speed - this.threshold) / (this.maxSpeed - this.threshold)));
    // Ease intensity so streaks ramp in/out instead of popping.
    this.intensity += (target - this.intensity) * Math.min(1, dt * 6);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.intensity < 0.012) return;

    const cx = this.w / 2, cy = this.h / 2;
    const diag = Math.hypot(this.w, this.h) * 0.55;
    const active = Math.floor(this.streaks.length * (0.25 + 0.75 * this.intensity));
    const rate = 0.6 + 2.0 * this.intensity; // outward speed of the streaks
    ctx.lineCap = "round";

    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i];
      s.r += dt * rate;
      if (s.r > 1.12) {
        const n = this.makeStreak(0);
        s.angle = n.angle; s.r = Math.random() * 0.1; s.len = n.len; s.w = n.w;
      }
      if (i >= active) continue;
      const r0 = s.r;
      const r1 = Math.min(1.18, s.r + s.len);
      // Dim near the center (keep the reticle area clear) and at the far edge.
      const fade = Math.min(1, r0 / 0.28) * (1 - Math.max(0, (r0 - 0.9) / 0.3));
      const a = this.intensity * 0.5 * Math.max(0, fade);
      if (a <= 0.01) continue;
      const dx = Math.cos(s.angle), dy = Math.sin(s.angle);
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(cx + dx * r0 * diag, cy + dy * r0 * diag);
      ctx.lineTo(cx + dx * r1 * diag, cy + dy * r1 * diag);
      ctx.stroke();
    }
  }
}
