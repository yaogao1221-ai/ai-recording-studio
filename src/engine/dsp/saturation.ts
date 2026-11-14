import { Oversampler } from './oversampler';
import { Biquad, designBiquad } from './biquad';
import { dbToGain } from './util';

export type SatMode = 'soft' | 'tape' | 'tube' | 'hard';
export interface SaturationParams { drive: number; mode: SatMode; mix: number; output: number; tone: number }

export function shape(x: number, mode: SatMode): number {
  switch (mode) {
    case 'soft': return Math.tanh(x);
    case 'hard': return x > 1 ? 1 : x < -1 ? -1 : x;
    case 'tape': { // asymmetric -> adds even harmonics
      const b = 0.2; return Math.tanh(x + b) - Math.tanh(b);
    }
    case 'tube': // asymmetric soft clip, stronger on positive half
      return x >= 0 ? 1 - Math.exp(-x) : -(1 - Math.exp(1.3 * x)) / 1.3;
  }
}

/** Oversampled (4x) waveshaping saturator with drive, tone tilt, dry/wet and output gain. */
export class Saturator {
  p: SaturationParams = { drive: 6, mode: 'soft', mix: 1, output: 0, tone: 0 };
  private os = new Oversampler(4, 12);
  private osDry = new Oversampler(4, 12); // identical path for phase-aligned dry signal
  private ob2 = new Float64Array(4);
  private ob = new Float64Array(4);
  private dc = [0, 0]; private dcx = [0, 0];
  private tilt = new Biquad();
  constructor(private sr: number) { this.update(); }
  set(p: Partial<SaturationParams>): void { Object.assign(this.p, p); this.update(); }
  private update(): void { this.tilt.set(designBiquad('highshelf', 3000, 0.6, this.p.tone, this.sr)); }
  reset(): void { this.os.reset(); this.osDry.reset(); this.dc = [0, 0]; this.dcx = [0, 0]; this.tilt.reset(); }
  get latency(): number { return this.os.latency; }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.p;
    const drive = dbToGain(p.drive);
    // normalise so small signals keep roughly unity gain
    const norm = 1 / Math.max(1, drive * 0.5 + 0.5);
    const out = dbToGain(p.output);
    const chans = [L, R];
    for (let c = 0; c < 2; c++) {
      const b = chans[c];
      for (let i = 0; i < n; i++) {
        const x = b[i];
        let dry = x;
        if (p.mix < 1) { this.osDry.up(x, c, this.ob2); dry = this.osDry.down(this.ob2, c); }
        this.os.up(x * drive, c, this.ob);
        for (let k = 0; k < 4; k++) this.ob[k] = shape(this.ob[k], p.mode);
        let y = this.os.down(this.ob, c) * norm;
        // DC blocker (asymmetric modes create DC)
        const yy = y - this.dcx[c] + 0.9995 * this.dc[c];
        this.dcx[c] = y; this.dc[c] = yy; y = yy;
        if (p.tone !== 0) y = this.tilt.tick(y, c);
        b[i] = (dry * (1 - p.mix) + y * p.mix) * out;
      }
    }
  }
}
