import type { Bus, Project, Track } from '../model';
import type { InsertState } from '../plugins/registry';
import { dbToGain } from '../dsp/util';
import { createInsertNode, type InsertNode } from './inserts';

export interface MeterReading {
  peakL: number; peakR: number; rmsL: number; rmsR: number;
  truePeak?: number; momentary?: number; shortTerm?: number; integrated?: number; lra?: number; correlation?: number;
}

/**
 * One mixer channel: input -> inserts... -> fader -> pan -> mute -> meter -> (bus | master | destination)
 */
export class Strip {
  readonly input: GainNode;
  private fader: GainNode; private panner: StereoPannerNode | null; private muteGain: GainNode;
  readonly meter: AudioWorkletNode;
  readonly analyser: AnalyserNode | null = null;
  inserts: InsertNode[] = [];
  private insertKey = '';
  meterValue: MeterReading = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
  gr: Record<string, number> = {};
  dest: string | null = null;

  constructor(private ctx: BaseAudioContext, readonly id: string, full: boolean, withAnalyser = false) {
    this.input = ctx.createGain();
    this.fader = ctx.createGain();
    this.panner = id === 'master' ? null : ctx.createStereoPanner();
    this.muteGain = ctx.createGain();
    this.meter = new AudioWorkletNode(ctx, 'studio-meter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      processorOptions: { full },
    });
    this.meter.port.onmessage = (e) => { this.meterValue = e.data; };
    if (this.panner) this.fader.connect(this.panner).connect(this.muteGain); else this.fader.connect(this.muteGain);
    this.muteGain.connect(this.meter);
    if (withAnalyser) {
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 8192; this.analyser.smoothingTimeConstant = 0.75;
      this.meter.connect(this.analyser);
    }
    this.input.connect(this.fader);
  }

  get output(): AudioNode { return this.meter; }

  syncInserts(list: InsertState[], bpm: number): void {
    const key = list.map((i) => i.id + ':' + i.type).join(',');
    if (key !== this.insertKey) {
      // rebuild chain, reusing existing nodes by id (keeps DSP state, allows reorder)
      const old = new Map(this.inserts.map((n) => [n.id, n]));
      this.input.disconnect();
      this.inserts.forEach((n) => n.output.disconnect());
      const next: InsertNode[] = [];
      for (const s of list) {
        let node = old.get(s.id);
        if (node && node.type === s.type) old.delete(s.id);
        else { node = createInsertNode(this.ctx, s, bpm); }
        node.onGr = (db) => { this.gr[s.id] = db; };
        next.push(node);
      }
      old.forEach((n) => n.dispose());
      let prev: AudioNode = this.input;
      for (const n of next) { prev.connect(n.input); prev = n.output; }
      prev.connect(this.fader);
      this.inserts = next;
      this.insertKey = key;
    }
    list.forEach((s, i) => this.inserts[i].update(s, bpm));
  }

  setLevels(volumeDb: number, pan: number, audible: boolean): void {
    const t = this.ctx.currentTime;
    this.fader.gain.setTargetAtTime(dbToGain(volumeDb), t, 0.01);
    this.panner?.pan.setTargetAtTime(pan, t, 0.01);
    this.muteGain.gain.setTargetAtTime(audible ? 1 : 0, t, 0.005);
  }

  connectTo(dest: string, node: AudioNode): void {
    if (this.dest === dest) return;
    this.meter.disconnect();
    if (this.analyser) this.meter.connect(this.analyser);
    this.meter.connect(node);
    this.dest = dest;
  }

  dispose(): void {
    this.inserts.forEach((n) => n.dispose());
    this.meter.port.postMessage({ cmd: 'dispose' });
    [this.input, this.fader, this.muteGain, this.meter].forEach((n) => n.disconnect());
    this.panner?.disconnect();
  }
}

export interface GraphOptions {
  /** Only these track ids are audible (used for stem export). */
  onlyTracks?: string[];
  /** Skip master inserts (stems are exported without master processing). */
  bypassMaster?: boolean;
  /** Track ids whose output goes straight to master, skipping buses (stems). */
  directToMaster?: boolean;
}

/** The whole mixer, built on any BaseAudioContext (realtime or offline). */
export class MixGraph {
  readonly strips = new Map<string, Strip>();
  readonly master: Strip;
  private trackInputs = new Map<string, GainNode>(); // per-track input gain (recording/clip entry point)

  constructor(private ctx: BaseAudioContext, private opts: GraphOptions = {}) {
    this.master = new Strip(ctx, 'master', true, ctx instanceof AudioContext);
    this.master.connectTo('destination', ctx.destination);
  }

  /** Entry node where clip sources for a track should connect. */
  trackInput(id: string): AudioNode | undefined { return this.trackInputs.get(id); }

  sync(p: Project): void {
    const channels: (Track | Bus)[] = [...p.buses, ...p.tracks];
    const ids = new Set(channels.map((c) => c.id));
    for (const [id, s] of this.strips) if (!ids.has(id)) { s.dispose(); this.strips.delete(id); this.trackInputs.get(id)?.disconnect(); this.trackInputs.delete(id); }
    for (const c of channels) {
      if (!this.strips.has(c.id)) {
        const s = new Strip(this.ctx, c.id, false);
        this.strips.set(c.id, s);
        if (c.kind === 'track') { const g = this.ctx.createGain(); g.connect(s.input); this.trackInputs.set(c.id, g); }
      }
    }
    const anySolo = p.tracks.some((t) => t.solo) || p.buses.some((b) => b.solo);
    // a bus is "soloed" implicitly if any of its tracks is soloed
    const busHasSolo = new Set(p.tracks.filter((t) => t.solo).map((t) => t.output));
    const only = this.opts.onlyTracks ? new Set(this.opts.onlyTracks) : null;
    for (const b of p.buses) this.applyChannel(b, p, anySolo ? b.solo || busHasSolo.has(b.id) : true);
    for (const t of p.tracks) {
      let audible = !t.mute && (anySolo ? t.solo || (p.buses.find((b) => b.id === t.output)?.solo ?? false) : true);
      if (only) audible = only.has(t.id) && !t.mute;
      this.applyChannel(t, p, audible);
      this.trackInputs.get(t.id)!.gain.setTargetAtTime(dbToGain((t as Track).inputGain), this.ctx.currentTime, 0.01);
    }
    this.master.syncInserts(this.opts.bypassMaster ? [] : p.master.inserts, p.bpm);
    this.master.setLevels(this.opts.bypassMaster ? 0 : p.master.volume, 0, true);
  }

  private applyChannel(c: Track | Bus, p: Project, audible: boolean): void {
    const s = this.strips.get(c.id)!;
    s.syncInserts(c.inserts, p.bpm);
    s.setLevels(c.volume, c.pan, audible && !(c.kind === 'bus' && c.mute));
    let dest = c.output;
    if (this.opts.directToMaster && c.kind === 'track') dest = 'master';
    const target = dest !== 'master' && this.strips.has(dest) && dest !== c.id ? this.strips.get(dest)!.input : this.master.input;
    s.connectTo(target === this.master.input ? 'master' : dest, target);
  }

  dispose(): void { this.strips.forEach((s) => s.dispose()); this.master.dispose(); }
}
