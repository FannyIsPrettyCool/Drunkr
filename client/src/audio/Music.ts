/**
 * Background music player. Streams a single mixed MP3 and shuffles between
 * 24 songs by seeking to their start timecodes. Connect to the shared
 * AudioContext via connectContext() so the game's volume graph applies.
 */

interface SongDef {
  startSec: number;
}

const SONGS: SongDef[] = [
  { startSec: 0 },
  { startSec: 3 * 60 + 8 },
  { startSec: 4 * 60 + 41 },
  { startSec: 5 * 60 + 52 },
  { startSec: 7 * 60 + 45 },
  { startSec: 10 * 60 + 42 },
  { startSec: 12 * 60 + 57 },
  { startSec: 15 * 60 + 35 },
  { startSec: 17 * 60 + 32 },
  { startSec: 19 * 60 + 54 },
  { startSec: 22 * 60 + 22 },
  { startSec: 25 * 60 + 12 },
  { startSec: 27 * 60 + 44 },
  { startSec: 31 * 60 + 58 },
  { startSec: 39 * 60 + 57 },
  { startSec: 42 * 60 + 52 },
  { startSec: 44 * 60 + 32 },
  { startSec: 46 * 60 + 5 },
  { startSec: 48 * 60 + 39 },
  { startSec: 50 * 60 + 41 },
  { startSec: 52 * 60 + 29 },
  { startSec: 55 * 60 + 14 },
  { startSec: 56 * 60 + 25 },
  { startSec: 64 * 60 + 25 },
];

const TOTAL_SEC = 69 * 60;

export class Music {
  private audio: HTMLAudioElement;
  private gainNode: GainNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;

  private order: number[] = [];
  private orderPos = 0;
  private currentIdx = -1;
  private songEndSec = 0;
  private lastChange = 0;
  private started = false;

  enabled: boolean;
  volume: number;

  constructor(enabled: boolean, volume: number) {
    this.enabled = enabled;
    this.volume = volume;

    this.audio = new Audio("/assets/moozik.mp3");
    this.audio.preload = "metadata";
    this.audio.loop = false;
    this.audio.volume = enabled ? volume : 0;

    this.audio.addEventListener("timeupdate", () => {
      if (Date.now() - this.lastChange < 3000) return;
      if (this.audio.currentTime >= this.songEndSec - 0.8) this.nextSong();
    });
    this.audio.addEventListener("ended", () => this.nextSong());

    this.shuffleOrder();
  }

  /** Wire into the game's AudioContext so master volume applies. Call once. */
  connectContext(ctx: AudioContext) {
    if (this.source) return;
    try {
      this.source = ctx.createMediaElementSource(this.audio);
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this.enabled ? this.volume * 0.5 : 0;
      this.source.connect(this.gainNode).connect(ctx.destination);
      this.audio.volume = 1; // volume now controlled by gainNode
    } catch {
      // Already connected or not supported; fall back to audio.volume
    }
  }

  /** Begin shuffled playback. Safe to call multiple times (idempotent). */
  start() {
    if (this.started) return;
    this.started = true;
    this.nextSong();
  }

  setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.gainNode) {
      this.gainNode.gain.value = this.enabled ? this.volume * 0.5 : 0;
    } else {
      this.audio.volume = this.enabled ? this.volume : 0;
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.gainNode) {
      this.gainNode.gain.value = on ? this.volume : 0;
    } else {
      this.audio.volume = on ? this.volume : 0;
    }
    if (on && this.started && this.audio.paused) this.nextSong();
    if (!on) this.audio.pause();
  }

  private shuffleOrder() {
    this.order = Array.from({ length: SONGS.length }, (_, i) => i);
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.orderPos = 0;
  }

  private nextSong() {
    if (!this.enabled) return;
    if (this.orderPos >= this.order.length) this.shuffleOrder();
    this.currentIdx = this.order[this.orderPos++];
    const song = SONGS[this.currentIdx];
    this.songEndSec = this.currentIdx + 1 < SONGS.length
      ? SONGS[this.currentIdx + 1].startSec
      : TOTAL_SEC;
    this.lastChange = Date.now();
    this.seekAndPlay(song.startSec);
  }

  private seekAndPlay(startSec: number) {
    const doPlay = () => {
      this.audio.currentTime = startSec;
      this.audio.play().catch(() => {});
    };
    if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      doPlay();
    } else {
      this.audio.addEventListener("loadedmetadata", doPlay, { once: true });
    }
  }
}
