import { Biquad, designBiquad } from './biquad';
import { dbToGain, gainToDb, timeCoef } from './util';

/** Static gain computer with soft knee. Returns output level in dB for input level x (dB). */
export function compressorCurve(x: number, threshold: number, ratio: number, knee: number): number {
  const d = x - threshold;
  if (knee > 0 && 2 * Math.abs(d) <= knee) {
    return x + ((1 / ratio - 1) * (d + knee / 2) ** 2) / (2 * knee);
  }
  if (2 * d < -knee) return x;
  return threshold + d / ratio;
}

export interface CompressorParams {
  threshold: number; ratio: number; attack: number; release: number; knee: number;
  makeup: number; autoMakeup: boolean; mix: number; scHpf: number;
}

/**
 * Feed-forward stereo-linked compressor (peak detector, log-domain smoothing,
 * soft knee, optional sidechain high-pass, parallel mix).
 */
export class Compressor {
  p: CompressorParams = {
    threshold: -18, ratio: 3, attack: 10, release: 120, knee: 6, makeup: 0,
    autoMakeup: false, mix: 1, scHpf: 0,
  };
  private env = 0; // gain reduction in dB (>= 0)
  private aA = 0; private aR = 0;
  private sc = new Biquad();
  /** Max gain reduction (dB) since last read, for metering. */
  grPeak = 0;
  constructor(private sr: number) { this.update(); }
  set(p: Partial<CompressorParams>): void { Object.assign(this.p, p); this.update(); }
  private update(): void {
    this.aA = timeCoef(this.p.attack, this.sr);
    this.aR = timeCoef(this.p.release, this.sr);
    if (this.p.scHpf > 0) this.sc.set(designBiquad('highpass', this.p.scHpf, 0.707, 0, this.sr));
  }
  reset(): void { this.env = 0; this.sc.reset(); }
  makeupDb(): number {
    const p = this.p;
    if (!p.autoMakeup) return p.makeup;
    // compensate half the reduction a 0 dBFS-ish signal at threshold/2 would get
    const ref = p.threshold / 2;
    return p.makeup + (ref - compressorCurve(ref, p.threshold, p.ratio, p.knee)) * 0.5;
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.p;
    const mk = dbToGain(this.makeupDb());
    const useSc = p.scHpf > 0;
    let grMax = this.grPeak;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      let dl = l, dr = r;
      if (useSc) { dl = this.sc.tick(l, 0); dr = this.sc.tick(r, 1); }
      const lvl = Math.max(Math.abs(dl), Math.abs(dr));
      const xdb = gainToDb(lvl);
      const target = xdb - compressorCurve(xdb, p.threshold, p.ratio, p.knee);
      const a = target > this.env ? this.aA : this.aR;
      this.env = a * this.env + (1 - a) * target;
      if (this.env > grMax) grMax = this.env;
      const g = dbToGain(-this.env) * mk;
      L[i] = l * (1 - p.mix) + l * g * p.mix;
      R[i] = r * (1 - p.mix) + r * g * p.mix;
    }
    this.grPeak = grMax;
  }
}

export interface GateParams { threshold: number; ratio: number; range: number; attack: number; hold: number; release: number }

/** Downward expander / noise gate (ratio >= 20 behaves as a gate). */
export class Gate {
  p: GateParams = { threshold: -50, ratio: 4, range: 40, attack: 1, hold: 30, release: 150 };
  private det = 0; private g = 0; private holdCount = 0;
  private aA = 0; private aR = 0; private detR = 0;
  grPeak = 0;
  constructor(private sr: number) { this.update(); }
  set(p: Partial<GateParams>): void { Object.assign(this.p, p); this.update(); }
  private update(): void {
    this.aA = timeCoef(this.p.attack, this.sr);
    this.aR = timeCoef(this.p.release, this.sr);
    this.detR = timeCoef(5, this.sr);
  }
  reset(): void { this.det = 0; this.g = 0; this.holdCount = 0; }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.p;
    const holdN = (p.hold / 1000) * this.sr;
    let grMax = this.grPeak;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.det = a > this.det ? a : this.detR * this.det + (1 - this.detR) * a;
      const xdb = gainToDb(this.det);
      let target = 0; // reduction dB
      if (xdb >= p.threshold) this.holdCount = holdN;
      else if (this.holdCount > 0) this.holdCount--;
      else target = Math.min(p.range, (p.threshold - xdb) * (p.ratio - 1));
      const c = target < this.g ? this.aA : this.aR;
      this.g = c * this.g + (1 - c) * target;
      if (this.g > grMax) grMax = this.g;
      const gl = dbToGain(-this.g);
      L[i] *= gl; R[i] *= gl;
    }
    this.grPeak = grMax;
  }
}

export interface DeEsserParams { frequency: number; threshold: number; range: number; listen: boolean }

/**
 * Split-band de-esser on a 4th-order Linkwitz-Riley crossover: low + high sum
 * to an all-pass (flat magnitude), so with no reduction the tone is unchanged.
 * Only the high band is attenuated when its level exceeds the threshold.
 */
export class DeEsser {
  p: DeEsserParams = { frequency: 6500, threshold: -28, range: 10, listen: false };
  private hp = new Biquad(); private hp2 = new Biquad();
  private lp = new Biquad(); private lp2 = new Biquad();
  private env = 0; private g = 0;
  private aA: number; private aR: number;
  grPeak = 0;
  constructor(private sr: number) {
    this.aA = timeCoef(0.5, sr); this.aR = timeCoef(60, sr); this.update();
  }
  set(p: Partial<DeEsserParams>): void { Object.assign(this.p, p); this.update(); }
  private update(): void {
    const h = designBiquad('highpass', this.p.frequency, Math.SQRT1_2, 0, this.sr);
    const l = designBiquad('lowpass', this.p.frequency, Math.SQRT1_2, 0, this.sr);
    this.hp.set(h); this.hp2.set(h); this.lp.set(l); this.lp2.set(l);
  }
  reset(): void { [this.hp, this.hp2, this.lp, this.lp2].forEach((f) => f.reset()); this.env = 0; this.g = 0; }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.p;
    let grMax = this.grPeak;
    for (let i = 0; i < n; i++) {
      const hl = this.hp2.tick(this.hp.tick(L[i], 0), 0), hr = this.hp2.tick(this.hp.tick(R[i], 1), 1);
      const ll = this.lp2.tick(this.lp.tick(L[i], 0), 0), lr = this.lp2.tick(this.lp.tick(R[i], 1), 1);
      const a = Math.max(Math.abs(hl), Math.abs(hr));
      this.env = a > this.env ? this.aA * this.env + (1 - this.aA) * a : this.aR * this.env + (1 - this.aR) * a;
      const over = gainToDb(this.env) - p.threshold;
      const target = over > 0 ? Math.min(p.range, over) : 0;
      this.g = target > this.g ? target : this.aR * this.g + (1 - this.aR) * target;
      if (this.g > grMax) grMax = this.g;
      const k = dbToGain(-this.g);
      if (p.listen) { L[i] = hl; R[i] = hr; }
      else { L[i] = ll + hl * k; R[i] = lr + hr * k; }
    }
    this.grPeak = grMax;
  }
}
