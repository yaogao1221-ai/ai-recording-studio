import { Biquad, BiquadCoefs } from './biquad';

/** ITU-R BS.1770-4 K-weighting coefficients for any sample rate (same derivation as libebur128). */
export function kWeightingCoefs(sr: number): [BiquadCoefs, BiquadCoefs] {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1: BiquadCoefs = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const s2: BiquadCoefs = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

const LUFS_OFFSET = -0.691;
const toLufs = (ms: number): number => (ms <= 0 ? -Infinity : LUFS_OFFSET + 10 * Math.log10(ms));

/**
 * Streaming loudness meter: momentary (400 ms), short-term (3 s), integrated
 * (gated, BS.1770-4) and loudness range (EBU Tech 3342).
 * Stereo, channel weights 1.0.
 */
export class LoudnessMeter {
  private f1 = new Biquad(); private f2 = new Biquad();
  private sub: number; // samples per 100 ms
  private acc = 0; private cnt = 0;
  private subs: number[] = []; // mean-square per 100ms sub-block (sum of channels)
  private blocks: number[] = []; // 400ms block mean-squares (for integrated)
  private stBlocks: number[] = []; // 3s short-term loudness every 100ms (for LRA)
  constructor(sr: number) {
    const [a, b] = kWeightingCoefs(sr); this.f1.set(a); this.f2.set(b);
    this.sub = Math.round(sr / 10);
  }
  reset(): void { this.f1.reset(); this.f2.reset(); this.acc = 0; this.cnt = 0; this.subs = []; this.blocks = []; this.stBlocks = []; }
  process(L: Float32Array, R: Float32Array | null, n: number): void {
    for (let i = 0; i < n; i++) {
      const l = this.f2.tick(this.f1.tick(L[i], 0), 0);
      let s = l * l;
      if (R) { const r = this.f2.tick(this.f1.tick(R[i], 1), 1); s += r * r; }
      this.acc += s;
      if (++this.cnt >= this.sub) {
        this.subs.push(this.acc / this.cnt);
        this.acc = 0; this.cnt = 0;
        if (this.subs.length > 30) this.subs.shift();
        if (this.subs.length >= 4) this.blocks.push(this.mean(4));
        if (this.subs.length >= 30) this.stBlocks.push(toLufs(this.mean(30)));
      }
    }
  }
  private mean(k: number): number {
    let s = 0; const n = this.subs.length;
    for (let i = n - k; i < n; i++) s += this.subs[i];
    return s / k;
  }
  momentary(): number { return this.subs.length >= 4 ? toLufs(this.mean(4)) : -Infinity; }
  shortTerm(): number { return this.subs.length >= 30 ? toLufs(this.mean(30)) : this.subs.length ? toLufs(this.mean(this.subs.length)) : -Infinity; }
  integrated(): number {
    const abs = this.blocks.filter((b) => toLufs(b) > -70);
    if (!abs.length) return -Infinity;
    const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((b) => toLufs(b) > rel);
    if (!g.length) return -Infinity;
    return toLufs(g.reduce((a, b) => a + b, 0) / g.length);
  }
  /** Loudness range (LU), EBU Tech 3342. */
  range(): number {
    const abs = this.stBlocks.filter((l) => l > -70);
    if (abs.length < 2) return 0;
    const lin = abs.map((l) => Math.pow(10, (l - LUFS_OFFSET) / 10));
    const rel = toLufs(lin.reduce((a, b) => a + b, 0) / lin.length) - 20;
    const g = abs.filter((l) => l > rel).sort((a, b) => a - b);
    if (g.length < 2) return 0;
    const q = (p: number): number => g[Math.min(g.length - 1, Math.max(0, Math.round(p * (g.length - 1))))];
    return q(0.95) - q(0.1);
  }
}
