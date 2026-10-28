import type { SurfaceKind } from './tagging';

/**
 * Tiny synthesized impact sounds: a filtered noise "thunk" whose brightness depends on the
 * surface and size, and whose loudness follows the impact force. M toggles mute (remembered).
 */
export class Impacts {
  private ctx?: AudioContext;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private lastByKey = new Map<string, number>();
  private recent: number[] = [];
  muted = false;
  volume = 0.5;

  constructor() {
    try {
      this.muted = localStorage.getItem('play-muted') === '1';
    } catch {
      /* storage unavailable */
    }
  }

  /** browsers only allow audio after a user gesture */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = undefined;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    try {
      localStorage.setItem('play-muted', this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    return this.muted;
  }

  /**
   * @param strength 0..1 (already normalized by mass)
   * @param size largest side of the object, m
   */
  hit(key: string, surface: SurfaceKind, strength: number, size: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted || ctx.state !== 'running') return;
    const s = Math.min(1, Math.max(0, strength));
    if (!Number.isFinite(s) || s < 0.04) return;
    const now = ctx.currentTime;
    const t = performance.now();
    if (t - (this.lastByKey.get(key) ?? 0) < 250) return;
    this.recent = this.recent.filter((x) => t - x < 1000);
    if (this.recent.length > 14) return; // an avalanche: don't turn it into white noise
    this.lastByKey.set(key, t);
    this.recent.push(t);

    const gain = ctx.createGain();
    const peak = 0.08 + s * 0.6;
    const sizeK = Math.min(1, Math.max(0, size / 0.6));
    const P: Record<SurfaceKind, { f: number; q: number; decay: number; type: BiquadFilterType; tone?: number }> = {
      soft: { f: 260, q: 0.5, decay: 0.06, type: 'lowpass' },
      rubber: { f: 700, q: 2, decay: 0.07, type: 'bandpass', tone: 190 },
      wood: { f: 1300 - sizeK * 700, q: 3, decay: 0.09, type: 'bandpass', tone: 150 - sizeK * 60 },
      cardboard: { f: 600 - sizeK * 250, q: 1, decay: 0.07, type: 'lowpass' },
      plastic: { f: 1700 - sizeK * 900, q: 2.5, decay: 0.06, type: 'bandpass' },
      metal: { f: 2600 - sizeK * 1200, q: 9, decay: 0.22, type: 'bandpass', tone: 520 - sizeK * 250 },
      glass: { f: 3200, q: 10, decay: 0.16, type: 'bandpass', tone: 1400 },
      stone: { f: 900, q: 2, decay: 0.08, type: 'bandpass', tone: 110 },
    };
    const p = P[surface];
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = p.type;
    filter.frequency.value = p.f * (0.9 + Math.random() * 0.2);
    filter.Q.value = p.q;
    const decay = p.decay * (0.7 + sizeK * 0.8);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak * (surface === 'soft' ? 0.5 : 1), now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + decay);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + decay + 0.02);
    if (p.tone) {
      // a short pitched body for wood / metal / rubber
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p.tone * 1.25, now);
      osc.frequency.exponentialRampToValueAtTime(p.tone, now + decay);
      og.gain.setValueAtTime(0, now);
      og.gain.linearRampToValueAtTime(peak * 0.35, now + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0005, now + decay * 1.2);
      osc.connect(og).connect(this.master);
      osc.start(now);
      osc.stop(now + decay * 1.2 + 0.02);
    }
  }
}
