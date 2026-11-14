import { useState } from 'react';
import { engine } from '../../engine/engine';
import { estimateWavBytes, exportProject, type ExportFile, type ExportOptions, type ExportTarget } from '../../engine/render';
import { projectDuration } from '../../engine/model';
import { download, exportSession } from '../../engine/session';
import { getState, toast, useStore } from '../../state/store';
import { fmtDb, fmtTime } from '../components/common';

const TARGETS: { v: ExportTarget; l: string }[] = [
  { v: 'mix', l: 'Mix / master stéréo' }, { v: 'instrumental', l: 'Instrumental seul' }, { v: 'vocals', l: 'Voix seules' },
  { v: 'stems', l: 'Stems (chaque piste, sans master)' }, { v: 'buses', l: 'Bus (sans master)' },
];
const mb = (b: number): string => (b / 1048576).toFixed(1) + ' Mo';

export function Export(): JSX.Element {
  const p = useStore((s) => s.project);
  const [o, setO] = useState<ExportOptions>({ sampleRate: 48000, bitDepth: 24, target: 'mix' });
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [busy, setBusy] = useState('');
  const dur = projectDuration(p);
  const nFiles = o.target === 'stems' ? p.tracks.filter((t) => p.clips.some((c) => c.trackId === t.id && !c.muted)).length : o.target === 'buses' ? p.buses.length : 1;
  async function run(): Promise<void> {
    if (dur <= 0) { toast('Projet vide.'); return; }
    await engine.init();
    setBusy('Préparation…'); setFiles([]);
    try { setFiles(await exportProject(getState().project, engine.buffers, o, setBusy)); }
    catch (e) { toast('Export impossible : ' + (e as Error).message); }
    finally { setBusy(''); }
  }
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="card">
        <h3>Export audio</h3>
        <div className="params">
          <div className="param"><label>Contenu</label><select value={o.target} onChange={(e) => setO({ ...o, target: e.target.value as ExportTarget })}>{TARGETS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select></div>
          <div className="param"><label>Format</label><select disabled><option>WAV (PCM)</option></select></div>
          <div className="param"><label>Résolution</label><select value={o.bitDepth} onChange={(e) => setO({ ...o, bitDepth: Number(e.target.value) as 16 | 24 | 32 })}><option value={16}>16 bits (dither TPDF)</option><option value={24}>24 bits (dither TPDF)</option><option value={32}>32 bits flottant</option></select></div>
          <div className="param"><label>Fréquence</label><select value={o.sampleRate} onChange={(e) => setO({ ...o, sampleRate: Number(e.target.value) as 44100 | 48000 | 96000 })}><option value={44100}>44,1 kHz</option><option value={48000}>48 kHz</option><option value={96000}>96 kHz</option></select></div>
        </div>
        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="badge">Durée {fmtTime(dur)}</span>
          <span className="badge">{nFiles} fichier(s)</span>
          <span className="badge">Taille estimée {mb(estimateWavBytes(dur + 1, o.sampleRate, o.bitDepth) * nFiles)}</span>
          <span className="sp" />
          <button className="primary" onClick={() => void run()} disabled={!!busy}>{busy || 'Exporter'}</button>
        </div>
        <div className="dim" style={{ marginTop: 8 }}>Le rendu passe hors ligne par exactement les mêmes effets que la lecture (AudioWorklet). MP3/FLAC : pas encore disponibles (encodeur à intégrer, voir la feuille de route).</div>
      </div>
      {files.length > 0 && (
        <div className="card">
          <h3>Fichiers rendus</h3>
          <div className="col">
            {files.map((f) => (
              <div key={f.name} className="row wrap slot" style={{ padding: 10 }}>
                <b className="grow">{f.name}</b>
                <span className="mono dim">{fmtTime(f.duration)} · {f.sampleRate / 1000} kHz · {f.bitDepth === 32 ? '32f' : f.bitDepth + ' bits'} · {mb(f.blob.size)}</span>
                <span className="mono">{fmtDb(f.analysis.integratedLufs)} LUFS · {fmtDb(f.analysis.truePeakDb, 2)} dBTP · crête {fmtDb(f.analysis.samplePeakDb, 2)}</span>
                <button className="primary" onClick={() => download(f.blob, f.name)}>Télécharger</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <h3>Session complète</h3>
        <div className="row wrap"><span className="muted grow">Projet + tous les fichiers audio dans un seul fichier .arsession (réimportable dans Projets).</span>
          <button onClick={async () => { setBusy('Export de la session…'); try { download(await exportSession(getState().project), `${p.name}.arsession`); } finally { setBusy(''); } }}>Exporter la session</button></div>
      </div>
    </div>
  );
}
