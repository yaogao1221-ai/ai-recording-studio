import { workletUrl } from './engine';
import type { Project } from './model';
import { projectDuration } from './model';
import { MixGraph, type GraphOptions } from './graph/mixgraph';
import { scheduleWindow } from './graph/scheduler';
import { encodeWav, type BitDepth } from './dsp/wav';
import { analyzeChannels, type Analysis } from './analysis/analyze';

export interface RenderOptions {
  sampleRate: number; from?: number; to?: number; tail?: number; graph?: GraphOptions;
}

/** Render the project offline through exactly the same graph/DSP as realtime playback. */
export async function renderProject(p: Project, buffers: Map<string, AudioBuffer>, o: RenderOptions): Promise<AudioBuffer> {
  const from = o.from ?? 0;
  const to = o.to ?? projectDuration(p);
  const tail = o.tail ?? 2;
  const len = Math.max(1, Math.ceil((to - from + tail) * o.sampleRate));
  const ctx = new OfflineAudioContext(2, len, o.sampleRate);
  await ctx.audioWorklet.addModule(workletUrl);
  const graph = new MixGraph(ctx, o.graph);
  graph.sync(p);
  scheduleWindow(ctx, graph, p, buffers, from, to, 0);
  return ctx.startRendering();
}

export type ExportTarget = 'mix' | 'stems' | 'instrumental' | 'vocals' | 'buses';
export interface ExportOptions { sampleRate: 44100 | 48000 | 96000; bitDepth: BitDepth; target: ExportTarget; normalizeTail?: boolean }
export interface ExportFile { name: string; blob: Blob; analysis: Analysis; sampleRate: number; bitDepth: number; duration: number }

/** Trim trailing silence (keeps the reverb/delay tail up to where it falls under -90 dBFS). */
function trimTail(ch: Float32Array[], minLen: number): Float32Array[] {
  let end = ch[0].length;
  const th = 3e-5;
  while (end > minLen && ch.every((c) => Math.abs(c[end - 1]) < th)) end--;
  return ch.map((c) => c.slice(0, end));
}

export async function exportProject(p: Project, buffers: Map<string, AudioBuffer>, o: ExportOptions,
  onProgress?: (msg: string) => void): Promise<ExportFile[]> {
  const dur = projectDuration(p);
  if (dur <= 0) throw new Error('Le projet est vide : rien à exporter.');
  const jobs: { name: string; graph: GraphOptions }[] = [];
  const safe = p.name.replace(/[^\w\- ]+/g, '').trim() || 'mix';
  const vocalRoles = new Set(['lead', 'double', 'adlib', 'harmony']);
  const hasClips = (id: string): boolean => p.clips.some((c) => c.trackId === id && !c.muted);
  switch (o.target) {
    case 'mix': jobs.push({ name: `${safe}`, graph: {} }); break;
    case 'instrumental': jobs.push({ name: `${safe} - Instrumental`, graph: { onlyTracks: p.tracks.filter((t) => !vocalRoles.has(t.role)).map((t) => t.id) } }); break;
    case 'vocals': jobs.push({ name: `${safe} - Voix`, graph: { onlyTracks: p.tracks.filter((t) => vocalRoles.has(t.role)).map((t) => t.id) } }); break;
    case 'stems':
      for (const t of p.tracks) if (hasClips(t.id)) jobs.push({ name: `${safe} - ${t.name}`, graph: { onlyTracks: [t.id], bypassMaster: true, directToMaster: true } });
      break;
    case 'buses':
      for (const b of p.buses) {
        const ids = p.tracks.filter((t) => t.output === b.id && hasClips(t.id)).map((t) => t.id);
        if (ids.length) jobs.push({ name: `${safe} - ${b.name}`, graph: { onlyTracks: ids, bypassMaster: true } });
      }
      break;
  }
  const files: ExportFile[] = [];
  for (const j of jobs) {
    onProgress?.(`Rendu : ${j.name}`);
    const buf = await renderProject(p, buffers, { sampleRate: o.sampleRate, graph: j.graph, tail: 4 });
    const ch = trimTail([buf.getChannelData(0), buf.getChannelData(1)], Math.ceil(dur * o.sampleRate));
    const analysis = analyzeChannels(ch, o.sampleRate, { spectrum: false });
    const wav = encodeWav(ch, o.sampleRate, o.bitDepth);
    files.push({ name: `${j.name}.wav`, blob: new Blob([wav], { type: 'audio/wav' }), analysis, sampleRate: o.sampleRate, bitDepth: o.bitDepth, duration: ch[0].length / o.sampleRate });
  }
  return files;
}

export function estimateWavBytes(seconds: number, sr: number, bits: number, ch = 2): number { return 44 + Math.ceil(seconds * sr) * ch * (bits / 8); }
