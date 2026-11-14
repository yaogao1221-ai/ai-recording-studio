/**
 * RBJ "Audio EQ Cookbook" biquads, Transposed Direct Form II, stereo state.
 * Coefficients are normalised so a0 = 1.
 */
export type FilterType =
  | 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'bandpass' | 'notch';

export interface BiquadCoefs { b0: number; b1: number; b2: number; a1: number; a2: number }

export function designBiquad(
  type: FilterType, freq: number, q: number, gainDb: number, sampleRate: number,
): BiquadCoefs {
  const f = Math.min(Math.max(freq, 1), sampleRate * 0.4999);
  const Q = Math.max(q, 0.025);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const alpha = sn / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cs + s); b1 = 2 * A * ((A - 1) - (A + 1) * cs);
      b2 = A * ((A + 1) - (A - 1) * cs - s); a0 = (A + 1) + (A - 1) * cs + s;
      a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs);
      b2 = A * ((A + 1) + (A - 1) * cs - s); a0 = (A + 1) - (A - 1) * cs + s;
      a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s; break;
    }
    case 'lowpass':
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude (linear) of a biquad at frequency f. */
export function biquadMagnitude(c: BiquadCoefs, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cr1 = Math.cos(w), ci1 = -Math.sin(w);
  const cr2 = Math.cos(2 * w), ci2 = -Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cr1 + c.b2 * cr2, ni = c.b1 * ci1 + c.b2 * ci2;
  const dr = 1 + c.a1 * cr1 + c.a2 * cr2, di = c.a1 * ci1 + c.a2 * ci2;
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

export class Biquad {
  c: BiquadCoefs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private z1 = new Float64Array(2);
  private z2 = new Float64Array(2);
  set(c: BiquadCoefs): void { this.c = c; }
  reset(): void { this.z1.fill(0); this.z2.fill(0); }
  /** Process one sample on channel ch. */
  tick(x: number, ch: number): number {
    const c = this.c;
    const y = c.b0 * x + this.z1[ch];
    this.z1[ch] = c.b1 * x - c.a1 * y + this.z2[ch];
    this.z2[ch] = c.b2 * x - c.a2 * y;
    return y;
  }
  processBlock(buf: Float32Array, ch: number): void {
    for (let i = 0; i < buf.length; i++) buf[i] = this.tick(buf[i], ch);
  }
}
