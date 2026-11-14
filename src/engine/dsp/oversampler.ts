/**
 * Polyphase FIR oversampler (Kaiser-windowed sinc). Used by saturation,
 * clipper and true-peak detection to reduce aliasing / find inter-sample peaks.
 */
function besselI0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
  return sum;
}

export function designLowpassFir(taps: number, cutoff: number, beta = 8): Float64Array {
  // cutoff normalised to the (high) sample rate, 0..0.5
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  const i0b = besselI0(beta);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const r = (2 * n) / (taps - 1) - 1;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[n] = sinc * w; sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

export class Oversampler {
  readonly factor: number;
  readonly taps: number;
  private h: Float64Array;
  private upHist: Float64Array[]; // input history per channel (base rate)
  private downHist: Float64Array[]; // high-rate history per channel
  private upPos: number[] = [0, 0];
  private downPos: number[] = [0, 0];
  private phaseLen: number;
  /** Group delay in base-rate samples (approx). */
  readonly latency: number;

  constructor(factor = 4, tapsPerPhase = 16) {
    this.factor = factor;
    this.taps = factor * tapsPerPhase;
    this.phaseLen = tapsPerPhase;
    this.h = designLowpassFir(this.taps, 0.5 / factor * 0.9);
    this.upHist = [new Float64Array(tapsPerPhase), new Float64Array(tapsPerPhase)];
    this.downHist = [new Float64Array(this.taps), new Float64Array(this.taps)];
    this.latency = (this.taps - 1) / factor; // up + down, each (taps-1)/2 at high rate
  }

  reset(): void {
    this.upHist.forEach((a) => a.fill(0)); this.downHist.forEach((a) => a.fill(0));
    this.upPos = [0, 0]; this.downPos = [0, 0];
  }

  /** Upsample one base-rate sample into `out` (length factor). */
  up(x: number, ch: number, out: Float64Array): void {
    const hist = this.upHist[ch];
    const L = this.phaseLen;
    let p = this.upPos[ch];
    hist[p] = x;
    const F = this.factor;
    for (let ph = 0; ph < F; ph++) {
      let acc = 0;
      let idx = p;
      for (let j = 0; j < L; j++) {
        acc += this.h[j * F + ph] * hist[idx];
        idx = idx === 0 ? L - 1 : idx - 1;
      }
      out[ph] = acc * F;
    }
    this.upPos[ch] = (p + 1) % L;
  }

  /** Downsample `factor` high-rate samples to one base-rate sample. */
  down(inp: Float64Array, ch: number): number {
    const hist = this.downHist[ch];
    const N = this.taps;
    let p = this.downPos[ch];
    for (let k = 0; k < this.factor; k++) { hist[p] = inp[k]; p = (p + 1) % N; }
    this.downPos[ch] = p;
    // newest sample at p-1
    let acc = 0;
    let idx = p === 0 ? N - 1 : p - 1;
    for (let i = 0; i < N; i++) {
      acc += this.h[i] * hist[idx];
      idx = idx === 0 ? N - 1 : idx - 1;
    }
    return acc;
  }
}

/** Streaming true-peak detector (4x oversampled, per ITU-R BS.1770-4 Annex 2 approach). */
export class TruePeakDetector {
  private os: Oversampler;
  private buf: Float64Array;
  constructor(factor = 4) { this.os = new Oversampler(factor, 12); this.buf = new Float64Array(factor); }
  reset(): void { this.os.reset(); }
  /** Returns max absolute interpolated value for this input sample. */
  tick(x: number, ch: number): number {
    this.os.up(x, ch, this.buf);
    let m = Math.abs(x);
    for (let i = 0; i < this.buf.length; i++) { const a = Math.abs(this.buf[i]); if (a > m) m = a; }
    return m;
  }
}
