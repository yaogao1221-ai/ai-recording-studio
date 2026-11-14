import type { InsertState, ParamValue } from '../plugins/registry';
import { PLUGINS, delaySeconds } from '../plugins/registry';
import { generateImpulse } from './impulse';

/** A processing slot in a channel's insert chain. */
export interface InsertNode {
  readonly id: string;
  readonly type: InsertState['type'];
  readonly input: AudioNode;
  readonly output: AudioNode;
  update(s: InsertState, bpm: number): void;
  setEnabled(on: boolean): void;
  dispose(): void;
  onGr?: (db: number) => void;
}

const num = (p: Record<string, ParamValue>, k: string): number => Number(p[k]);

class WorkletInsert implements InsertNode {
  readonly input: AudioNode; readonly output: AudioNode;
  private node: AudioWorkletNode;
  onGr?: (db: number) => void;
  constructor(ctx: BaseAudioContext, readonly id: string, readonly type: InsertState['type'], s: InsertState) {
    this.node = new AudioWorkletNode(ctx, 'studio-insert', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
      channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { type: s.type, params: s.params, bands: s.bands, enabled: s.enabled },
    });
    this.node.port.onmessage = (e) => { if (typeof e.data.gr === 'number') this.onGr?.(e.data.gr); };
    this.input = this.node; this.output = this.node;
  }
  update(s: InsertState): void { this.node.port.postMessage({ cmd: 'params', params: s.params, bands: s.bands }); this.setEnabled(s.enabled); }
  setEnabled(on: boolean): void { this.node.port.postMessage({ cmd: 'enabled', value: on }); }
  dispose(): void { this.node.port.postMessage({ cmd: 'dispose' }); this.node.disconnect(); }
}

/** Base for native-node effects: in -> dry -> out, in -> [wet path] -> wet -> out. */
abstract class NativeInsert implements InsertNode {
  readonly input: GainNode; readonly output: GainNode;
  protected dry: GainNode; protected wet: GainNode;
  protected enabled = true; protected mix = 0;
  constructor(protected ctx: BaseAudioContext, readonly id: string, readonly type: InsertState['type']) {
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.dry = ctx.createGain(); this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
  }
  protected applyMix(): void {
    const t = this.ctx.currentTime;
    const m = this.enabled ? this.mix : 0;
    this.wet.gain.setTargetAtTime(m, t, 0.01);
    this.dry.gain.setTargetAtTime(this.dryLevel(m), t, 0.01);
  }
  /** Insert effects (reverb/delay) keep the dry signal at unity; override for crossfade. */
  protected dryLevel(_m: number): number { return 1; }
  setEnabled(on: boolean): void { this.enabled = on; this.applyMix(); }
  abstract update(s: InsertState, bpm: number): void;
  dispose(): void { this.input.disconnect(); this.output.disconnect(); }
}

class ReverbInsert extends NativeInsert {
  private pre: DelayNode; private conv: ConvolverNode; private lowCut: BiquadFilterNode;
  private irKey = ''; private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(ctx: BaseAudioContext, id: string, s: InsertState, bpm: number) {
    super(ctx, id, 'reverb');
    this.pre = ctx.createDelay(1); this.conv = ctx.createConvolver(); this.conv.normalize = false;
    this.lowCut = ctx.createBiquadFilter(); this.lowCut.type = 'highpass';
    this.input.connect(this.pre).connect(this.lowCut).connect(this.conv).connect(this.wet);
    this.update(s, bpm, true);
  }
  protected dryLevel(m: number): number { return 1 - m * 0.5; }
  update(s: InsertState, _bpm = 0, immediate = false): void {
    const p = s.params;
    this.pre.delayTime.value = num(p, 'predelay') / 1000;
    this.lowCut.frequency.value = num(p, 'lowCut');
    this.mix = num(p, 'mix'); this.enabled = s.enabled; this.applyMix();
    const key = [p.algo, p.decay, p.damping, p.width].join('|');
    if (key !== this.irKey) {
      this.irKey = key;
      const build = (): void => {
        const ir = generateImpulse(this.ctx.sampleRate, { algo: p.algo as 'room', decay: num(p, 'decay'), damping: num(p, 'damping'), width: num(p, 'width') });
        const b = this.ctx.createBuffer(2, ir[0].length, this.ctx.sampleRate);
        b.copyToChannel(ir[0], 0); b.copyToChannel(ir[1], 1);
        this.conv.buffer = b;
      };
      if (this.timer) clearTimeout(this.timer);
      if (immediate) build(); else this.timer = setTimeout(build, 120);
    }
  }
}

class DelayInsert extends NativeInsert {
  private dl: DelayNode; private dr: DelayNode; private fbL: GainNode; private fbR: GainNode;
  private hp: BiquadFilterNode; private lp: BiquadFilterNode; private split: ChannelSplitterNode; private merge: ChannelMergerNode;
  private mono: GainNode; private pingpong = false;
  constructor(ctx: BaseAudioContext, id: string, s: InsertState, bpm: number) {
    super(ctx, id, 'delay');
    this.dl = ctx.createDelay(4); this.dr = ctx.createDelay(4);
    this.fbL = ctx.createGain(); this.fbR = ctx.createGain();
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass';
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass';
    this.split = ctx.createChannelSplitter(2); this.merge = ctx.createChannelMerger(2);
    this.mono = ctx.createGain(); this.mono.channelCount = 1; this.mono.channelCountMode = 'explicit';
    this.input.connect(this.hp).connect(this.lp).connect(this.split);
    this.pingpong = !!s.params.pingpong; this.wire(this.pingpong);
    this.update(s, bpm);
  }
  private wire(pp: boolean): void {
    [this.split, this.mono, this.dl, this.dr, this.fbL, this.fbR, this.merge].forEach((n) => n.disconnect());
    this.merge.connect(this.wet);
    if (pp) {
      // mono in -> L delay -> R delay -> L delay ... (cross feedback)
      this.split.connect(this.mono, 0); this.split.connect(this.mono, 1);
      this.mono.connect(this.dl);
      this.dl.connect(this.merge, 0, 0); this.dl.connect(this.fbL).connect(this.dr);
      this.dr.connect(this.merge, 0, 1); this.dr.connect(this.fbR).connect(this.dl);
    } else {
      this.split.connect(this.dl, 0); this.split.connect(this.dr, 1);
      this.dl.connect(this.merge, 0, 0); this.dl.connect(this.fbL).connect(this.dl);
      this.dr.connect(this.merge, 0, 1); this.dr.connect(this.fbR).connect(this.dr);
    }
  }
  update(s: InsertState, bpm: number): void {
    const p = s.params;
    const pp = !!p.pingpong;
    if (pp !== this.pingpong) { this.wire(pp); this.pingpong = pp; }
    const t = Math.min(3.9, delaySeconds(p, bpm));
    const now = this.ctx.currentTime;
    this.dl.delayTime.setTargetAtTime(t, now, 0.02); this.dr.delayTime.setTargetAtTime(t, now, 0.02);
    const fb = Math.min(0.95, num(p, 'feedback'));
    this.fbL.gain.value = fb; this.fbR.gain.value = fb;
    this.hp.frequency.value = num(p, 'lowCut'); this.lp.frequency.value = num(p, 'highCut');
    this.mix = num(p, 'mix'); this.enabled = s.enabled; this.applyMix();
  }
}

class ChorusInsert extends NativeInsert {
  private d: DelayNode[] = []; private lfo: OscillatorNode[] = []; private depth: GainNode[] = []; private fb: GainNode[] = [];
  private split: ChannelSplitterNode; private merge: ChannelMergerNode;
  constructor(ctx: BaseAudioContext, id: string, s: InsertState) {
    super(ctx, id, 'chorus');
    this.split = ctx.createChannelSplitter(2); this.merge = ctx.createChannelMerger(2);
    this.input.connect(this.split);
    for (let c = 0; c < 2; c++) {
      const d = ctx.createDelay(0.1), o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createGain();
      o.connect(g).connect(d.delayTime);
      this.split.connect(d, c); d.connect(this.merge, 0, c); d.connect(f).connect(d);
      o.start();
      this.d.push(d); this.lfo.push(o); this.depth.push(g); this.fb.push(f);
    }
    this.merge.connect(this.wet);
    this.update(s);
  }
  protected dryLevel(m: number): number { return 1 - m * 0.5; }
  update(s: InsertState): void {
    const p = s.params;
    const rate = num(p, 'rate'), depth = num(p, 'depth') / 1000, base = num(p, 'delay') / 1000;
    for (let c = 0; c < 2; c++) {
      this.lfo[c].frequency.value = rate * (c ? 1.07 : 1);
      this.depth[c].gain.value = depth / 2;
      this.d[c].delayTime.value = base + depth / 2;
      this.fb[c].gain.value = num(p, 'feedback');
    }
    this.mix = num(p, 'mix'); this.enabled = s.enabled; this.applyMix();
  }
  dispose(): void { this.lfo.forEach((o) => o.stop()); super.dispose(); }
}

class DoublerInsert extends NativeInsert {
  private parts: { d: DelayNode; o: OscillatorNode; g: GainNode; pan: StereoPannerNode }[] = [];
  constructor(ctx: BaseAudioContext, id: string, s: InsertState) {
    super(ctx, id, 'doubler');
    const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
    this.input.connect(mono);
    for (let i = 0; i < 2; i++) {
      const d = ctx.createDelay(0.2), o = ctx.createOscillator(), g = ctx.createGain(), pan = ctx.createStereoPanner();
      o.frequency.value = i ? 0.23 : 0.31;
      o.connect(g).connect(d.delayTime); o.start();
      mono.connect(d).connect(pan).connect(this.wet);
      this.parts.push({ d, o, g, pan });
    }
    this.update(s);
  }
  update(s: InsertState): void {
    const p = s.params;
    const spread = num(p, 'spread') / 1000, det = num(p, 'detune') / 1000, w = num(p, 'width');
    this.parts.forEach((x, i) => {
      x.d.delayTime.value = spread * (i ? 1.37 : 1); x.g.gain.value = det; x.pan.pan.value = i ? w : -w;
    });
    this.mix = num(p, 'mix'); this.enabled = s.enabled; this.applyMix();
  }
  dispose(): void { this.parts.forEach((x) => x.o.stop()); super.dispose(); }
}

export function createInsertNode(ctx: BaseAudioContext, s: InsertState, bpm: number): InsertNode {
  const def = PLUGINS[s.type];
  if (def.engine === 'worklet') return new WorkletInsert(ctx, s.id, s.type, s);
  switch (s.type) {
    case 'reverb': return new ReverbInsert(ctx, s.id, s, bpm);
    case 'delay': return new DelayInsert(ctx, s.id, s, bpm);
    case 'chorus': return new ChorusInsert(ctx, s.id, s);
    case 'doubler': return new DoublerInsert(ctx, s.id, s);
    default: throw new Error(`Unknown plugin ${s.type}`);
  }
}
