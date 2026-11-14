import { Biquad, BiquadCoefs, FilterType, biquadMagnitude, designBiquad } from './biquad';

export interface EqBand { on: boolean; type: FilterType; freq: number; gain: number; q: number }

export const defaultEqBands = (): EqBand[] => [
  { on: false, type: 'highpass', freq: 80, gain: 0, q: 0.707 },
  { on: true, type: 'lowshelf', freq: 120, gain: 0, q: 0.7 },
  { on: true, type: 'peaking', freq: 350, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 1500, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 4000, gain: 0, q: 1 },
  { on: true, type: 'highshelf', freq: 10000, gain: 0, q: 0.7 },
  { on: false, type: 'lowpass', freq: 18000, gain: 0, q: 0.707 },
];

/** N-band parametric EQ (cascaded RBJ biquads). */
export class ParametricEq {
  bands: EqBand[] = defaultEqBands();
  private filters: Biquad[] = [];
  private coefs: BiquadCoefs[] = [];
  output = 0;
  constructor(private sr: number) { this.update(); }
  setBands(b: EqBand[]): void {
    const resize = b.length !== this.filters.length;
    this.bands = b.map((x) => ({ ...x }));
    if (resize) this.filters = this.bands.map(() => new Biquad());
    this.update();
  }
  private update(): void {
    if (this.filters.length !== this.bands.length) this.filters = this.bands.map(() => new Biquad());
    this.coefs = this.bands.map((b) => designBiquad(b.type, b.freq, b.q, b.gain, this.sr));
    this.filters.forEach((f, i) => f.set(this.coefs[i]));
  }
  reset(): void { this.filters.forEach((f) => f.reset()); }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const out = Math.pow(10, this.output / 20);
    for (let k = 0; k < this.bands.length; k++) {
      if (!this.bands[k].on) continue;
      const f = this.filters[k];
      for (let i = 0; i < n; i++) { L[i] = f.tick(L[i], 0); R[i] = f.tick(R[i], 1); }
    }
    if (out !== 1) for (let i = 0; i < n; i++) { L[i] *= out; R[i] *= out; }
  }
}

/** Combined magnitude response in dB at a list of frequencies (for drawing the EQ curve). */
export function eqResponseDb(bands: EqBand[], freqs: number[], sr: number): number[] {
  const cs = bands.filter((b) => b.on).map((b) => designBiquad(b.type, b.freq, b.q, b.gain, sr));
  return freqs.map((f) => {
    let m = 1;
    for (const c of cs) m *= biquadMagnitude(c, f, sr);
    return 20 * Math.log10(Math.max(m, 1e-9));
  });
}
