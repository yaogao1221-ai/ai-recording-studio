/// <reference path="./worklet-env.d.ts" />
/**
 * All AudioWorklet processors of the studio, registered from one module.
 *  - studio-insert   : hosts one DSP kernel (EQ, compressor, ...)
 *  - studio-meter    : pass-through meter (peak, RMS, true peak, LUFS M/S/I, LRA, correlation)
 *  - studio-recorder : captures raw PCM from the microphone input, with input level metering
 */
import { createKernel, type Kernel } from '../plugins/kernels';
import type { ParamValue, PluginType } from '../plugins/registry';
import type { EqBand } from '../dsp/eq';
import { LoudnessMeter } from '../dsp/loudness';
import { TruePeakDetector } from '../dsp/oversampler';
import { Correlation } from '../dsp/stereo';

const BLOCK = 128;

function readStereo(input: Float32Array[] | undefined, L: Float32Array, R: Float32Array, n: number): void {
  if (!input || input.length === 0) { L.fill(0, 0, n); R.fill(0, 0, n); return; }
  L.set(input[0].subarray(0, n));
  R.set((input[1] ?? input[0]).subarray(0, n));
}

class InsertProcessor extends AudioWorkletProcessor {
  private kernel: Kernel | null;
  private enabled = true;
  private L = new Float32Array(BLOCK);
  private R = new Float32Array(BLOCK);
  private frames = 0;
  private alive = true;
  constructor(options: { processorOptions: { type: PluginType; params: Record<string, ParamValue>; bands?: EqBand[]; enabled: boolean } }) {
    super();
    const o = options.processorOptions;
    this.kernel = createKernel(o.type, sampleRate);
    this.kernel?.setParams(o.params, o.bands);
    this.enabled = o.enabled;
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.cmd === 'params') this.kernel?.setParams(m.params, m.bands);
      else if (m.cmd === 'enabled') { this.enabled = m.value; if (!m.value) this.kernel?.reset(); }
      else if (m.cmd === 'reset') this.kernel?.reset();
      else if (m.cmd === 'dispose') this.alive = false;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const n = out[0]?.length ?? BLOCK;
    if (this.L.length < n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    const L = this.L.subarray(0, n), R = this.R.subarray(0, n);
    readStereo(inputs[0], L, R, n);
    if (this.enabled && this.kernel) this.kernel.process(L, R, n);
    out[0].set(L);
    if (out[1]) out[1].set(R);
    this.frames += n;
    if (this.kernel?.takeGr && this.frames >= sampleRate / 30) {
      this.frames = 0;
      this.port.postMessage({ gr: this.kernel.takeGr() });
    }
    return this.alive;
  }
}

class MeterProcessor extends AudioWorkletProcessor {
  private L = new Float32Array(BLOCK);
  private R = new Float32Array(BLOCK);
  private loud = new LoudnessMeter(sampleRate);
  private tp = new TruePeakDetector(4);
  private corr = new Correlation(sampleRate);
  private pk = [0, 0]; private sq = [0, 0]; private cnt = 0; private tpMax = 0; private corrV = 0;
  private full: boolean;
  private alive = true;
  constructor(options: { processorOptions?: { full?: boolean } }) {
    super();
    this.full = !!options.processorOptions?.full;
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data.cmd === 'resetLoudness') this.loud.reset();
      if (e.data.cmd === 'dispose') this.alive = false;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const n = out[0]?.length ?? BLOCK;
    if (this.L.length < n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    const L = this.L.subarray(0, n), R = this.R.subarray(0, n);
    readStereo(inputs[0], L, R, n);
    out[0].set(L); if (out[1]) out[1].set(R);
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > this.pk[0]) this.pk[0] = al;
      if (ar > this.pk[1]) this.pk[1] = ar;
      this.sq[0] += l * l; this.sq[1] += r * r;
      if (this.full) {
        const t = Math.max(this.tp.tick(l, 0), this.tp.tick(r, 1));
        if (t > this.tpMax) this.tpMax = t;
      }
    }
    this.cnt += n;
    if (this.full) { this.loud.process(L, R, n); this.corrV = this.corr.process(L, R, n); }
    if (this.cnt >= sampleRate / 30) {
      const msg: Record<string, number> = {
        peakL: this.pk[0], peakR: this.pk[1],
        rmsL: Math.sqrt(this.sq[0] / this.cnt), rmsR: Math.sqrt(this.sq[1] / this.cnt),
      };
      if (this.full) {
        msg.truePeak = this.tpMax; msg.momentary = this.loud.momentary(); msg.shortTerm = this.loud.shortTerm();
        msg.integrated = this.loud.integrated(); msg.lra = this.loud.range(); msg.correlation = this.corrV;
        this.tpMax = 0;
      }
      this.port.postMessage(msg);
      this.pk = [0, 0]; this.sq = [0, 0]; this.cnt = 0;
    }
    return this.alive;
  }
}

/**
 * Captures input PCM. Recording starts at the first block whose frame >= startFrame
 * (so it can be aligned with the transport) and stops on command.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false;
  private startFrame = 0;
  private firstFrame = -1;
  private chunkL: Float32Array; private chunkR: Float32Array; private pos = 0;
  private pk = 0; private clips = 0; private cnt = 0; private sq = 0;
  private channels = 1;
  private alive = true;
  constructor() {
    super();
    const size = Math.round(sampleRate / 4);
    this.chunkL = new Float32Array(size); this.chunkR = new Float32Array(size);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.cmd === 'start') { this.recording = true; this.startFrame = m.startFrame ?? 0; this.firstFrame = -1; this.pos = 0; }
      else if (m.cmd === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ done: true, firstFrame: this.firstFrame, channels: this.channels }); }
      else if (m.cmd === 'dispose') this.alive = false;
    };
  }
  private flush(): void {
    if (this.pos === 0) return;
    const l = this.chunkL.slice(0, this.pos), r = this.chunkR.slice(0, this.pos);
    this.port.postMessage({ chunk: [l, r] }, [l.buffer, r.buffer]);
    this.pos = 0;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inp = inputs[0];
    const out = outputs[0];
    if (out) for (const c of out) c.fill(0);
    if (!inp || inp.length === 0) return this.alive;
    this.channels = Math.max(this.channels, inp.length);
    const n = inp[0].length;
    const a = inp[0], b = inp[1] ?? inp[0];
    for (let i = 0; i < n; i++) {
      const v = Math.max(Math.abs(a[i]), Math.abs(b[i]));
      if (v > this.pk) this.pk = v;
      if (v >= 0.999) this.clips++;
      this.sq += a[i] * a[i];
    }
    this.cnt += n;
    if (this.cnt >= sampleRate / 30) {
      this.port.postMessage({ level: { peak: this.pk, rms: Math.sqrt(this.sq / this.cnt), clips: this.clips } });
      this.pk = 0; this.sq = 0; this.cnt = 0; this.clips = 0;
    }
    if (this.recording && currentFrame + n > this.startFrame) {
      const off = Math.max(0, this.startFrame - currentFrame);
      if (this.firstFrame < 0) this.firstFrame = currentFrame + off;
      for (let i = off; i < n; i++) {
        this.chunkL[this.pos] = a[i]; this.chunkR[this.pos] = b[i];
        if (++this.pos === this.chunkL.length) this.flush();
      }
    }
    return this.alive;
  }
}

registerProcessor('studio-insert', InsertProcessor);
registerProcessor('studio-meter', MeterProcessor);
registerProcessor('studio-recorder', RecorderProcessor);
