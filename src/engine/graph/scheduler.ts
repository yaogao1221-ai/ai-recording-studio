import type { Clip, Project } from '../model';
import { dbToGain } from '../dsp/util';
import type { MixGraph } from './mixgraph';

export interface Scheduled { src: AudioBufferSourceNode; gain: GainNode }

/**
 * Schedule every clip part overlapping the timeline window [from, to) so that
 * timeline position `from` plays at context time `when`.
 */
export function scheduleWindow(
  ctx: BaseAudioContext, graph: MixGraph, p: Project, buffers: Map<string, AudioBuffer>,
  from: number, to: number, when: number,
): Scheduled[] {
  const out: Scheduled[] = [];
  for (const c of p.clips) {
    if (c.muted) continue;
    const buf = buffers.get(c.assetId);
    const dest = graph.trackInput(c.trackId);
    if (!buf || !dest) continue;
    const cEnd = c.start + c.duration;
    if (cEnd <= from || c.start >= to) continue;
    const segStart = Math.max(from, c.start);
    const segEnd = Math.min(to, cEnd);
    const startAt = when + (segStart - from);
    const offset = c.offset + (segStart - c.start);
    const dur = segEnd - segStart;
    if (dur <= 0 || offset >= buf.duration) continue;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain();
    applyClipEnvelope(g.gain, c, segStart, segEnd, startAt);
    src.connect(g).connect(dest);
    src.start(Math.max(startAt, ctx.currentTime), offset, dur);
    out.push({ src, gain: g });
  }
  return out;
}

/** Clip gain with linear fade in/out, evaluated for the played segment. */
function applyClipEnvelope(param: AudioParam, c: Clip, segStart: number, segEnd: number, startAt: number): void {
  const g = dbToGain(c.gain);
  const env = (pos: number): number => {
    const t = pos - c.start;
    let k = 1;
    if (c.fadeIn > 0 && t < c.fadeIn) k = Math.min(k, t / c.fadeIn);
    if (c.fadeOut > 0 && t > c.duration - c.fadeOut) k = Math.min(k, (c.duration - t) / c.fadeOut);
    return Math.max(0, k) * g;
  };
  param.setValueAtTime(env(segStart), startAt);
  const pts = [c.start + c.fadeIn, c.start + c.duration - c.fadeOut, segEnd].filter((x) => x > segStart && x <= segEnd).sort((a, b) => a - b);
  for (const x of pts) param.linearRampToValueAtTime(env(x), startAt + (x - segStart));
}

export function stopAll(list: Scheduled[]): void {
  for (const s of list) { try { s.src.stop(); } catch { /* already stopped */ } s.src.disconnect(); s.gain.disconnect(); }
}
