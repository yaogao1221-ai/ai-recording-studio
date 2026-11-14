/**
 * Kernel factory shared by the AudioWorklet processor and the unit tests.
 * Every kernel processes stereo planar Float32 blocks in place.
 */
import { Compressor, DeEsser, Gate } from '../dsp/dynamics';
import { ParametricEq } from '../dsp/eq';
import { Clipper, Limiter } from '../dsp/limiter';
import { Saturator } from '../dsp/saturation';
import { StereoImager, TransientShaper } from '../dsp/stereo';
import { dbToGain } from '../dsp/util';
import type { EqBand } from '../dsp/eq';
import type { ParamValue, PluginType } from './registry';

export interface Kernel {
  process(L: Float32Array, R: Float32Array, n: number): void;
  setParams(p: Record<string, ParamValue>, bands?: EqBand[]): void;
  reset(): void;
  /** Gain reduction (dB) peak since last call, for metering. */
  takeGr?(): number;
}

class UtilityKernel implements Kernel {
  p = { gain: 0, invertL: false, invertR: false, mono: false };
  setParams(p: Record<string, ParamValue>): void { Object.assign(this.p, p); }
  reset(): void {}
  process(L: Float32Array, R: Float32Array, n: number): void {
    const g = dbToGain(this.p.gain);
    const gl = this.p.invertL ? -g : g, gr = this.p.invertR ? -g : g;
    for (let i = 0; i < n; i++) {
      let l = L[i] * gl, r = R[i] * gr;
      if (this.p.mono) { const m = (l + r) * 0.5; l = m; r = m; }
      L[i] = l; R[i] = r;
    }
  }
}

function wrap<T extends { set(p: any): void; reset(): void; process(L: Float32Array, R: Float32Array, n: number): void; grPeak?: number }>(k: T): Kernel {
  return {
    process: (L, R, n) => k.process(L, R, n),
    setParams: (p) => k.set(p),
    reset: () => k.reset(),
    takeGr: () => { const g = k.grPeak ?? 0; if (k.grPeak !== undefined) k.grPeak = 0; return g; },
  };
}

export function createKernel(type: PluginType, sr: number): Kernel | null {
  switch (type) {
    case 'utility': return new UtilityKernel();
    case 'gate': return wrap(new Gate(sr));
    case 'compressor': return wrap(new Compressor(sr));
    case 'deesser': return wrap(new DeEsser(sr));
    case 'saturation': return wrap(new Saturator(sr));
    case 'transient': return wrap(new TransientShaper(sr));
    case 'imager': return wrap(new StereoImager(sr));
    case 'clipper': return wrap(new Clipper());
    case 'limiter': return wrap(new Limiter(sr));
    case 'eq': {
      const eq = new ParametricEq(sr);
      return {
        process: (L, R, n) => eq.process(L, R, n),
        setParams: (p, bands) => { if (bands) eq.setBands(bands); if (typeof p.output === 'number') eq.output = p.output; },
        reset: () => eq.reset(),
      };
    }
    default: return null; // native plugins
  }
}
