import { Biquad, designBiquad } from './biquad';
import { dbToGain, timeCoef } from './util';

export interface ImagerParams { width: number; monoBass: number }

/** Mid/side stereo width with optional mono-below-frequency. width: 0 = mono, 1 = unchanged, 2 = wide. */
export class StereoImager {
  p: ImagerParams = { width: 1, monoBass: 0 };
  private hp = new Biquad();
  constructor(private sr: number) { this.update(); }
  set(p: Partial<ImagerParams>): void { Object.assign(this.p, p); this.update(); }
  private update(): void { if (this.p.monoBass > 0) this.hp.set(designBiquad('highpass', this.p.monoBass, 0.707, 0, this.sr)); }
  reset(): void { this.hp.reset(); }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const w = this.p.width;
    const mb = this.p.monoBass > 0;
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5;
      let s = (L[i] - R[i]) * 0.5;
      if (mb) s = this.hp.tick(s, 0);
      s *= w;
      L[i] = m + s; R[i] = m - s;
    }
  }
}

export interface TransientParams { attack: number; sustain: number; output: number }

/** Envelope-difference transient shaper (fast vs slow follower). attack/sustain in dB (-12..+12). */
export class TransientShaper {
  p: TransientParams = { attack: 0, sustain: 0, output: 0 };
  private fast = 0; private slow = 0; private aF: number; private aS: number; private rel: number;
  constructor(sr: number) { this.aF = timeCoef(1, sr); this.aS = timeCoef(30, sr); this.rel = timeCoef(150, sr); }
  set(p: Partial<TransientParams>): void { Object.assign(this.p, p); }
  reset(): void { this.fast = 0; this.slow = 0; }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.p; const out = dbToGain(p.output);
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.fast = a > this.fast ? this.aF * this.fast + (1 - this.aF) * a : this.rel * this.fast + (1 - this.rel) * a;
      this.slow = a > this.slow ? this.aS * this.slow + (1 - this.aS) * a : this.rel * this.slow + (1 - this.rel) * a;
      // > 0 during attacks, < 0 during sustain/decay
      const d = this.slow > 1e-6 ? Math.max(-1, Math.min(1, (this.fast - this.slow) / this.slow)) : 0;
      const db = d > 0 ? d * p.attack : -d * p.sustain;
      const g = dbToGain(db) * out;
      L[i] *= g; R[i] *= g;
    }
  }
}

/** Running phase correlation (-1..+1). */
export class Correlation {
  private lr = 0; private ll = 0; private rr = 0; private a: number;
  constructor(sr: number, ms = 300) { this.a = timeCoef(ms, sr); }
  process(L: Float32Array, R: Float32Array, n: number): number {
    const a = this.a, b = 1 - a;
    for (let i = 0; i < n; i++) {
      this.lr = a * this.lr + b * L[i] * R[i];
      this.ll = a * this.ll + b * L[i] * L[i];
      this.rr = a * this.rr + b * R[i] * R[i];
    }
    const d = Math.sqrt(this.ll * this.rr);
    return d < 1e-12 ? 0 : this.lr / d;
  }
}
