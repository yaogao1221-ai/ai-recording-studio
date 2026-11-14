/** Portable session file (.arsession): project JSON + every referenced asset (base64). */
import type { Project } from './model';
import { loadAsset, saveAsset, saveProject } from './storage';
import { uid } from './plugins/registry';

interface SessionFile { format: 'ai-recording-studio-session'; version: 1; project: Project; assets: { id: string; name: string; sampleRate: number; channels: number; duration: number; type: string; data: string }[] }

const b64 = async (b: Blob): Promise<string> => {
  const bytes = new Uint8Array(await b.arrayBuffer()); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string, type: string): Blob => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };

export async function exportSession(p: Project): Promise<Blob> {
  const ids = [...new Set(p.clips.map((c) => c.assetId))];
  const assets: SessionFile['assets'] = [];
  for (const id of ids) {
    const a = await loadAsset(id); if (!a) continue;
    assets.push({ id, name: a.name, sampleRate: a.sampleRate, channels: a.channels, duration: a.duration, type: a.blob.type, data: await b64(a.blob) });
  }
  const f: SessionFile = { format: 'ai-recording-studio-session', version: 1, project: p, assets };
  return new Blob([JSON.stringify(f)], { type: 'application/json' });
}

export async function importSession(file: Blob): Promise<Project> {
  const f = JSON.parse(await file.text()) as SessionFile;
  if (f.format !== 'ai-recording-studio-session') throw new Error('Fichier de session invalide.');
  for (const a of f.assets) await saveAsset({ id: a.id, name: a.name, sampleRate: a.sampleRate, channels: a.channels, duration: a.duration, createdAt: Date.now(), blob: unb64(a.data, a.type) });
  const p = { ...f.project, id: uid('prj'), name: f.project.name + ' (importé)', updatedAt: Date.now() };
  await saveProject(p);
  return p;
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
