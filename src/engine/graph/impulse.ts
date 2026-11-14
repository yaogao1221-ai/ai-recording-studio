/**
 * Algorithmic impulse-response generator for the convolution reverb.
 * Decaying stereo noise with frequency-dependent damping (time-varying one-pole
 * low-pass), early reflections, and adjustable stereo decorrelation.
 */
export interface IrOptions { algo: 'room' | 'hall' | 'plate'; decay: number; damping: number; width: number }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

export function generateImpulse(sr: number, o: IrOptions): Float32Array[] {
  const len = Math.max(1, Math.round(sr * Math.min(o.decay * 1.2, 10)));
  const L = new Float32Array(len), R = new Float32Array(len);
  const rl = rng(1), rr = rng(2);
  const t60 = Math.max(0.1, o.decay);
  const k = Math.log(1000) / t60; // amplitude e^{-k t} reaches -60 dB at t60
  const density = o.algo === 'plate' ? 1 : o.algo === 'hall' ? 0.9 : 0.75;
  const attack = o.algo === 'hall' ? 0.03 : o.algo === 'room' ? 0.005 : 0.002;
  let zl = 0, zr = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-k * t) * Math.min(1, t / attack);
    // damping: cut-off falls from 'damping' toward 1/4 of it over the tail
    const fc = o.damping * (1 - 0.75 * Math.min(1, t / t60));
    const a = Math.exp((-2 * Math.PI * fc) / sr);
    const nl = Math.abs(rl()) < density ? rl() : 0;
    const nr = Math.abs(rr()) < density ? rr() : 0;
    zl = (1 - a) * nl + a * zl; zr = (1 - a) * nr + a * zr;
    L[i] = zl * env; R[i] = zr * env;
  }
  // early reflections
  const er = o.algo === 'room' ? [7, 11, 17, 23, 31] : o.algo === 'hall' ? [19, 29, 41, 53, 67] : [];
  er.forEach((ms, j) => {
    const idx = Math.round((ms / 1000) * sr);
    if (idx < len) { const g = 0.5 / (j + 1); L[idx] += g * (j % 2 ? 0.6 : 1); R[Math.min(len - 1, idx + 13)] += g * (j % 2 ? 1 : 0.6); }
  });
  // width via mid/side
  const w = Math.max(0, Math.min(1, o.width));
  let e = 0;
  for (let i = 0; i < len; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * w;
    L[i] = m + s; R[i] = m - s; e += L[i] * L[i] + R[i] * R[i];
  }
  const norm = 1 / Math.sqrt(e / 2 + 1e-12) * 0.5;
  for (let i = 0; i < len; i++) { L[i] *= norm; R[i] *= norm; }
  return [L, R];
}
