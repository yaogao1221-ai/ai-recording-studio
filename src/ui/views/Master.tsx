import { useState } from 'react';
import { engine } from '../../engine/engine';
import { analyzeBuffer, BANDS, type Analysis } from '../../engine/analysis/analyze';
import { DESTINATIONS, suggestMaster, type Destination, type Suggestion } from '../../engine/ai/engineer';
import { renderProject } from '../../engine/render';
import { projectDuration } from '../../engine/model';
import { getState, toast, update, useStore } from '../../state/store';
import { fmtDb, toDb, useTicker } from '../components/common';

export function Metrics({ a }: { a: Analysis }): JSX.Element {
  const M = ({ l, v, u, warn }: { l: string; v: string; u?: string; warn?: boolean }): JSX.Element => (
    <div className="metric" style={warn ? { borderColor: 'rgba(255,74,92,.5)' } : undefined}><small>{l}</small><b>{v}</b>{u && <span className="dim"> {u}</span>}</div>
  );
  return (
    <div className="metrics">
      <M l="LUFS intégré" v={fmtDb(a.integratedLufs)} u="LUFS" />
      <M l="Short-term max" v={fmtDb(a.shortTermMaxLufs)} u="LUFS" />
      <M l="True peak" v={fmtDb(a.truePeakDb, 2)} u="dBTP" warn={a.truePeakDb > -1} />
      <M l="Crête" v={fmtDb(a.samplePeakDb, 2)} u="dBFS" />
      <M l="RMS" v={fmtDb(a.rmsDb)} u="dBFS" />
      <M l="Crest factor" v={a.crestDb.toFixed(1)} u="dB" />
      <M l="LRA" v={a.lra.toFixed(1)} u="LU" />
      <M l="Corrélation" v={a.correlation.toFixed(2)} warn={a.correlation < 0} />
      <M l="Écrêtage" v={String(a.clippedSamples)} u="éch." warn={a.clippedSamples > 0} />
      <M l="Durée" v={a.duration.toFixed(1)} u="s" />
    </div>
  );
}

export function Spectrum({ a, b }: { a: Analysis; b?: Analysis | null }): JSX.Element {
  const w = 600, h = 160;
  const path = (s: [number, number][]): string => {
    const mx = Math.max(...s.map((x) => x[1]));
    return s.map(([f, d], i) => `${i ? 'L' : 'M'}${((Math.log10(f / 20) / 3) * w).toFixed(1)},${(h - ((d - mx + 70) / 70) * h).toFixed(1)}`).join(' ');
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 160, background: '#090b0f', borderRadius: 10, border: '1px solid var(--line)' }}>
      {[100, 1000, 10000].map((f) => <line key={f} x1={(Math.log10(f / 20) / 3) * w} x2={(Math.log10(f / 20) / 3) * w} y1={0} y2={h} stroke="#1b2029" />)}
      {b && <path d={path(b.spectrum)} fill="none" stroke="#5d6574" strokeWidth={1.5} />}
      <path d={path(a.spectrum)} fill="none" stroke="#ff6b4a" strokeWidth={2} />
    </svg>
  );
}

export function Master(): JSX.Element {
  useTicker(true);
  const p = useStore((s) => s.project);
  const [dest, setDest] = useState<Destination>('streaming');
  const [pre, setPre] = useState<Analysis | null>(null);
  const [post, setPost] = useState<Analysis | null>(null);
  const [sugg, setSugg] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState('');
  const [bypass, setBypass] = useState(false);
  const m = engine.graph?.master.meterValue;
  const dur = projectDuration(p);

  async function render(withMaster: boolean): Promise<Analysis> {
    const q = structuredClone(getState().project);
    if (!withMaster) q.master.inserts = [];
    const b = await renderProject(q, engine.buffers, { sampleRate: engine.ctx.sampleRate, tail: 1 });
    return analyzeBuffer(b);
  }
  async function analyze(): Promise<void> {
    if (dur <= 0) { toast('Importe ou enregistre de l’audio d’abord.'); return; }
    await engine.init();
    setBusy('Rendu et analyse du mix (sans chaîne master)…');
    try { const a = await render(false); setPre(a); setSugg(suggestMaster(a, dest)); } finally { setBusy(''); }
  }
  function apply(): void {
    if (!sugg) return;
    update((q) => { q.master.inserts = sugg.inserts; });
    toast('Chaîne de mastering appliquée.');
  }
  /** Closed loop: render, measure real integrated loudness, correct the limiter gain. */
  async function hitTarget(): Promise<void> {
    const target = DESTINATIONS[dest].lufs;
    const lim = getState().project.master.inserts.find((i) => i.type === 'limiter');
    if (!lim) { toast('Ajoute un limiteur sur le master (ou applique la proposition).'); return; }
    for (let it = 0; it < 4; it++) {
      setBusy(`Itération ${it + 1} : rendu du master et mesure du LUFS réel…`);
      const a = await render(true); setPost(a);
      const err = target - a.integratedLufs;
      if (!isFinite(err) || Math.abs(err) < 0.3) break;
      update((q) => { const l = q.master.inserts.find((i) => i.id === lim.id)!; l.params.inputGain = Math.max(0, Math.min(24, Number(l.params.inputGain) + err)); });
    }
    setBusy('');
    const a = await render(true); setPost(a);
    toast(`Master mesuré : ${fmtDb(a.integratedLufs)} LUFS, ${fmtDb(a.truePeakDb, 2)} dBTP`);
  }
  const [matched, setMatched] = useState(true);
  function setAB(before: boolean, match = matched): void {
    // loudness-matched A/B: the processed master is turned down by the measured loudness gain
    const diff = pre && post && isFinite(post.integratedLufs - pre.integratedLufs) ? post.integratedLufs - pre.integratedLufs : 0;
    setBypass(before);
    engine.graph?.setMasterAB(before, !before && match ? -diff : 0);
  }

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="card">
        <h3>Mastering</h3>
        <div className="row wrap">
          <select value={dest} onChange={(e) => setDest(e.target.value as Destination)}>
            {Object.entries(DESTINATIONS).map(([k, d]) => <option key={k} value={k}>{d.label} ({d.lufs} LUFS, {d.tp} dBTP)</option>)}
          </select>
          <button className="primary" onClick={() => void analyze()} disabled={!!busy}>1. Analyser le mix</button>
          <button onClick={apply} disabled={!sugg || !!busy}>2. Appliquer la chaîne proposée</button>
          <button onClick={() => void hitTarget()} disabled={!!busy}>3. Viser la cible (mesure réelle)</button>
          <button className={bypass ? 'on' : ''} onClick={() => setAB(!bypass)}>{bypass ? 'Écoute : AVANT' : 'Écoute : APRÈS'}</button>
          <label className="row muted"><input type="checkbox" checked={matched} onChange={(e) => { setMatched(e.target.checked); setAB(bypass, e.target.checked); }} /> Niveau compensé{pre && post ? ` (${(post.integratedLufs - pre.integratedLufs).toFixed(1)} LU)` : ' (après « Viser la cible »)'}</label>
        </div>
        <div className="dim" style={{ marginTop: 6 }}>{DESTINATIONS[dest].note}</div>
        {busy && <div className="note" style={{ marginTop: 10 }}>{busy}</div>}
      </div>
      <div className="card">
        <h3>Mesures en direct (sortie master)</h3>
        <div className="metrics">
          <div className="metric"><small>Momentary</small><b>{fmtDb(m?.momentary)}</b> <span className="dim">LUFS</span></div>
          <div className="metric"><small>Short-term</small><b>{fmtDb(m?.shortTerm)}</b> <span className="dim">LUFS</span></div>
          <div className="metric"><small>Intégré</small><b>{fmtDb(m?.integrated)}</b> <span className="dim">LUFS</span></div>
          <div className="metric"><small>True peak</small><b>{fmtDb(toDb(m?.truePeak ?? 0), 2)}</b> <span className="dim">dBTP</span></div>
          <div className="metric"><small>LRA</small><b>{(m?.lra ?? 0).toFixed(1)}</b> <span className="dim">LU</span></div>
          <div className="metric"><small>Corrélation</small><b>{(m?.correlation ?? 0).toFixed(2)}</b></div>
        </div>
        <button style={{ marginTop: 8 }} onClick={() => engine.graph?.master.meter.port.postMessage({ cmd: 'resetLoudness' })}>Réinitialiser le LUFS intégré</button>
      </div>
      {pre && (
        <div className="card">
          <h3>Mix avant mastering</h3>
          <Metrics a={pre} />
          <div style={{ marginTop: 10 }}><Spectrum a={pre} b={post} /></div>
          <div className="row wrap" style={{ marginTop: 8 }}>{BANDS.map((b) => <span key={b.key} className="badge">{b.label} {pre.bands[b.key].toFixed(1)} dB</span>)}</div>
        </div>
      )}
      {sugg && (
        <div className="card">
          <h3>Proposition de l’ingénieur IA</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{sugg.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          <div className="dim" style={{ marginTop: 6 }}>Chaîne : {sugg.inserts.map((i) => i.type).join(' → ')}. Tout reste modifiable dans la Console (tranche MASTER).</div>
        </div>
      )}
      {post && (
        <div className="card">
          <h3>Master rendu (mesuré)</h3>
          <Metrics a={post} />
        </div>
      )}
    </div>
  );
}
