import { useEffect, useState } from 'react';
import { engine } from '../engine/engine';
import { loadProject, requestPersistence, saveProject } from '../engine/storage';
import { getState, redo, saveNow, setUi, toast, undo, update, useStore, type View } from '../state/store';
import { fmtTime, useTicker } from './components/common';
import { Analyzer } from './views/Analyzer';
import { Export } from './views/Export';
import { Master } from './views/Master';
import { Mixer } from './views/Mixer';
import { Projects, openProject } from './views/Projects';
import { Record } from './views/Record';
import { Studio, deleteSelected, splitSelected } from './views/Studio';

const NAV: { v: View; ico: string; l: string }[] = [
  { v: 'studio', ico: '▤', l: 'Studio' }, { v: 'record', ico: '🎙', l: 'Cabine' }, { v: 'mixer', ico: '☷', l: 'Console' },
  { v: 'master', ico: '◎', l: 'Master' }, { v: 'analyzer', ico: '∿', l: 'Analyse' }, { v: 'export', ico: '⇩', l: 'Export' }, { v: 'projects', ico: '▣', l: 'Projets' },
];

function Transport(): JSX.Element {
  useTicker(true);
  const loop = useStore((s) => s.project.loop);
  const bpm = useStore((s) => s.project.bpm);
  const rec = engine.recording;
  return (
    <div className="transport">
      <button onClick={() => engine.seek(0)} title="Début (Origine)">⏮</button>
      <button className={engine.playing ? 'on' : ''} onClick={() => (engine.playing ? engine.stop() : void engine.play())} title="Lecture / Stop (Espace)">{engine.playing ? '❚❚' : '▶'}</button>
      <button className={'rec ' + (rec ? 'on' : '')} onClick={() => setUi({ view: 'record' })} title="Enregistrement (Cabine)">●</button>
      <span className="clock">{fmtTime(engine.getAudiblePosition())}</span>
      <button className={loop.on ? 'on' : ''} onClick={() => update((p) => { p.loop.on = !p.loop.on; })} title="Boucle (L)">⟲</button>
      <label className="row hide-m mono" title="Tempo">
        <input type="number" value={bpm} min={40} max={240} style={{ width: 58 }} onChange={(e) => update((p) => { p.bpm = Math.max(40, Math.min(240, Number(e.target.value))); }, 'bpm')} /> BPM
      </label>
    </div>
  );
}

function Onboarding(): JSX.Element {
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="card">
        <h3>Bienvenue dans AI Recording Studio</h3>
        <ol style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li><b>Studio</b> : glisse ton instrumental dans la timeline.</li>
          <li><b>Cabine</b> : choisis ton micro (iPhone, Bluetooth, USB-C), teste le niveau, puis enregistre tes prises sur l’instru.</li>
          <li><b>Console</b> : chaque piste a sa chaîne d’effets réels. L’ingénieur IA analyse ta voix et propose des réglages expliqués.</li>
          <li><b>Master</b> puis <b>Export</b> : mesure LUFS / true peak, mastering et WAV 16/24/32 bits.</li>
        </ol>
        <div className="muted">Raccourcis : Espace lecture, L boucle, S couper, Suppr, Ctrl+Z / Ctrl+Maj+Z, + / − zoom. Mode Débutant / Avancé en haut à droite.</div>
        <div className="row" style={{ marginTop: 12 }}><span className="sp" /><button className="primary" onClick={async () => { setUi({ onboarding: false }); await engine.resume(); }}>Commencer</button></div>
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const ui = useStore((s) => s.ui);
  const p = useStore((s) => s.project);
  const saving = useStore((s) => s.saving);
  const savedAt = useStore((s) => s.savedAt);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const [audioOk, setAudioOk] = useState(true);

  // boot: restore the last project (autosave = crash recovery)
  useEffect(() => {
    void (async () => {
      void requestPersistence();
      let id: string | null = null; try { id = localStorage.getItem('ars.lastProject'); } catch { /* */ }
      const last = id ? await loadProject(id).catch(() => undefined) : undefined;
      if (last) { await engine.init().catch(() => setAudioOk(false)); await openProject(last); toast(`Projet « ${last.name} » restauré`); }
      else { await saveProject(getState().project); }
    })();
    const unlock = (): void => { void engine.resume().catch(() => setAudioOk(false)); };
    window.addEventListener('pointerdown', unlock, { once: true });
    const beforeUnload = (): void => { void saveNow(); };
    window.addEventListener('pagehide', beforeUnload);
    return () => window.removeEventListener('pagehide', beforeUnload);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') { e.preventDefault(); if (engine.recording) void engine.stopRecording(); else if (engine.playing) engine.stop(); else void engine.play(); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void saveNow().then(() => toast('Projet sauvegardé')); }
      else if (e.key === 'l' || e.key === 'L') update((q) => { q.loop.on = !q.loop.on; });
      else if (e.key === 's' || e.key === 'S') splitSelected();
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      else if (e.key === '+' || e.key === '=') setUi({ zoom: Math.min(800, getState().ui.zoom * 1.25) });
      else if (e.key === '-') setUi({ zoom: Math.max(5, getState().ui.zoom / 1.25) });
      else if (e.key === 'Home') engine.seek(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const V = { studio: Studio, record: Record, mixer: Mixer, master: Master, analyzer: Analyzer, export: Export, projects: Projects }[ui.view];
  return (
    <div className="app">
      <header className="topbar">
        <div className="logo"><i>AI</i><span className="hide-m">RECORDING STUDIO</span></div>
        <input type="text" value={p.name} onChange={(e) => update((q) => { q.name = e.target.value; }, 'pname')} style={{ width: 160, background: 'transparent', border: '1px solid transparent' }} aria-label="Nom du projet" />
        <Transport />
        <span className="sp" />
        <button className="ghost" onClick={undo} disabled={!canUndo} title="Annuler (Ctrl+Z)">↶</button>
        <button className="ghost" onClick={redo} disabled={!canRedo} title="Rétablir (Ctrl+Maj+Z)">↷</button>
        <span className="dim hide-m" style={{ fontSize: 11 }}>{saving ? 'Sauvegarde…' : savedAt ? 'Sauvegardé' : ''}</span>
        <button onClick={() => setUi({ mode: ui.mode === 'beginner' ? 'advanced' : 'beginner' })} title="Mode Débutant / Avancé">{ui.mode === 'beginner' ? 'Débutant' : 'Avancé'}</button>
      </header>
      <nav className="nav">
        {NAV.map((n) => <button key={n.v} className={ui.view === n.v ? 'active' : ''} onClick={() => setUi({ view: n.v })}><span>{n.ico}</span>{n.l}</button>)}
      </nav>
      <main className="main">
        {!audioOk && <div className="note bad" style={{ margin: 12 }}>Le moteur audio n’a pas pu démarrer (AudioWorklet indisponible ou bloqué). Utilise un navigateur récent (Chrome, Edge, Firefox, Safari 14.5+).</div>}
        <V />
      </main>
      {ui.toast && <div className="toast" role="status">{ui.toast}</div>}
      {ui.onboarding && <Onboarding />}
    </div>
  );
}
