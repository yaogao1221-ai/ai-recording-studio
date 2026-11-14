import { describe, expect, it } from 'vitest';
import { biquadMagnitude, designBiquad } from '../src/engine/dsp/biquad';
import { Compressor, DeEsser, Gate, compressorCurve } from '../src/engine/dsp/dynamics';
import { ParametricEq, eqResponseDb } from '../src/engine/dsp/eq';
import { Clipper, Limiter } from '../src/engine/dsp/limiter';
import { LoudnessMeter } from '../src/engine/dsp/loudness';
import { TruePeakDetector } from '../src/engine/dsp/oversampler';
import { Saturator } from '../src/engine/dsp/saturation';
import { StereoImager } from '../src/engine/dsp/stereo';
import { decodeWav, encodeWav } from '../src/engine/dsp/wav';
import { averageSpectrum } from '../src/engine/dsp/fft';
import { SR, db, peak, rms, runBlocks, sine } from './helpers';

describe('biquad / EQ', () => {
  it('peaking filter has the requested gain at its centre and ~0 dB far away', () => {
    const c = designBiquad('peaking', 1000, 1, 6, SR);
    expect(db(biquadMagnitude(c, 1000, SR))).toBeCloseTo(6, 2);
    expect(Math.abs(db(biquadMagnitude(c, 50, SR)))).toBeLessThan(0.1);
  });
  it('high-pass at 100 Hz is -3 dB at cutoff (Q=0.707) and attenuates 25 Hz by > 20 dB', () => {
    const c = designBiquad('highpass', 100, Math.SQRT1_2, 0, SR);
    expect(db(biquadMagnitude(c, 100, SR))).toBeCloseTo(-3.01, 1);
    expect(db(biquadMagnitude(c, 25, SR))).toBeLessThan(-20);
  });
  it('EQ processing matches the analytic response on a real sine', () => {
    const eq = new ParametricEq(SR);
    eq.setBands([{ on: true, type: 'peaking', freq: 300, gain: -6, q: 1.2 }]);
    const L = sine(300, 0.5, 1), R = sine(300, 0.5, 1);
    runBlocks(eq, L, R);
    const measured = db(rms(L, SR / 2) / (0.5 / Math.SQRT2));
    expect(measured).toBeCloseTo(eqResponseDb(eq.bands, [300], SR)[0], 1);
    expect(measured).toBeCloseTo(-6, 1);
  });
});

describe('dynamics', () => {
  it('compressor static curve: 3:1 above threshold, unity below', () => {
    expect(compressorCurve(-30, -18, 3, 0)).toBe(-30);
    expect(compressorCurve(-6, -18, 3, 0)).toBeCloseTo(-14, 6);
  });
  it('compressor reduces a loud sine by the expected steady-state amount', () => {
    const c = new Compressor(SR);
    c.set({ threshold: -20, ratio: 4, knee: 0, attack: 5, release: 50 });
    // sine peak at -6 dBFS: detector is peak-based per sample, steady state GR ~ (14 - 14/4) = 10.5 dB at peaks
    const L = sine(1000, 0.5, 1), R = sine(1000, 0.5, 1);
    runBlocks(c, L, R);
    const outPeakDb = db(peak(L, SR / 2));
    expect(outPeakDb).toBeLessThan(-6 - 6);
    expect(outPeakDb).toBeGreaterThan(-6 - 12);
    expect(c.grPeak).toBeGreaterThan(6);
  });
  it('compressor leaves a quiet signal untouched', () => {
    const c = new Compressor(SR);
    c.set({ threshold: -10, ratio: 4, knee: 0 });
    const L = sine(1000, 0.05, 0.5), R = sine(1000, 0.05, 0.5);
    runBlocks(c, L, R);
    expect(db(peak(L, SR / 4))).toBeCloseTo(db(0.05), 1);
  });
  it('gate attenuates signal below threshold by the range', () => {
    const g = new Gate(SR);
    g.set({ threshold: -40, ratio: 20, range: 40, hold: 0, release: 20 });
    const L = sine(500, 0.001, 1), R = sine(500, 0.001, 1); // -60 dBFS
    runBlocks(g, L, R);
    expect(db(peak(L, SR / 2)) - db(0.001)).toBeLessThan(-35);
  });
  it('de-esser reduces 8 kHz content but leaves 200 Hz content intact', () => {
    const d = new DeEsser(SR);
    d.set({ frequency: 5000, threshold: -30, range: 12 });
    const hiL = sine(8000, 0.3, 1), hiR = sine(8000, 0.3, 1);
    runBlocks(d, hiL, hiR);
    expect(db(rms(hiL, SR / 2) / (0.3 / Math.SQRT2))).toBeLessThan(-6);
    d.reset();
    const loL = sine(200, 0.3, 1), loR = sine(200, 0.3, 1);
    runBlocks(d, loL, loR);
    expect(Math.abs(db(rms(loL, SR / 2) / (0.3 / Math.SQRT2)))).toBeLessThan(0.3);
  });
  it('de-esser crossover is magnitude-flat when no reduction happens', () => {
    for (const f of [500, 3000, 6500, 10000]) {
      const d = new DeEsser(SR); d.set({ threshold: 0, frequency: 6500 });
      const L = sine(f, 0.2, 0.5), R = sine(f, 0.2, 0.5);
      runBlocks(d, L, R);
      expect(Math.abs(db(rms(L, SR / 4) / (0.2 / Math.SQRT2)))).toBeLessThan(0.05);
    }
  });
});

describe('limiter / clipper', () => {
  it('limiter output never exceeds the ceiling (sample peak)', () => {
    const lim = new Limiter(SR);
    lim.set({ ceiling: -1, inputGain: 12, truePeak: false, release: 50 });
    const L = new Float32Array(SR), R = new Float32Array(SR);
    for (let i = 0; i < SR; i++) { L[i] = Math.sin(i * 0.05) * 0.9 + (Math.random() - 0.5) * 0.4; R[i] = L[i] * 0.8; }
    runBlocks(lim, L, R);
    expect(db(Math.max(peak(L), peak(R)))).toBeLessThanOrEqual(-1 + 1e-4);
    expect(lim.grPeak).toBeGreaterThan(6);
  });
  it('limiter is transparent below the ceiling (apart from the look-ahead delay)', () => {
    const lim = new Limiter(SR); lim.set({ ceiling: -1, truePeak: false });
    const x = sine(440, 0.3, 0.3); const L = x.slice(), R = x.slice();
    runBlocks(lim, L, R);
    const d = lim.latency;
    for (let i = d + 10; i < x.length; i++) expect(Math.abs(L[i] - x[i - d])).toBeLessThan(1e-5);
  });
  it('clipper bounds the output at the ceiling', () => {
    const c = new Clipper(); c.set({ ceiling: -3, softness: 0.3, inputGain: 6 });
    const L = sine(100, 0.9, 0.2), R = sine(100, 0.9, 0.2);
    c.process(L, R, L.length);
    expect(db(peak(L))).toBeLessThanOrEqual(-3 + 1e-6);
  });
});

describe('saturation', () => {
  it('adds harmonics (3rd harmonic appears on a soft-clipped sine)', () => {
    const s = new Saturator(SR); s.set({ drive: 18, mode: 'soft', mix: 1 });
    const L = sine(1000, 0.5, 1), R = sine(1000, 0.5, 1);
    runBlocks(s, L, R);
    const spec = averageSpectrum(L.subarray(SR / 2), 4096);
    const bin = (f: number): number => Math.round((f / SR) * 4096);
    const h1 = spec[bin(1000)], h3 = spec[bin(3000)];
    expect(10 * Math.log10(h3 / h1)).toBeGreaterThan(-40);
  });
  it('tape mode adds even harmonics (2nd)', () => {
    const s = new Saturator(SR); s.set({ drive: 18, mode: 'tape', mix: 1 });
    const L = sine(1000, 0.5, 1), R = sine(1000, 0.5, 1);
    runBlocks(s, L, R);
    const spec = averageSpectrum(L.subarray(SR / 2), 4096);
    const bin = (f: number): number => Math.round((f / SR) * 4096);
    expect(10 * Math.log10(spec[bin(2000)] / spec[bin(1000)])).toBeGreaterThan(-50);
  });
});

describe('metering (BS.1770-4)', () => {
  it('0 dBFS 997 Hz sine on one channel reads -3.01 LUFS', () => {
    const m = new LoudnessMeter(SR);
    const L = sine(997, 1, 5), R = new Float32Array(L.length);
    m.process(L, R, L.length);
    expect(m.integrated()).toBeCloseTo(-3.01, 1);
  });
  it('-20 dBFS sine on both channels reads about -20 LUFS', () => {
    const m = new LoudnessMeter(SR);
    const a = Math.pow(10, -20 / 20);
    const L = sine(997, a, 5), R = sine(997, a, 5);
    m.process(L, R, L.length);
    expect(m.integrated()).toBeCloseTo(-20, 0);
    expect(m.shortTerm()).toBeCloseTo(-20, 0);
  });
  it('works at 44.1 kHz too', () => {
    const m = new LoudnessMeter(44100);
    const L = sine(997, 1, 5, 44100), R = new Float32Array(L.length);
    m.process(L, R, L.length);
    expect(m.integrated()).toBeCloseTo(-3.01, 1);
  });
  it('true peak detects inter-sample peaks (fs/4 sine at 45° phase)', () => {
    const x = sine(SR / 4, 1, 0.1, SR, Math.PI / 4);
    expect(peak(x)).toBeCloseTo(Math.SQRT1_2, 3);
    const tp = new TruePeakDetector(4); let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, tp.tick(x[i], 0));
    expect(db(m)).toBeGreaterThan(-0.5);
  });
});

describe('stereo / wav', () => {
  it('imager width 0 collapses to mono', () => {
    const im = new StereoImager(SR); im.set({ width: 0 });
    const L = sine(300, 0.5, 0.1), R = sine(500, 0.5, 0.1);
    im.process(L, R, L.length);
    for (let i = 0; i < L.length; i++) expect(L[i]).toBeCloseTo(R[i], 6);
  });
  it('WAV round-trips at 16, 24 and 32-bit float', () => {
    const x = sine(440, 0.5, 0.05);
    for (const bits of [16, 24, 32] as const) {
      const w = encodeWav([x, x], SR, bits, false);
      const d = decodeWav(w);
      expect(d.sampleRate).toBe(SR); expect(d.channels.length).toBe(2);
      const tol = bits === 16 ? 1e-4 : bits === 24 ? 1e-6 : 0;
      for (let i = 0; i < x.length; i += 7) expect(Math.abs(d.channels[1][i] - x[i])).toBeLessThanOrEqual(tol);
    }
  });
});
