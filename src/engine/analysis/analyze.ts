import { LoudnessMeter } from '../dsp/loudness';
import { TruePeakDetector } from '../dsp/oversampler';
import { averageSpectrum } from '../dsp/fft';

export const BANDS = [
  { key: 'sub', label: 'Sub', lo: 20, hi: 60 },
  { key: 'bass', label: 'Basses', lo: 60, hi: 250 },
  { key: 'lowmid', label: 'Bas-médiums', lo: 250, hi: 500 },
  { key: 'mid', label: 'Médiums', lo: 500, hi: 2000 },
  { key: 'highmid', label: 'Haut-médiums', lo: 2000, hi: 5000 },
  { key: 'presence', label: 'Présence / sifflantes', lo: 5000, hi: 10000 },
  { key: 'air', label: 'Air', lo: 10000, hi: 20000 },
] as const;
export type BandKey = (typeof BANDS)[number]['key'];

export interface Analysis {
  duration: number; sampleRate: number;
  samplePeakDb: number; truePeakDb: number; rmsDb: number; crestDb: number;
  integratedLufs: number; shortTermMaxLufs: number; lra: number;
  clippedSamples: number; dcOffset: number; correlation: number; silenceRatio: number;
  /** band energy relative to the total, dB */ bands: Record<BandKey, number>;
  /** smoothed spectrum for display: [freq, dB] */ spectrum: [number, number][];
}

const db = (x: number): number => (x <= 1e-12 ? -240 : 20 * Math.log10(x));

/** Full measurement of real audio data. Everything here is computed, nothing is estimated. */
export function analyzeChannels(ch: Float32Array[], sr: number, opts: { spectrum?: boolean } = {}): Analysis {
  const L = ch[0], R = ch[1] ?? ch[0];
  const n = L.length;
  let pk = 0, sq = 0, dc = 0, lr = 0, ll = 0, rr = 0, clipped = 0, run = 0, silent = 0;
  const tp = new TruePeakDetector(4); let tpm = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > pk) pk = a;
    sq += (l * l + r * r) / 2; dc += (l + r) / 2;
    lr += l * r; ll += l * l; rr += r * r;
    if (a >= 0.9999) { run++; if (run === 3) clipped += 3; else if (run > 3) clipped++; } else run = 0;
    if (a < 0.001) silent++;
    const t = Math.max(tp.tick(l, 0), tp.tick(r, 1)); if (t > tpm) tpm = t;
  }
  const meter = new LoudnessMeter(sr);
  let stMax = -Infinity;
  const step = Math.round(sr / 10);
  for (let s = 0; s < n; s += step) {
    const e = Math.min(n, s + step);
    meter.process(L.subarray(s, e), R.subarray(s, e), e - s);
    const st = meter.shortTerm(); if (st > stMax && s > sr * 3) stMax = st;
  }
  const rms = Math.sqrt(sq / Math.max(1, n));
  // spectrum on mid channel, up to ~60 s sampled evenly for speed
  const fftN = 8192;
  const mid = new Float32Array(Math.min(n, sr * 60));
  const stride = n / Math.max(1, mid.length);
  for (let i = 0; i < mid.length; i++) { const k = Math.floor(i * stride); mid[i] = (L[k] + R[k]) * 0.5; }
  const pow = mid.length >= fftN ? averageSpectrum(mid, fftN) : new Float64Array(fftN / 2);
  const binHz = sr / fftN;
  let total = 0; for (let k = 1; k < pow.length; k++) total += pow[k];
  const bands = {} as Record<BandKey, number>;
  for (const b of BANDS) {
    let e = 0;
    for (let k = Math.max(1, Math.floor(b.lo / binHz)); k < Math.min(pow.length, Math.ceil(b.hi / binHz)); k++) e += pow[k];
    bands[b.key] = total > 0 ? 10 * Math.log10(Math.max(e, 1e-20) / total) : -120;
  }
  const spectrum: [number, number][] = [];
  if (opts.spectrum !== false && total > 0) {
    // 1/6-octave smoothing, 20 Hz - 20 kHz
    for (let f = 20; f <= Math.min(20000, sr / 2); f *= Math.pow(2, 1 / 6)) {
      const lo = Math.max(1, Math.floor((f / Math.pow(2, 1 / 12)) / binHz)), hi = Math.max(lo + 1, Math.ceil((f * Math.pow(2, 1 / 12)) / binHz));
      let e = 0; for (let k = lo; k < Math.min(hi, pow.length); k++) e += pow[k];
      spectrum.push([f, 10 * Math.log10(Math.max(e / (hi - lo), 1e-20))]);
    }
  }
  const corrD = Math.sqrt(ll * rr);
  return {
    duration: n / sr, sampleRate: sr,
    samplePeakDb: db(pk), truePeakDb: db(tpm), rmsDb: db(rms), crestDb: db(pk) - db(rms),
    integratedLufs: meter.integrated(), shortTermMaxLufs: stMax, lra: meter.range(),
    clippedSamples: clipped, dcOffset: dc / Math.max(1, n), correlation: corrD > 0 ? lr / corrD : 1,
    silenceRatio: silent / Math.max(1, n), bands, spectrum,
  };
}

export function analyzeBuffer(b: AudioBuffer, opts?: { spectrum?: boolean }): Analysis {
  const ch = [b.getChannelData(0)]; if (b.numberOfChannels > 1) ch.push(b.getChannelData(1));
  return analyzeChannels(ch, b.sampleRate, opts);
}
