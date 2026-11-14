import { engine } from '../engine/engine';
import type { AssetMeta, Clip, Project } from '../engine/model';
import { uid } from '../engine/plugins/registry';
import { loadAsset, saveAsset } from '../engine/storage';
import { encodeWav } from '../engine/dsp/wav';
import { getState, toast, update } from './store';

/** Waveform peak cache: min/max per 128-sample bucket. */
const peaks = new Map<string, { min: Float32Array; max: Float32Array; bucket: number }>();
export function getPeaks(assetId: string): { min: Float32Array; max: Float32Array; bucket: number } | null {
  const hit = peaks.get(assetId); if (hit) return hit;
  const b = engine.buffers.get(assetId); if (!b) return null;
  const bucket = 128; const n = Math.ceil(b.length / bucket);
  const min = new Float32Array(n), max = new Float32Array(n);
  const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    const e = Math.min(b.length, (i + 1) * bucket);
    for (const ch of chans) for (let k = i * bucket; k < e; k++) { const v = ch[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[i] = lo; max[i] = hi;
  }
  const r = { min, max, bucket }; peaks.set(assetId, r); return r;
}

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|caf|webm)$/i;

export async function importFiles(files: File[], trackId?: string, at = 0): Promise<void> {
  const list = files.filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!list.length) { toast('Aucun fichier audio reconnu.'); return; }
  for (const f of list) {
    try {
      const buf = await engine.decode(await f.arrayBuffer());
      const id = uid('asset');
      engine.addBuffer(id, buf);
      const meta: AssetMeta = { id, name: f.name, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, duration: buf.duration, createdAt: Date.now() };
      await saveAsset({ ...meta, blob: f });
      const p = getState().project;
      const target = trackId ?? p.tracks.find((t) => t.role === 'beat' && !p.clips.some((c) => c.trackId === t.id))?.id ?? p.tracks[0]?.id;
      if (!target) return;
      const clip: Clip = { id: uid('clip'), trackId: target, assetId: id, name: f.name.replace(/\.[^.]+$/, ''), start: at, offset: 0, duration: buf.duration, gain: 0, fadeIn: 0, fadeOut: 0, muted: false };
      update((d) => { d.clips.push(clip); });
      toast(`Importé : ${f.name} (${buf.duration.toFixed(1)} s, ${buf.sampleRate} Hz)`);
    } catch (e) {
      toast(`Impossible de décoder ${f.name} : ${(e as Error).message || 'format non supporté par ce navigateur'}`);
    }
  }
}

/** Persist a recorded buffer as a 32-bit float WAV (lossless). */
export async function persistRecording(assetId: string, buf: AudioBuffer, name: string): Promise<void> {
  const ch = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const blob = new Blob([encodeWav(ch, buf.sampleRate, 32)], { type: 'audio/wav' });
  await saveAsset({ id: assetId, name, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, duration: buf.duration, createdAt: Date.now(), blob });
}

/** Load every asset referenced by a project into the engine. Returns missing asset ids. */
export async function loadProjectAssets(p: Project): Promise<string[]> {
  const ids = [...new Set(p.clips.map((c) => c.assetId))].filter((id) => !engine.buffers.has(id));
  const missing: string[] = [];
  for (const id of ids) {
    const a = await loadAsset(id);
    if (!a) { missing.push(id); continue; }
    try { engine.addBuffer(id, await engine.decode(await a.blob.arrayBuffer())); } catch { missing.push(id); }
  }
  return missing;
}

/** Concatenate the (unprocessed) audio of a track's active clips, for analysis. */
export function trackRawAudio(p: Project, trackId: string): Float32Array[] | null {
  const clips = p.clips.filter((c) => c.trackId === trackId && !c.muted);
  if (!clips.length) return null;
  const sr = engine.ctx?.sampleRate ?? 48000;
  const parts: Float32Array[][] = [];
  for (const c of clips) {
    const b = engine.buffers.get(c.assetId); if (!b) continue;
    const s = Math.floor(c.offset * b.sampleRate), e = Math.min(b.length, s + Math.floor(c.duration * b.sampleRate));
    const L = b.getChannelData(0).slice(s, e), R = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice(s, e);
    parts.push([L, R]);
  }
  if (!parts.length) return null;
  const len = parts.reduce((n, x) => n + x[0].length, 0);
  const L = new Float32Array(len), R = new Float32Array(len);
  let o = 0; for (const [l, r] of parts) { L.set(l, o); R.set(r, o); o += l.length; }
  void sr;
  return [L, R];
}
