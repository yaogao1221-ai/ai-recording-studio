export const SR = 48000;
export function sine(freq: number, amp: number, seconds: number, sr = SR, phase = 0): Float32Array {
  const n = Math.round(seconds * sr); const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return x;
}
export const peak = (x: Float32Array, from = 0): number => { let m = 0; for (let i = from; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
export const rms = (x: Float32Array, from = 0): number => { let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length - from)); };
export const db = (g: number): number => 20 * Math.log10(g);
/** Run a stereo in-place processor in 128-sample blocks like an AudioWorklet. */
export function runBlocks(proc: { process(L: Float32Array, R: Float32Array, n: number): void }, L: Float32Array, R: Float32Array): void {
  for (let s = 0; s < L.length; s += 128) {
    const n = Math.min(128, L.length - s);
    proc.process(L.subarray(s, s + n), R.subarray(s, s + n), n);
  }
}
