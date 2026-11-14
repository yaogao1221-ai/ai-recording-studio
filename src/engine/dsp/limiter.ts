import { TruePeakDetector } from './oversampler';
import { dbToGain, timeCoef } from './util';

export interface LimiterParams { ceiling: number; release: number; lookahead: number; inputGain: number; truePeak: boolean }

/**
 * Look-ahead brickwall limiter.
 * gain request -> sliding minimum over the look-ahead window -> release smoothing
 * -> moving-average (same length) -> applied to the delayed signal.
 * Because every smoothed value is <= the minimum that covers the peak, the
 * sample peak of the output never exceeds the ceiling.
 */
export class Limiter {
  p: LimiterParams = { ceiling: -1, release: 80, lookahead: 5, inputGain: 0, truePeak: true };
  private L = 0;
  private delay: Float32Array[] = [];
  private req!: Float32Array; // ring of gain requests
  private avg!: Float32Array; // ring for moving average
  private pos = 0;
  private avgSum = 0;
  private rel = 1;
  private aR = 0;
  private tp = new TruePeakDetector(4);
  grPeak = 0;
  constructor(private sr: number) { this.alloc(); }
  get latency(): number { return this.L; }
  set(p: Partial<LimiterParams>): void {
    const la = this.p.lookahead;
    Object.assign(this.p, p);
    if (p.lookahead !== undefined && p.lookahead !== la) this.alloc();
    this.aR = timeCoef(this.p.release, this.sr);
  }
  private alloc(): void {
    this.L = Math.max(1, Math.round((this.p.lookahead / 1000) * this.sr));
    this.delay = [new Float32Array(this.L + 1), new Float32Array(this.L + 1)];
    this.req = new Float32Array(this.L + 1).fill(1);
    this.avg = new Float32Array(this.L + 1).fill(1);
    this.avgSum = this.L + 1;
    this.pos = 0; this.rel = 1;
    this.aR = timeCoef(this.p.release, this.sr);
  }
  reset(): void { this.alloc(); this.tp.reset(); }
  process(Lb: Float32Array, Rb: Float32Array, n: number): void {
    const p = this.p;
    const ceil = dbToGain(p.ceiling);
    const ing = dbToGain(p.inputGain);
    const N = this.L + 1;
    let grMax = this.grPeak;
    for (let i = 0; i < n; i++) {
      const l = Lb[i] * ing, r = Rb[i] * ing;
      let pk: number;
      if (p.truePeak) pk = Math.max(this.tp.tick(l, 0), this.tp.tick(r, 1));
      else pk = Math.max(Math.abs(l), Math.abs(r));
      const g = pk > ceil ? ceil / pk : 1;
      this.req[this.pos] = g;
      // sliding min over window (N is small: a few hundred samples)
      let m = 1;
      for (let k = 0; k < N; k++) if (this.req[k] < m) m = this.req[k];
      // release smoothing (instant attack)
      this.rel = m < this.rel ? m : this.aR * this.rel + (1 - this.aR) * m;
      // moving average
      this.avgSum += this.rel - this.avg[this.pos];
      this.avg[this.pos] = this.rel;
      const gain = this.avgSum / N;
      const dl = this.delay[0], dr = this.delay[1];
      dl[this.pos] = l; dr[this.pos] = r;
      const rd = (this.pos + 1) % N; // sample written L samples ago
      const outL = dl[rd], outR = dr[rd];
      this.pos = rd;
      let yl = outL * gain, yr = outR * gain;
      // final safety clamp against float rounding of the moving average
      if (yl > ceil) yl = ceil; else if (yl < -ceil) yl = -ceil;
      if (yr > ceil) yr = ceil; else if (yr < -ceil) yr = -ceil;
      Lb[i] = yl; Rb[i] = yr;
      const grDb = gain < 1 ? -20 * Math.log10(gain) : 0;
      if (grDb > grMax) grMax = grDb;
    }
    this.grPeak = grMax;
  }
}

export interface ClipperParams { ceiling: number; softness: number; inputGain: number }

/** Sample clipper with optional soft knee (softness 0 = hard clip). */
export class Clipper {
  p: ClipperParams = { ceiling: -0.3, softness: 0.2, inputGain: 0 };
  grPeak = 0;
  set(p: Partial<ClipperParams>): void { Object.assign(this.p, p); }
  reset(): void {}
  process(L: Float32Array, R: Float32Array, n: number): void {
    const c = dbToGain(this.p.ceiling);
    const ing = dbToGain(this.p.inputGain);
    const k = Math.min(Math.max(this.p.softness, 0), 0.99);
    const knee = c * (1 - k);
    let grMax = this.grPeak;
    const clip = (x: number): number => {
      const a = Math.abs(x);
      if (a <= knee) return x;
      const range = c - knee;
      const y = range <= 0 ? c : knee + range * Math.tanh((a - knee) / range);
      const gr = 20 * Math.log10(a / y);
      if (gr > grMax) grMax = gr;
      return x < 0 ? -y : y;
    };
    for (let i = 0; i < n; i++) { L[i] = clip(L[i] * ing); R[i] = clip(R[i] * ing); }
    this.grPeak = grMax;
  }
}
