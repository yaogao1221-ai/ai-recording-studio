import { useState } from 'react';
import { engine } from '../../engine/engine';
import type { Bus, Project, Track } from '../../engine/model';
import { newBus, TRACK_COLORS } from '../../engine/model';
import { PLUGINS, createInsert, uid, type InsertState, type PluginType } from '../../engine/plugins/registry';
import { analyzeChannels } from '../../engine/analysis/analyze';
import { STYLES, suggestVocalChain, type Suggestion, type VocalStyle } from '../../engine/ai/engineer';
import { trackRawAudio } from '../../state/assets';
import { findChannel, getState, setUi, toast, update, useStore } from '../../state/store';
import { StereoMeter, useTicker } from '../components/common';
import { PluginEditor } from '../components/PluginEditor';

const abStore = new Map<string, InsertState[]>();
const PRESET_KEY = 'ars.chainPresets';
function loadPresets(): Record<string, InsertState[]> { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; } }
function savePresets(p: Record<string, InsertState[]>): void { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch { toast('Stockage local indisponible.'); } }
const cloneChain = (c: InsertState[]): InsertState[] => structuredClone(c).map((i) => ({ ...i, id: uid('fx') }));

const BEGINNER: PluginType[] = ['eq', 'compressor', 'deesser', 'saturation', 'reverb', 'delay', 'limiter'];

function Strip({ ch, kind }: { ch: Track | Bus | Project['master']; kind: 'track' | 'bus' | 'master' }): JSX.Element {
  const p = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const [adding, setAdding] = useState(false);
  const id = ch.id;
  const strip = id === 'master' ? engine.graph?.master : engine.graph?.strips.get(id);
  const m = strip?.meterValue;
  const isCh = kind !== 'master';
  const c = ch as Track | Bus;
  type Any = { inserts: InsertState[]; volume: number; pan: number; mute: boolean; solo: boolean; output: string };
  const mut = (fn: (x: Any) => void, key?: string): void => update((q) => { fn(findChannel(q, id) as unknown as Any); }, key);
  const types = (ui.mode === 'advanced' ? (Object.keys(PLUGINS) as PluginType[]) : BEGINNER);
  return (
    <div className={'strip ' + (kind === 'master' ? 'master' : '')}>
      <div className="name" style={{ borderColor: isCh ? c.color : 'var(--accent)' }}>{isCh ? c.name : 'MASTER'}</div>
      <div className="col" style={{ gap: 3 }}>
        {ch.inserts.map((ins, i) => (
          <div key={ins.id} className={'slot ' + (ins.enabled ? '' : 'off ') + (ui.editing?.insert === ins.id ? 'sel' : '')}
            onClick={() => setUi({ editing: { channel: id, insert: ins.id } })} title={PLUGINS[ins.type].name}>
            <span className="led" onClick={(e) => { e.stopPropagation(); mut((x) => { x.inserts[i].enabled = !x.inserts[i].enabled; }); }} />
            <span>{PLUGINS[ins.type].short}</span>
            <span className="gr">{strip && (strip.gr[ins.id] ?? 0) > 0.1 ? '-' + strip.gr[ins.id].toFixed(1) : ''}</span>
            {ui.mode === 'advanced' && <>
              <button className="ghost" style={{ padding: '0 3px' }} disabled={i === 0} onClick={(e) => { e.stopPropagation(); mut((x) => { const a = x.inserts; [a[i - 1], a[i]] = [a[i], a[i - 1]]; }); }} title="Monter">↑</button>
            </>}
            <button className="ghost" style={{ padding: '0 3px' }} onClick={(e) => { e.stopPropagation(); mut((x) => { x.inserts.splice(i, 1); }); }} title="Retirer">×</button>
          </div>
        ))}
        {adding ? (
          <select autoFocus onBlur={() => setAdding(false)} onChange={(e) => { const t = e.target.value as PluginType; if (t) { mut((x) => { x.inserts.push(createInsert(t)); }); } setAdding(false); }} defaultValue="">
            <option value="" disabled>Ajouter…</option>
            {types.map((t) => <option key={t} value={t}>{PLUGINS[t].name}</option>)}
          </select>
        ) : <button style={{ fontSize: 11, padding: '2px' }} onClick={() => setAdding(true)}>＋ Effet</button>}
      </div>
      <div className="row" style={{ gap: 3 }}>
        <button style={{ flex: 1, fontSize: 10, padding: 2 }} title="Copier la chaîne" onClick={() => { setUi({ chainClipboard: structuredClone(ch.inserts) }); toast('Chaîne copiée'); }}>Copier</button>
        <button style={{ flex: 1, fontSize: 10, padding: 2 }} title="Coller la chaîne" disabled={!ui.chainClipboard} onClick={() => mut((x) => { x.inserts = cloneChain(getState().ui.chainClipboard!); })}>Coller</button>
        <button style={{ flex: 1, fontSize: 10, padding: 2 }} title="Comparer A/B : échange la chaîne actuelle avec la version mémorisée" onClick={() => {
          const stored = abStore.get(id) ?? structuredClone(ch.inserts);
          abStore.set(id, structuredClone(ch.inserts)); mut((x) => { x.inserts = stored; }); toast('Chaîne A/B échangée');
        }}>A/B</button>
      </div>
      {isCh && (
        <>
          <select value={c.output} onChange={(e) => mut((x) => { x.output = e.target.value; })} title="Sortie" style={{ fontSize: 11 }}>
            <option value="master">→ Master</option>
            {kind === 'track' && p.buses.map((b) => <option key={b.id} value={b.id}>→ {b.name}</option>)}
          </select>
          <label className="mono" style={{ fontSize: 10 }}>Pan {c.pan === 0 ? 'C' : c.pan < 0 ? 'L' + Math.round(-c.pan * 100) : 'R' + Math.round(c.pan * 100)}
            <input type="range" min={-1} max={1} step={0.01} value={c.pan} onDoubleClick={() => mut((x) => { x.pan = 0; })} onChange={(e) => mut((x) => { x.pan = Number(e.target.value); }, 'pan' + id)} />
          </label>
        </>
      )}
      <div className="fader-wrap">
        <input className="vfader" type="range" min={-60} max={12} step={0.1} value={ch.volume} aria-label="Volume"
          onDoubleClick={() => mut((x) => { x.volume = 0; })} onChange={(e) => mut((x) => { x.volume = Number(e.target.value); }, 'vol' + id)} />
        <StereoMeter l={m?.peakL ?? 0} r={m?.peakR ?? 0} />
      </div>
      <div className="mono" style={{ textAlign: 'center', fontSize: 11 }}>{ch.volume.toFixed(1)} dB</div>
      {isCh && (
        <div className="row" style={{ gap: 3 }}>
          <button className={c.mute ? 'on' : ''} style={{ flex: 1 }} onClick={() => mut((x) => { x.mute = !x.mute; })}>M</button>
          <button className={c.solo ? 'on' : ''} style={{ flex: 1 }} onClick={() => mut((x) => { x.solo = !x.solo; })}>S</button>
        </div>
      )}
    </div>
  );
}

function AiVocal(): JSX.Element {
  const p = useStore((s) => s.project);
  const sel = useStore((s) => s.ui.selectedTrack);
  const vocals = p.tracks.filter((t) => t.role !== 'beat' && p.clips.some((c) => c.trackId === t.id && !c.muted));
  const beat = p.tracks.find((t) => t.role === 'beat' && p.clips.some((c) => c.trackId === t.id && !c.muted));
  const [trackId, setTrackId] = useState<string>(sel && vocals.some((v) => v.id === sel) ? sel : vocals[0]?.id ?? '');
  const [style, setStyle] = useState<VocalStyle>('rap');
  const [sugg, setSugg] = useState<(Suggestion & { trackId: string }) | null>(null);
  const [before, setBefore] = useState<{ id: string; chain: InsertState[]; vol: number } | null>(null);

  function analyze(): void {
    const v = trackRawAudio(p, trackId); if (!v) { toast('Cette piste n’a pas d’audio.'); return; }
    const sr = engine.ctx.sampleRate;
    const va = analyzeChannels(v, sr);
    const b = beat ? trackRawAudio(p, beat.id) : null;
    const ba = b ? analyzeChannels(b, sr) : null;
    setSugg({ ...suggestVocalChain(va, ba, style), trackId });
  }
  function apply(): void {
    if (!sugg) return;
    const t = p.tracks.find((x) => x.id === sugg.trackId)!;
    setBefore({ id: t.id, chain: structuredClone(t.inserts), vol: t.volume });
    update((q) => {
      const k = q.tracks.find((x) => x.id === sugg.trackId)!;
      k.inserts = sugg.inserts; if (sugg.volume !== undefined) k.volume = sugg.volume;
      for (const e of sugg.extra ?? []) if (e.target === 'beat' && beat) { const bt = q.tracks.find((x) => x.id === beat.id)!; bt.inserts = [...bt.inserts, ...e.inserts]; }
    });
    toast('Réglages appliqués. Tu peux les modifier, les annuler (Ctrl+Z) ou comparer avant/après.');
  }
  return (
    <div className="card" style={{ margin: 12 }}>
      <h3>Ingénieur IA — mix vocal</h3>
      <div className="muted" style={{ marginBottom: 8 }}>Analyse réelle de l’audio de la piste (spectre, RMS, LUFS, dynamique, sifflantes) puis règles d’ingénierie du son. Ce n’est pas un modèle qui « écoute » : chaque décision est expliquée avec les mesures.</div>
      <div className="row wrap">
        <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
          {vocals.length === 0 && <option value="">Aucune piste voix avec audio</option>}
          {vocals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={style} onChange={(e) => setStyle(e.target.value as VocalStyle)}>
          {Object.entries(STYLES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <button className="primary" disabled={!trackId} onClick={analyze}>Analyser et proposer</button>
        {before && <button onClick={() => {
          const t = getState().project.tracks.find((x) => x.id === before.id)!;
          const cur = { chain: structuredClone(t.inserts), vol: t.volume };
          update((q) => { const k = q.tracks.find((x) => x.id === before.id)!; k.inserts = before.chain; k.volume = before.vol; });
          setBefore({ id: before.id, ...cur });
        }}>Avant / Après</button>}
      </div>
      {!beat && <div className="dim" style={{ marginTop: 6 }}>Ajoute un instrumental pour que l’équilibre voix/instru soit aussi calculé.</div>}
      {sugg && (
        <div className="col" style={{ marginTop: 10 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{sugg.notes.map((n, i) => <li key={i}>{n}</li>)}{sugg.extra?.flatMap((e) => e.notes).map((n, i) => <li key={'x' + i}>{n}</li>)}</ul>
          <div className="row"><button className="primary" onClick={apply}>Accepter et appliquer</button><button onClick={() => setSugg(null)}>Refuser</button></div>
        </div>
      )}
    </div>
  );
}

export function Mixer(): JSX.Element {
  useTicker(true);
  const p = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const [presetName, setPresetName] = useState('');
  const presets = loadPresets();
  const ed = ui.editing;
  const edCh = ed ? findChannel(p, ed.channel) : undefined;
  return (
    <div>
      <div className="mixer">
        {p.tracks.map((t) => <Strip key={t.id} ch={t} kind="track" />)}
        <div style={{ width: 1, background: 'var(--line)', flex: 'none' }} />
        {p.buses.map((b) => <Strip key={b.id} ch={b} kind="bus" />)}
        <Strip ch={p.master} kind="master" />
        <button style={{ alignSelf: 'flex-start' }} onClick={() => update((q) => { q.buses.push(newBus(`Bus ${q.buses.length + 1}`, TRACK_COLORS[(q.buses.length + 4) % TRACK_COLORS.length])); })}>＋ Bus</button>
      </div>
      {ed && edCh && <PluginEditor channel={ed.channel} insertId={ed.insert} />}
      {ed && edCh && (
        <div className="toolbar">
          <span className="muted">Presets de chaîne</span>
          <input type="text" placeholder="Nom du preset" value={presetName} onChange={(e) => setPresetName(e.target.value)} style={{ width: 140 }} />
          <button disabled={!presetName} onClick={() => { savePresets({ ...presets, [presetName]: edCh.inserts }); setPresetName(''); toast('Preset enregistré'); }}>Enregistrer</button>
          <select value="" onChange={(e) => { const c = presets[e.target.value]; if (c) update((q) => { findChannel(q, ed.channel)!.inserts = cloneChain(c); }); }}>
            <option value="">Charger un preset…</option>
            {Object.keys(presets).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      )}
      <AiVocal />
    </div>
  );
}
