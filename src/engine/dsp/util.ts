export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g <= 1e-12 ? -240 : 20 * Math.log10(g));
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** One-pole smoothing coefficient for a time constant in milliseconds. */
export const timeCoef = (ms: number, sampleRate: number): number =>
  ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate));
