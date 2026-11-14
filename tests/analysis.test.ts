import { describe, expect, it } from 'vitest';
import { analyzeChannels } from '../src/engine/analysis/analyze';
import { suggestMaster, suggestVocalChain } from '../src/engine/ai/engineer';
import { SR, sine } from './helpers';

function noise(sec: number, amp: number): Float32Array { const x = new Float32Array(sec * SR); for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * amp; return x; }

describe('analysis', () => {
  it('measures loudness, peak and band energy of a known signal', () => {
    const a = sine(300, 0.5, 6);
    const r = analyzeChannels([a, a], SR);
    expect(r.samplePeakDb).toBeCloseTo(-6.02, 1);
    expect(r.integratedLufs).toBeLessThan(-6); expect(r.integratedLufs).toBeGreaterThan(-12);
    expect(r.bands.lowmid).toBeGreaterThan(-1); // nearly all energy at 300 Hz
    expect(r.correlation).toBeCloseTo(1, 3);
    expect(r.clippedSamples).toBe(0);
  });
  it('detects clipping runs', () => {
    const a = sine(100, 1.5, 1).map((x) => Math.max(-1, Math.min(1, x)));
    expect(analyzeChannels([a, a], SR).clippedSamples).toBeGreaterThan(100);
  });
  it('decorrelated noise has correlation near 0', () => {
    expect(Math.abs(analyzeChannels([noise(4, 0.3), noise(4, 0.3)], SR).correlation)).toBeLessThan(0.05);
  });
});

describe('AI engineer (rule-based)', () => {
  it('cuts mud when low-mids dominate and explains why', () => {
    const v = sine(300, 0.3, 6);
    const s = suggestVocalChain(analyzeChannels([v, v], SR), null, 'rap');
    const eq = s.inserts.find((i) => i.type === 'eq')!;
    expect(eq.bands!.some((b) => b.freq === 300 && b.gain < 0)).toBe(true);
    expect(s.notes.join(' ')).toMatch(/300 Hz/);
  });
  it('sets a master limiter gain toward the destination target', () => {
    const a = noise(8, 0.05);
    const m = analyzeChannels([a, a], SR);
    const s = suggestMaster(m, 'spotify');
    const lim = s.inserts.find((i) => i.type === 'limiter')!;
    expect(Number(lim.params.inputGain)).toBeGreaterThan(0);
    expect(Number(lim.params.ceiling)).toBe(-1);
  });
});
