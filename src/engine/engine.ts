import workletUrl from './worklets/studio-processors.ts?worker&url';
import type { Clip, Project } from './model';
import { MixGraph } from './graph/mixgraph';
import { scheduleWindow, stopAll, type Scheduled } from './graph/scheduler';
import { closeInput, configureAudioSession, openInput, type ActiveInput, type OpenOptions } from './input';
import { dbToGain } from './dsp/util';
import { uid } from './plugins/registry';

export { workletUrl };

export interface InputLevel { peak: number; rms: number; clips: number }
export interface RecordResult { clip: Clip; buffer: AudioBuffer; latencyMs: number }

type Listener = () => void;

/**
 * Realtime audio engine: owns the AudioContext, the mixer graph, the transport
 * and the recorder. The UI never touches Web Audio nodes directly.
 */
export class AudioEngine {
  ctx!: AudioContext;
  graph!: MixGraph;
  readonly buffers = new Map<string, AudioBuffer>();
  private project!: Project;
  private ready: Promise<void> | null = null;

  // transport
  playing = false;
  private startCtx = 0; // context time when timeline position startPos plays
  private startPos = 0;
  private position = 0;
  private sources: Scheduled[] = [];
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private nextLoopCtx = 0;

  // recording
  input: ActiveInput | null = null;
  private inSrc: MediaStreamAudioSourceNode | null = null;
  private inGain: GainNode | null = null;
  private monitor: GainNode | null = null;
  private recNode: AudioWorkletNode | null = null;
  inputLevel: InputLevel = { peak: 0, rms: 0, clips: 0 };
  recording = false;
  private recChunks: Float32Array[][] = [];
  private recTrackId = '';
  private recResolve: ((r: { firstFrame: number; channels: number }) => void) | null = null;
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { this.listeners.forEach((f) => f()); }

  /** Must be called from a user gesture on iOS. */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      configureAudioSession('play-and-record');
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.graph = new MixGraph(this.ctx);
      if (this.project) this.graph.sync(this.project);
    })();
    return this.ready;
  }
  get isReady(): boolean { return !!this.graph; }

  async resume(): Promise<void> { await this.init(); if (this.ctx.state !== 'running') await this.ctx.resume(); }

  setProject(p: Project): void {
    const prev = this.project;
    this.project = p;
    if (!this.graph) return;
    this.graph.sync(p);
    // restart playback if clip layout or loop changed while playing
    if (this.playing && prev && (prev.clips !== p.clips || prev.loop !== p.loop)) this.play(this.getPosition());
  }

  // ---------- assets ----------
  async decode(data: ArrayBuffer): Promise<AudioBuffer> { await this.init(); return this.ctx.decodeAudioData(data); }
  addBuffer(id: string, b: AudioBuffer): void { this.buffers.set(id, b); }

  // ---------- transport ----------
  getPosition(): number {
    if (!this.playing) return this.position;
    const t = this.ctx.currentTime - this.startCtx;
    let pos = this.startPos + Math.max(0, t);
    const l = this.project.loop;
    if (l.on && l.end > l.start && this.startPos < l.end && pos >= l.end) {
      const len = l.end - l.start;
      pos = l.start + ((pos - l.end) % len);
    }
    return pos;
  }
  /** Position the listener hears right now (compensates output latency) — use for the playhead. */
  getAudiblePosition(): number {
    if (!this.playing) return this.position;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(0, this.getPosition() - lat);
  }

  seek(pos: number): void {
    this.position = Math.max(0, pos);
    if (this.playing) this.play(this.position); else this.emit();
  }

  async play(from = this.position): Promise<void> {
    await this.resume();
    this.stopSources();
    const p = this.project;
    this.startPos = Math.max(0, from);
    this.startCtx = this.ctx.currentTime + 0.06;
    this.playing = true;
    const l = p.loop;
    if (l.on && l.end > l.start && this.startPos < l.end) {
      this.sources = scheduleWindow(this.ctx, this.graph, p, this.buffers, this.startPos, l.end, this.startCtx);
      this.nextLoopCtx = this.startCtx + (l.end - this.startPos);
      this.loopTimer = setInterval(() => this.loopTick(), 50);
    } else {
      this.sources = scheduleWindow(this.ctx, this.graph, p, this.buffers, this.startPos, Infinity, this.startCtx);
    }
    this.emit();
  }

  private loopTick(): void {
    const l = this.project.loop;
    if (!this.playing || !l.on) return;
    if (this.ctx.currentTime > this.nextLoopCtx - 0.3) {
      // drop finished sources, schedule the next iteration sample-accurately
      this.sources = this.sources.filter((s) => s.src.buffer && this.ctx.currentTime < this.nextLoopCtx + 1);
      this.sources.push(...scheduleWindow(this.ctx, this.graph, this.project, this.buffers, l.start, l.end, this.nextLoopCtx));
      this.nextLoopCtx += l.end - l.start;
    }
  }

  private stopSources(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    stopAll(this.sources); this.sources = [];
  }

  stop(): void {
    if (this.playing) this.position = this.getPosition();
    this.playing = false;
    this.stopSources();
    this.emit();
  }

  // ---------- input / monitoring ----------
  async openMic(o: OpenOptions): Promise<ActiveInput> {
    await this.resume();
    this.closeMic();
    const a = await openInput(o);
    this.input = a;
    this.inSrc = this.ctx.createMediaStreamSource(a.stream);
    this.inGain = this.ctx.createGain();
    this.monitor = this.ctx.createGain(); this.monitor.gain.value = 0;
    this.recNode = new AudioWorkletNode(this.ctx, 'studio-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.recNode.port.onmessage = (e) => this.onRecMessage(e.data);
    this.inSrc.connect(this.inGain);
    this.inGain.connect(this.recNode);
    this.inGain.connect(this.monitor).connect(this.ctx.destination);
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    this.recNode.connect(sink).connect(this.ctx.destination); // keeps the recorder pulled
    a.track.addEventListener('ended', () => { this.input = null; this.emit(); });
    this.emit();
    return a;
  }
  closeMic(): void {
    if (this.recording) return;
    closeInput(this.input); this.input = null;
    [this.inSrc, this.inGain, this.monitor, this.recNode].forEach((n) => n?.disconnect());
    this.recNode?.port.postMessage({ cmd: 'dispose' });
    this.inSrc = null; this.inGain = null; this.monitor = null; this.recNode = null;
    this.inputLevel = { peak: 0, rms: 0, clips: 0 };
    this.emit();
  }
  setInputGain(db: number): void { this.inGain?.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01); }
  setMonitor(on: boolean, db = 0): void { this.monitor?.gain.setTargetAtTime(on ? dbToGain(db) : 0, this.ctx.currentTime, 0.01); }

  private onRecMessage(m: { level?: InputLevel; chunk?: Float32Array[]; done?: boolean; firstFrame?: number; channels?: number }): void {
    if (m.level) { this.inputLevel = m.level; return; }
    if (m.chunk) { this.recChunks.push(m.chunk); return; }
    if (m.done && this.recResolve) { this.recResolve({ firstFrame: m.firstFrame ?? -1, channels: m.channels ?? 1 }); this.recResolve = null; }
  }

  /** Estimated round-trip latency to compensate (s). */
  latencySeconds(): number {
    const out = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const inLat = (this.input?.settings as MediaTrackSettings & { latency?: number })?.latency ?? 0;
    return out + inLat + (this.project.recordOffsetMs || 0) / 1000;
  }

  /**
   * Start recording on a track. Playback starts `preroll` seconds before the
   * record position; capture starts exactly when the timeline reaches it.
   */
  async startRecording(trackId: string, at = this.position): Promise<void> {
    if (!this.recNode || !this.input) throw new Error('Aucun micro ouvert.');
    if (this.recording) return;
    const p = this.project;
    const recStart = p.punch.on ? p.punch.start : at;
    const from = Math.max(0, recStart - p.preroll);
    this.recChunks = []; this.recTrackId = trackId; this.recording = true;
    await this.play(from);
    const startFrame = Math.round((this.startCtx + (recStart - from)) * this.ctx.sampleRate);
    this.recNode.port.postMessage({ cmd: 'start', startFrame });
    this.recStartPos = recStart;
    if (p.punch.on) {
      const stopAt = this.startCtx + (p.punch.end - from);
      this.punchTimer = setInterval(() => { if (this.ctx.currentTime >= stopAt + 0.05) void this.stopRecording(); }, 20);
    }
    this.emit();
  }
  private recStartPos = 0;
  private punchTimer: ReturnType<typeof setInterval> | null = null;
  onRecorded: ((r: RecordResult) => void) | null = null;

  async stopRecording(): Promise<RecordResult | null> {
    if (!this.recording || !this.recNode) return null;
    if (this.punchTimer) clearInterval(this.punchTimer); this.punchTimer = null;
    const done = new Promise<{ firstFrame: number; channels: number }>((r) => { this.recResolve = r; });
    this.recNode.port.postMessage({ cmd: 'stop' });
    const info = await done;
    this.recording = false;
    this.stop();
    const total = this.recChunks.reduce((n, c) => n + c[0].length, 0);
    if (total === 0 || info.firstFrame < 0) { this.emit(); return null; }
    const stereo = info.channels > 1 && (this.input?.settings.channelCount ?? 1) > 1;
    const buf = this.ctx.createBuffer(stereo ? 2 : 1, total, this.ctx.sampleRate);
    let o = 0;
    const L = buf.getChannelData(0), R = stereo ? buf.getChannelData(1) : null;
    for (const c of this.recChunks) { L.set(c[0], o); R?.set(c[1], o); o += c[0].length; }
    this.recChunks = [];
    const lat = this.latencySeconds();
    const sr = this.ctx.sampleRate;
    // timeline position of the first captured sample, minus round-trip latency
    let start = this.recStartPos + (info.firstFrame / sr - (this.startCtxAtRec(info.firstFrame))) - lat;
    let offset = 0;
    if (start < 0) { offset = -start; start = 0; }
    let duration = buf.duration - offset;
    const p = this.project;
    if (p.punch.on) {
      const pOff = Math.max(0, p.punch.start - start);
      offset += pOff; start += pOff; duration = Math.min(duration - pOff, p.punch.end - start);
    }
    const take = p.clips.filter((c) => c.trackId === this.recTrackId).reduce((m, c) => Math.max(m, c.take ?? 0), 0) + 1;
    const clip: Clip = {
      id: uid('clip'), trackId: this.recTrackId, assetId: uid('rec'), name: `Prise ${take}`,
      start, offset, duration: Math.max(0.01, duration), gain: 0, fadeIn: 0.005, fadeOut: 0.01, muted: false, take,
    };
    this.buffers.set(clip.assetId, buf);
    const r = { clip, buffer: buf, latencyMs: lat * 1000 };
    this.onRecorded?.(r);
    this.emit();
    return r;
  }
  /** Record `sec` seconds from the open mic without the transport (mic test), then return the buffer. */
  async testRecord(sec: number): Promise<AudioBuffer | null> {
    if (!this.recNode || this.recording) return null;
    this.recChunks = [];
    const done = new Promise<{ firstFrame: number; channels: number }>((r) => { this.recResolve = r; });
    this.recNode.port.postMessage({ cmd: 'start', startFrame: 0 });
    await new Promise((r) => setTimeout(r, sec * 1000));
    this.recNode.port.postMessage({ cmd: 'stop' });
    await done;
    const total = this.recChunks.reduce((n, c) => n + c[0].length, 0);
    if (!total) return null;
    const buf = this.ctx.createBuffer(1, total, this.ctx.sampleRate);
    let o = 0; for (const c of this.recChunks) { buf.getChannelData(0).set(c[0], o); o += c[0].length; }
    this.recChunks = [];
    return buf;
  }
  /** Play a buffer directly to the output (previews). */
  preview(buf: AudioBuffer): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.ctx.destination); s.start(); return s;
  }

  /** first captured frame corresponds to recStartPos at startFrame; difference is sub-block alignment */
  private startCtxAtRec(firstFrame: number): number {
    const expected = this.startCtx + (this.recStartPos - this.startPos);
    return Math.abs(firstFrame / this.ctx.sampleRate - expected) < 1 ? expected : firstFrame / this.ctx.sampleRate;
  }
}

export const engine = new AudioEngine();
