import { useCallback, useEffect, useState } from 'react';
import { engine } from '../../engine/engine';
import {
  KIND_LABEL, hasLabels, inputSupport, isIOS, listInputs, unavailableMessage,
  type InputDevice, type InputKind,
} from '../../engine/input';
import { persistRecording } from '../../state/assets';
import { getState, setUi, toast, update, useStore } from '../../state/store';
import { fmtDb, fmtTime, toDb, useTicker } from '../components/common';

const SOURCES: { kind: InputKind; ico: string; label: string }[] = [
  { kind: 'builtin', ico: '🎙', label: 'Micro iPhone' },
  { kind: 'bluetooth', ico: '🎧', label: 'Micro Bluetooth' },
  { kind: 'usb', ico: '🔌', label: 'Micro USB-C' },
];

/** Wire the recorder's result into the project (called once at module load). */
engine.onRecorded = ({ clip, buffer }) => {
  void persistRecording(clip.assetId, buffer, clip.name).then(
    () => toast(`${clip.name} enregistrée et sauvegardée (${buffer.duration.toFixed(1)} s)`),
    (e) => toast('Prise gardée en mémoire mais non sauvegardée : ' + (e as Error).message),
  );
  update((p) => {
    // older overlapping takes on the same track are muted (kept for comping)
    for (const c of p.clips) if (c.trackId === clip.trackId && !c.muted && c.start < clip.start + clip.duration && c.start + c.duration > clip.start) c.muted = true;
    p.clips.push(clip);
  });
};

export function Record(): JSX.Element {
  useTicker(true);
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.ui.selectedTrack);
  const support = inputSupport();
  const ios = isIOS();
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [wanted, setWanted] = useState<InputKind | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gain, setGain] = useState(0);
  const [monitor, setMonitor] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clipHold, setClipHold] = useState(0);
  const active = engine.input;
  const lvl = engine.inputLevel;

  const refresh = useCallback(async () => { try { setDevices(await listInputs()); } catch { /* ignore */ } }, []);
  useEffect(() => {
    void refresh();
    const h = (): void => { void refresh(); toast('Périphériques audio modifiés : liste mise à jour.'); };
    navigator.mediaDevices?.addEventListener?.('devicechange', h);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', h);
  }, [refresh]);
  useEffect(() => { if (lvl.clips > 0) setClipHold(Date.now()); }, [lvl.clips]);

  const recTrack = project.tracks.find((t) => t.id === selected && t.role !== 'beat') ?? project.tracks.find((t) => t.armed) ?? project.tracks.find((t) => t.role === 'lead');

  async function choose(kind: InputKind | null, deviceId?: string): Promise<void> {
    setBusy(true); setMsg(null); setWanted(kind);
    try {
      let list = devices;
      if (!hasLabels(list)) {
        // labels (and Bluetooth/USB entries) only appear after permission is granted
        await engine.openMic({});
        list = await listInputs(); setDevices(list);
      }
      let id = deviceId;
      if (!id && kind) {
        const match = list.find((d) => d.kind === kind);
        if (!match) {
          setMsg(unavailableMessage(kind, ios));
          if (!engine.input) await engine.openMic({});
          return;
        }
        id = match.deviceId;
      }
      const a = await engine.openMic({ deviceId: id, kind: kind ?? undefined });
      engine.setInputGain(gain); engine.setMonitor(monitor);
      if (kind && !a.matchedRequest) setMsg(`Safari a ouvert « ${a.device.label || 'micro par défaut'} » au lieu d’un ${KIND_LABEL[kind]}. iOS décide parfois de l’entrée active selon la route audio du système.`);
      await refresh();
    } catch (e) {
      const err = e as DOMException;
      if (err.name === 'NotAllowedError') setMsg('Accès au micro refusé. Sur iPhone : Réglages > Safari > Microphone > Autoriser, puis recharge la page.');
      else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') setMsg('Ce micro n’est plus disponible (débranché ou déconnecté). Recharge la liste.');
      else setMsg('Impossible d’ouvrir le micro : ' + (err.message || err.name));
    } finally { setBusy(false); }
  }

  async function test(): Promise<void> {
    if (!engine.input) await choose(wanted);
    if (!engine.input) return;
    setTesting(true);
    const b = await engine.testRecord(4);
    setTesting(false);
    if (!b) return;
    const ch = b.getChannelData(0); let pk = 0; for (let i = 0; i < ch.length; i++) pk = Math.max(pk, Math.abs(ch[i]));
    toast(`Test : crête ${fmtDb(toDb(pk))} dBFS — lecture de l’enregistrement…`);
    engine.preview(b);
  }

  async function toggleRec(): Promise<void> {
    if (engine.recording) { await engine.stopRecording(); return; }
    if (!recTrack) { toast('Ajoute une piste voix pour enregistrer.'); return; }
    if (!engine.input) await choose(wanted);
    if (!engine.input) return;
    try { await engine.startRecording(recTrack.id); } catch (e) { toast((e as Error).message); }
  }

  const peakDb = toDb(lvl.peak);
  const level = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));
  const clipping = Date.now() - clipHold < 2000;
  const s = active?.settings;
  const bt = active?.device.kind === 'bluetooth' || (s?.sampleRate !== undefined && s.sampleRate <= 24000);
  const takes = recTrack ? project.clips.filter((c) => c.trackId === recTrack.id).sort((a, b) => (a.take ?? 0) - (b.take ?? 0)) : [];

  if (!support.ok) return <div className="page"><div className="note bad">{support.reason}</div></div>;

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="card">
        <h3>Source d’enregistrement</h3>
        <div className="srcgrid">
          {SOURCES.map((x) => {
            const avail = devices.some((d) => d.kind === x.kind);
            const using = active?.device.kind === x.kind;
            return (
              <button key={x.kind} className={'src ' + (using ? 'on' : '')} disabled={busy || engine.recording} onClick={() => void choose(x.kind)}>
                <span className="ico">{x.ico}</span><b>{x.label}</b>
                <small>{using ? 'En cours d’utilisation' : !hasLabels(devices) ? 'Autoriser le micro' : avail ? 'Détecté' : 'Non détecté'}</small>
              </button>
            );
          })}
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <select className="grow" value={active?.device.deviceId ?? ''} disabled={busy || engine.recording} onChange={(e) => void choose(null, e.target.value)}>
            <option value="" disabled>{hasLabels(devices) ? 'Choisir une entrée précise…' : 'Entrées visibles après autorisation'}</option>
            {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Entrée sans nom'} · {KIND_LABEL[d.kind]}</option>)}
          </select>
          <button onClick={() => void refresh()}>↻ Recharger</button>
          {active && <button onClick={() => engine.closeMic()} disabled={engine.recording}>Fermer le micro</button>}
        </div>
        {msg && <div className="note warn" style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      <div className="card">
        <h3>Source réellement utilisée</h3>
        {active ? (
          <dl className="kv">
            <dt>Périphérique</dt><dd>{active.device.label || '(nom non fourni par le navigateur)'}</dd>
            <dt>Type détecté</dt><dd>{KIND_LABEL[active.device.kind]}</dd>
            <dt>Fréquence</dt><dd>{s?.sampleRate ? `${s.sampleRate} Hz` : `${engine.ctx.sampleRate} Hz (contexte)`} · studio {engine.ctx.sampleRate} Hz</dd>
            <dt>Canaux</dt><dd>{s?.channelCount ?? 1}</dd>
            <dt>Traitements</dt><dd>annulation d’écho {s?.echoCancellation ? 'oui' : 'non'} · réduction de bruit {s?.noiseSuppression ? 'oui' : 'non'} · gain auto {s?.autoGainControl ? 'oui' : 'non'}</dd>
            <dt>Latence estimée</dt><dd>{(engine.latencySeconds() * 1000).toFixed(0)} ms (compensée à l’enregistrement)</dd>
          </dl>
        ) : <div className="muted">Aucun micro ouvert. Choisis une source ci-dessus.</div>}
        {active && bt && <div className="note warn" style={{ marginTop: 10 }}>Bluetooth : iOS utilise le profil « mains libres » pour le micro. La qualité est limitée (bande étroite, {s?.sampleRate ? `${s.sampleRate} Hz` : '16–24 kHz'}) et la latence est élevée. Pour une prise de qualité studio, utilise le micro de l’iPhone ou un micro USB-C, et des écouteurs filaires pour le retour.</div>}
      </div>

      <div className="card">
        <h3>Signal en temps réel</h3>
        <div className="levelbar"><i style={{ width: `${level}%` }} /><u style={{ left: `${((-6 + 60) / 60) * 100}%` }} title="-6 dBFS" /></div>
        <div className="row" style={{ marginTop: 6 }}>
          <span className="mono">{fmtDb(peakDb)} dBFS crête</span>
          <span className="mono dim">{fmtDb(toDb(lvl.rms))} dB RMS</span>
          <span className="sp" />
          {clipping ? <span className="badge bad">SATURATION – baisse le gain</span> : active && peakDb < -40 ? <span className="badge warn">Signal faible</span> : active ? <span className="badge ok">Niveau correct</span> : null}
        </div>
        <div className="params" style={{ marginTop: 10 }}>
          <div className="param"><label>Gain numérique d’entrée <b>{gain.toFixed(1)} dB</b></label>
            <input type="range" min={-24} max={24} step={0.5} value={gain} onChange={(e) => { const v = Number(e.target.value); setGain(v); engine.setInputGain(v); }} />
            <small className="dim">Le gain analogique se règle sur l’interface / le micro. Ce gain numérique ne corrige pas une saturation à la source.</small>
          </div>
          <div className="param"><label>Retour casque (monitoring)</label>
            <button className={monitor ? 'on' : ''} disabled={!active} onClick={() => { setMonitor(!monitor); engine.setMonitor(!monitor); }}>{monitor ? 'Activé' : 'Désactivé'}</button>
            <small className="dim">Utilise un casque pour éviter le larsen. Le retour passe par le navigateur (latence {(engine.isReady ? ((engine.ctx.baseLatency || 0) + (engine.ctx.outputLatency || 0)) * 1000 : 0).toFixed(0)} ms + entrée) : le monitoring direct matériel de ton interface est plus rapide.</small>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => void test()} disabled={testing || engine.recording}>{testing ? 'Test en cours (4 s)…' : '▶ Tester (enregistrer 4 s et réécouter)'}</button>
        </div>
      </div>

      <div className="card">
        <h3>Enregistrer</h3>
        <div className="row wrap" style={{ gap: 14 }}>
          <button className={'bigrec rec ' + (engine.recording ? 'on' : '')} onClick={() => void toggleRec()} aria-label="Enregistrer">{engine.recording ? '■ STOP' : '● REC'}</button>
          <div className="col grow">
            <div className="row wrap">
              <span className="muted">Piste :</span>
              <select value={recTrack?.id ?? ''} onChange={(e) => setUi({ selectedTrack: e.target.value })} disabled={engine.recording}>
                {project.tracks.filter((t) => t.role !== 'beat').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <span className="mono">{fmtTime(engine.getAudiblePosition())}</span>
            </div>
            <div className="row wrap">
              <label className="row">Pré-roll <input type="number" min={0} max={8} step={0.5} value={project.preroll} style={{ width: 60 }} onChange={(e) => update((p) => { p.preroll = Number(e.target.value); })} /> s</label>
              <button className={project.punch.on ? 'on' : ''} onClick={() => update((p) => { p.punch.on = !p.punch.on; })}>Punch {project.punch.on ? 'on' : 'off'}</button>
              {project.punch.on && <>
                <input type="number" step={0.1} value={project.punch.start} style={{ width: 70 }} onChange={(e) => update((p) => { p.punch.start = Number(e.target.value); })} />→
                <input type="number" step={0.1} value={project.punch.end} style={{ width: 70 }} onChange={(e) => update((p) => { p.punch.end = Number(e.target.value); })} /> s
              </>}
            </div>
            <small className="dim">L’instrumental et les autres pistes jouent pendant la prise. L’enregistrement commence à la position du curseur ({fmtTime(getState().project && engine.getPosition())}){project.punch.on ? ', ou entre les points de punch' : ''}, après {project.preroll} s de pré-roll.</small>
          </div>
        </div>
        <h3 style={{ marginTop: 16 }}>Prises — {recTrack?.name}</h3>
        {takes.length === 0 ? <div className="muted">Aucune prise sur cette piste.</div> : (
          <div className="col">
            {takes.map((c) => (
              <div key={c.id} className="row slot" style={{ padding: 8 }}>
                <span className="led" style={{ background: c.muted ? 'var(--dim)' : 'var(--ok)' }} />
                <b>{c.name}</b><span className="mono dim">{fmtTime(c.start)} · {c.duration.toFixed(1)} s</span>
                <span className="sp" />
                <button onClick={() => { engine.seek(c.start); void engine.play(c.start); }}>▶ Écouter</button>
                <button className={c.muted ? '' : 'on'} onClick={() => update((p) => {
                  for (const o of p.clips) if (o.trackId === c.trackId && o.start < c.start + c.duration && o.start + o.duration > c.start) o.muted = o.id !== c.id;
                })}>{c.muted ? 'Utiliser' : 'Active'}</button>
                <button onClick={() => update((p) => { p.clips = p.clips.filter((o) => o.id !== c.id); })}>Suppr.</button>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <label className="row muted">Compensation manuelle <input type="number" step={1} value={project.recordOffsetMs} style={{ width: 70 }} onChange={(e) => update((p) => { p.recordOffsetMs = Number(e.target.value); }, 'recoff')} /> ms</label>
        </div>
      </div>

      {ios && (
        <details className="card">
          <summary><b>Micros sur iPhone : ce que Safari permet réellement</b></summary>
          <ul className="muted">
            <li>Safari n’affiche les noms des micros qu’après ton autorisation. Avant, la liste est vide ou anonyme.</li>
            <li>iOS gère une « route audio » système. Selon la version d’iOS, Safari liste le micro intégré, les AirPods / casques Bluetooth et les micros USB-C comme entrées séparées, ou n’en montre qu’une : c’est alors iOS qui choisit. Le studio affiche toujours la source réellement ouverte.</li>
            <li>Bluetooth : le micro passe en profil mains libres (qualité réduite, latence élevée). Les AirPods sont pratiques pour une maquette, pas pour une prise finale.</li>
            <li>USB-C : les micros et interfaces « class compliant » sont reconnus par iOS sans pilote. Certains demandent une alimentation externe. Débranche/rebranche puis « Recharger » si le micro n’apparaît pas.</li>
            <li>Si un appareil Bluetooth est connecté dans Réglages mais absent de la liste, Safari ne l’expose pas : choisis-le comme sortie/entrée dans le Centre de contrôle (icône AirPlay), puis recharge la liste.</li>
            <li>Garde l’écran allumé pendant la prise : iOS peut suspendre l’audio d’une page en arrière-plan.</li>
          </ul>
        </details>
      )}
    </div>
  );
}
