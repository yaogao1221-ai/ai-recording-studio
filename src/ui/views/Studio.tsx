import { useRef, useState } from 'react';
import { engine } from '../../engine/engine';
import { ROLE_LABEL, TRACK_COLORS, newTrack, projectDuration, type Clip, type TrackRole } from '../../engine/model';
import { uid } from '../../engine/plugins/registry';
import { getPeaks, importFiles } from '../../state/assets';
import { getState, setUi, toast, update, useStore } from '../../state/store';
import { fmtTime, useFrame, useTicker } from '../components/common';
import { quickRecord, recordTarget } from '../quickRecord';

const RULER = 28, ROW = 72;

export function splitSelected(): void {
  const s = getState(); const id = s.ui.selectedClip; const pos = engine.getPosition();
  const c = s.project.clips.find((x) => x.id === id);
  if (!c || pos <= c.start + 0.01 || pos >= c.start + c.duration - 0.01) { toast('Place le curseur à l’intérieur du clip sélectionné pour le couper.'); return; }
  update((p) => {
    const k = p.clips.find((x) => x.id === c.id)!;
    const right: Clip = { ...k, id: uid('clip'), start: pos, offset: k.offset + (pos - k.start), duration: k.start + k.duration - pos, fadeIn: 0.005 };
    k.duration = pos - k.start; k.fadeOut = 0.005;
    p.clips.push(right);
  });
}
export function deleteSelected(): void {
  const id = getState().ui.selectedClip; if (!id) return;
  update((p) => { p.clips = p.clips.filter((c) => c.id !== id); }); setUi({ selectedClip: null });
}

export function Studio(): JSX.Element {
  useTicker(true);
  const p = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const cv = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const headers = useRef<HTMLDivElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const [drop, setDrop] = useState(false);
  const drag = useRef<{ mode: 'move' | 'trimL' | 'trimR' | 'seek' | 'loop' | 'scrub'; clip?: Clip; x0: number; y0: number; t0: number; pos0?: number; ph0?: number; moved?: boolean; wasPlaying?: boolean; row?: number } | null>(null);
  const preview = useRef<Clip | null>(null);

  const zoom = ui.zoom;
  const total = Math.max(60, projectDuration(p) + 30);
  const width = Math.ceil(total * zoom), height = RULER + p.tracks.length * ROW;
  const beat = 60 / p.bpm, bar = beat * 4;
  const snap = (t: number): number => (ui.snap ? Math.round(t / (beat / 4)) * (beat / 4) : t);

  useFrame(() => {
    const c = cv.current, sc = scroller.current; if (!c || !sc) return;
    const dpr = window.devicePixelRatio || 1;
    const vw = sc.clientWidth, vh = Math.max(sc.clientHeight, height);
    if (c.width !== Math.round(vw * dpr) || c.height !== Math.round(vh * dpr)) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); c.style.width = vw + 'px'; c.style.height = vh + 'px'; }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = sc.scrollLeft; const t0 = sx / zoom, t1 = (sx + vw) / zoom;
    const X = (t: number): number => t * zoom - sx;
    g.fillStyle = '#0d1015'; g.fillRect(0, 0, vw, vh);
    // rows
    p.tracks.forEach((t, i) => { g.fillStyle = t.id === ui.selectedTrack ? '#141922' : i % 2 ? '#0f1217' : '#0d1015'; g.fillRect(0, RULER + i * ROW, vw, ROW); g.fillStyle = '#1a1f28'; g.fillRect(0, RULER + (i + 1) * ROW - 1, vw, 1); });
    // grid
    const step = zoom * bar < 40 ? bar * 4 : zoom * beat < 14 ? bar : beat;
    for (let t = Math.floor(t0 / step) * step; t < t1; t += step) {
      const x = Math.round(X(t)) + 0.5; const isBar = Math.abs(t / bar - Math.round(t / bar)) < 1e-6;
      g.fillStyle = isBar ? '#212734' : '#161b23'; g.fillRect(x, RULER, 1, vh);
    }
    // loop
    if (p.loop.on) { g.fillStyle = 'rgba(90,169,255,.07)'; g.fillRect(X(p.loop.start), RULER, (p.loop.end - p.loop.start) * zoom, vh); }
    if (p.punch.on) { g.fillStyle = 'rgba(255,74,92,.07)'; g.fillRect(X(p.punch.start), RULER, (p.punch.end - p.punch.start) * zoom, vh); }
    // clips
    const clips = p.clips.map((c) => (preview.current && preview.current.id === c.id ? preview.current : c));
    for (const c of clips) {
      const ti = p.tracks.findIndex((t) => t.id === c.trackId); if (ti < 0) continue;
      if (c.start > t1 || c.start + c.duration < t0) continue;
      const tr = p.tracks[ti];
      const x = X(c.start), w = c.duration * zoom, y = RULER + ti * ROW + 3, h = ROW - 7;
      const sel = c.id === ui.selectedClip;
      g.globalAlpha = c.muted ? 0.35 : 1;
      g.fillStyle = tr.color + '30'; g.strokeStyle = sel ? '#fff' : tr.color + 'aa'; g.lineWidth = sel ? 1.5 : 1;
      g.beginPath(); g.roundRect(x, y, w, h, 5); g.fill(); g.stroke();
      g.fillStyle = tr.color + 'dd'; g.fillRect(x, y, w, 14);
      g.fillStyle = '#0b0d11'; g.font = '600 10px Inter, sans-serif';
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.fillText(c.name + (c.muted ? ' (inactive)' : ''), x + 5, y + 10.5);
      const pk = getPeaks(c.assetId); const buf = engine.buffers.get(c.assetId);
      if (pk && buf) {
        const mid = y + 14 + (h - 14) / 2, amp = (h - 18) / 2 * Math.pow(10, c.gain / 20);
        g.fillStyle = tr.color;
        const xs = Math.max(x, 0), xe = Math.min(x + w, vw);
        const perPx = buf.sampleRate / zoom / pk.bucket;
        for (let px = Math.floor(xs); px < xe; px++) {
          const tt = c.offset + (px - x) / zoom;
          const b0 = Math.floor(tt * buf.sampleRate / pk.bucket), b1 = Math.max(b0 + 1, Math.floor(b0 + perPx));
          let lo = 0, hi = 0;
          for (let k = b0; k < b1 && k < pk.min.length; k++) { if (pk.min[k] < lo) lo = pk.min[k]; if (pk.max[k] > hi) hi = pk.max[k]; }
          g.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
      } else { g.fillStyle = '#ffffff55'; g.fillText('audio manquant', x + 5, y + 30); }
      // fades
      g.strokeStyle = '#ffffffaa'; g.beginPath();
      if (c.fadeIn > 0.01) { g.moveTo(x, y + h); g.lineTo(x + c.fadeIn * zoom, y + 14); }
      if (c.fadeOut > 0.01) { g.moveTo(x + w - c.fadeOut * zoom, y + 14); g.lineTo(x + w, y + h); }
      g.stroke(); g.restore(); g.globalAlpha = 1;
    }
    // ruler
    g.fillStyle = '#12151c'; g.fillRect(0, 0, vw, RULER); g.fillStyle = '#262c37'; g.fillRect(0, RULER - 1, vw, 1);
    g.font = '10px JetBrains Mono, monospace';
    const rs = zoom * bar < 50 ? bar * 4 : bar;
    for (let t = Math.floor(t0 / rs) * rs; t < t1; t += rs) {
      const x = Math.round(X(t)) + 0.5; g.fillStyle = '#3a4252'; g.fillRect(x, 14, 1, 14);
      g.fillStyle = '#8b93a3'; g.fillText(String(Math.round(t / bar) + 1), x + 3, 12);
    }
    if (p.loop.on) { g.fillStyle = '#5aa9ff'; g.fillRect(X(p.loop.start), RULER - 4, (p.loop.end - p.loop.start) * zoom, 3); }
    // playhead
    const ph = X(engine.getAudiblePosition());
    g.fillStyle = engine.recording ? '#ff4a5c' : '#ff6b4a'; g.fillRect(Math.round(ph), 0, 1.5, vh);
    g.beginPath(); g.moveTo(ph - 5, 0); g.lineTo(ph + 5, 0); g.lineTo(ph, 7); g.fill();
    if (headers.current) headers.current.scrollTop = sc.scrollTop;
    // auto-scroll while playing
    if (engine.playing && (ph > vw - 40 || ph < 0)) sc.scrollLeft = Math.max(0, engine.getAudiblePosition() * zoom - 60);
  });

  const at = (e: { clientX: number; clientY: number }): { t: number; row: number; x: number; y: number } => {
    const r = cv.current!.getBoundingClientRect(); const sc = scroller.current!;
    const x = e.clientX - r.left, y = e.clientY - r.top + 0;
    return { t: (x + sc.scrollLeft) / zoom, row: Math.floor((y - RULER) / ROW), x, y };
  };

  function onDown(e: React.PointerEvent): void {
    const a = at(e);
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
    if (a.y < RULER) {
      if (e.shiftKey) { drag.current = { mode: 'loop', x0: a.x, y0: a.y, t0: snap(a.t) }; return; }
      engine.seek(Math.max(0, a.t)); drag.current = { mode: 'seek', x0: a.x, y0: a.y, t0: a.t }; return;
    }
    const tr = p.tracks[a.row];
    const hit = [...p.clips].reverse().find((c) => c.trackId === tr?.id && a.t >= c.start && a.t <= c.start + c.duration);
    // Touch: swipe = move through the song (the timeline slides under a fixed playhead), tap = select the track.
    // A clip is only moved/trimmed by touch once it is already selected.
    if (e.pointerType === 'touch' && !(hit && hit.id === ui.selectedClip)) {
      const pos0 = engine.getPosition();
      const wasPlaying = engine.playing;
      if (wasPlaying) engine.stop();
      drag.current = { mode: 'scrub', clip: hit, x0: a.x, y0: a.y, t0: a.t, pos0, ph0: pos0 * zoom - scroller.current!.scrollLeft, wasPlaying, row: a.row };
      return;
    }
    if (hit) {
      const ex = (hit.start + hit.duration) * zoom - scroller.current!.scrollLeft;
      const sx = hit.start * zoom - scroller.current!.scrollLeft;
      const mode = a.x > ex - 8 ? 'trimR' : a.x < sx + 8 ? 'trimL' : 'move';
      setUi({ selectedClip: hit.id, selectedTrack: hit.trackId });
      drag.current = { mode, clip: hit, x0: a.x, y0: a.y, t0: a.t };
    } else {
      setUi({ selectedClip: null, selectedTrack: tr?.id ?? ui.selectedTrack });
      engine.seek(Math.max(0, snap(a.t)));
    }
  }
  function onMove(e: React.PointerEvent): void {
    const d = drag.current; if (!d) return;
    const a = at(e); const dt = a.t - d.t0;
    if (d.mode === 'seek') { engine.seek(Math.max(0, a.t)); return; }
    if (d.mode === 'scrub') {
      const dx = a.x - d.x0;
      if (!d.moved && Math.abs(dx) < 8) return;
      d.moved = true;
      const pos = Math.max(0, d.pos0! - dx / zoom);
      engine.seek(pos);
      const sc = scroller.current!;
      sc.scrollLeft = Math.max(0, pos * zoom - Math.max(40, Math.min(sc.clientWidth - 40, d.ph0!)));
      return;
    }
    if (d.mode === 'loop') { const t = snap(a.t); update((q) => { q.loop = { on: true, start: Math.min(d.t0, t), end: Math.max(d.t0, t) }; }, 'loopdrag'); return; }
    const c = d.clip!; const buf = engine.buffers.get(c.assetId);
    if (d.mode === 'move') {
      const row = Math.max(0, Math.min(p.tracks.length - 1, a.row));
      preview.current = { ...c, start: Math.max(0, snap(c.start + dt)), trackId: p.tracks[row].id };
    } else if (d.mode === 'trimR') {
      const maxD = buf ? buf.duration - c.offset : Infinity;
      preview.current = { ...c, duration: Math.max(0.05, Math.min(maxD, snap(c.start + c.duration + dt) - c.start)) };
    } else {
      const ns = Math.max(c.start - c.offset, Math.min(c.start + c.duration - 0.05, snap(c.start + dt)));
      preview.current = { ...c, start: ns, offset: c.offset + (ns - c.start), duration: c.duration - (ns - c.start) };
    }
  }
  function onUp(): void {
    const d = drag.current;
    if (d?.mode === 'scrub') {
      drag.current = null;
      if (!d.moved) {
        // tap: select (and arm) the track under the finger
        const tr = p.tracks[d.row ?? -1];
        if (tr) {
          setUi({ selectedTrack: tr.id, selectedClip: d.clip?.id ?? null });
          if (tr.role !== 'beat') update((q) => { q.tracks.forEach((x) => { x.armed = x.id === tr.id; }); });
        }
      }
      if (d.wasPlaying) void engine.play();
      return;
    }
    const pr = preview.current; drag.current = null; preview.current = null;
    if (pr) update((q) => { const i = q.clips.findIndex((x) => x.id === pr.id); if (i >= 0) q.clips[i] = pr; });
  }

  const sel = p.clips.find((c) => c.id === ui.selectedClip);
  const adv = ui.mode === 'advanced';

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto auto', height: '100%' }}>
      <div className="toolbar">
        <button onClick={() => fileIn.current?.click()} title="Importer des fichiers audio (ou glisser-déposer)">＋ Importer audio<span className="show-m"> (Fichiers)</span></button>
        <input ref={fileIn} type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.aif,.aiff" multiple hidden onChange={(e) => { void importFiles([...(e.target.files ?? [])], ui.selectedTrack ?? undefined, engine.getPosition()); e.target.value = ''; }} />
        <button onClick={() => update((q) => { const t = newTrack(`Piste ${q.tracks.length + 1}`, 'other', TRACK_COLORS[q.tracks.length % TRACK_COLORS.length]); q.tracks.push(t); })}>＋ Piste</button>
        <span className="sp" />
        <button onClick={splitSelected} disabled={!sel} title="Couper au curseur (S)">✂ Couper</button>
        <button onClick={deleteSelected} disabled={!sel} title="Supprimer (Suppr)">Suppr.</button>
        <button className={ui.snap ? 'on' : ''} onClick={() => setUi({ snap: !ui.snap })} title="Magnétisme 1/16">Grille</button>
        <button onClick={() => setUi({ zoom: Math.max(5, zoom / 1.5) })} title="Zoom arrière (-)">−</button>
        <button onClick={() => setUi({ zoom: Math.min(800, zoom * 1.5) })} title="Zoom avant (+)">＋</button>
        {adv && <span className="dim hide-m">Maj + glisser dans la règle = boucle</span>}
        <span className="dim show-m">Glisse pour avancer / reculer · touche une piste pour la choisir</span>
      </div>
      <div className="arrange" style={{ minHeight: 0 }}>
        <div className="headers" ref={headers}>
          <div style={{ height: RULER, borderBottom: '1px solid var(--line)' }} />
          {p.tracks.map((t) => (
            <div key={t.id} className={'thead ' + (t.id === ui.selectedTrack ? 'sel' : '')} onClick={() => setUi({ selectedTrack: t.id })}>
              <div className="bar" style={{ background: t.color }} onDoubleClick={() => update((q) => { const k = q.tracks.find((x) => x.id === t.id)!; k.color = TRACK_COLORS[(TRACK_COLORS.indexOf(k.color) + 1) % TRACK_COLORS.length]; })} title="Double-clic : couleur" />
              <input type="text" value={t.name} onChange={(e) => update((q) => { q.tracks.find((x) => x.id === t.id)!.name = e.target.value; }, 'name' + t.id)} aria-label="Nom de piste" />
              <div className="row btns">
                <button className={t.mute ? 'on' : ''} onClick={(e) => { e.stopPropagation(); update((q) => { const k = q.tracks.find((x) => x.id === t.id)!; k.mute = !k.mute; }); }} title="Mute">M</button>
                <button className={t.solo ? 'on' : ''} onClick={(e) => { e.stopPropagation(); update((q) => { const k = q.tracks.find((x) => x.id === t.id)!; k.solo = !k.solo; }); }} title="Solo">S</button>
                {t.role !== 'beat' && <button className={'rec ' + (t.armed ? 'on' : '')} style={{ animation: 'none' }} onClick={(e) => { e.stopPropagation(); update((q) => { q.tracks.forEach((x) => { x.armed = x.id === t.id ? !x.armed : false; }); }); setUi({ selectedTrack: t.id }); }} title="Armer pour l’enregistrement">●</button>}
                {adv && <select className="hide-m" value={t.role} onClick={(e) => e.stopPropagation()} onChange={(e) => update((q) => { q.tracks.find((x) => x.id === t.id)!.role = e.target.value as TrackRole; })} style={{ fontSize: 10, padding: '1px 2px', width: 70 }}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>}
              </div>
            </div>
          ))}
        </div>
        <div className="timeline" ref={scroller}
          onDragOver={(e) => { e.preventDefault(); setDrop(true); }} onDragLeave={() => setDrop(false)}
          onDrop={(e) => { e.preventDefault(); setDrop(false); const a = at(e); void importFiles([...e.dataTransfer.files], p.tracks[a.row]?.id, Math.max(0, snap(a.t))); }}>
          <div style={{ width, height, position: 'relative' }}>
            <canvas ref={cv} style={{ position: 'sticky', left: 0, top: 0, touchAction: 'pan-y' }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
          </div>
          {drop && <div className="dropzone">Dépose tes fichiers audio ici</div>}
          {p.clips.length === 0 && !drop && <div style={{ position: 'absolute', top: RULER + 16, left: 16, right: 16, pointerEvents: 'none' }} className="note">Glisse ton instrumental ici (WAV, MP3, M4A…) ou utilise « Importer audio ». Sur iPhone, l’instru doit être dans l’app Fichiers (iCloud Drive, Téléchargements…). Ensuite touche une piste voix et appuie sur ● REC.</div>}
        </div>
      </div>
      {sel && (
        <div className="toolbar">
          <b>{sel.name}</b>
          <label className="row">Gain <input type="range" min={-24} max={12} step={0.1} value={sel.gain} style={{ width: 110 }} onChange={(e) => update((q) => { q.clips.find((c) => c.id === sel.id)!.gain = Number(e.target.value); }, 'cg' + sel.id)} /><span className="mono">{sel.gain.toFixed(1)} dB</span></label>
          <label className="row">Fondu in <input type="number" min={0} step={0.05} value={sel.fadeIn} style={{ width: 64 }} onChange={(e) => update((q) => { q.clips.find((c) => c.id === sel.id)!.fadeIn = Math.max(0, Number(e.target.value)); }, 'fi' + sel.id)} /></label>
          <label className="row">out <input type="number" min={0} step={0.05} value={sel.fadeOut} style={{ width: 64 }} onChange={(e) => update((q) => { q.clips.find((c) => c.id === sel.id)!.fadeOut = Math.max(0, Number(e.target.value)); }, 'fo' + sel.id)} /> s</label>
          <button className={sel.muted ? 'on' : ''} onClick={() => update((q) => { const c = q.clips.find((x) => x.id === sel.id)!; c.muted = !c.muted; })}>{sel.muted ? 'Inactif' : 'Actif'}</button>
          <span className="mono dim">début {sel.start.toFixed(3)} s · durée {sel.duration.toFixed(3)} s</span>
        </div>
      )}
      <div className="quickrec">
        <button className={'bigrec rec ' + (engine.recording ? 'on' : '')} onClick={() => void quickRecord()} aria-label="Enregistrer">{engine.recording ? '■ STOP' : '● REC'}</button>
        <div className="col grow" style={{ gap: 2 }}>
          <b>{engine.recording ? 'Enregistrement…' : 'Prêt'} sur « {recordTarget()?.name ?? '—'} »</b>
          <span className="dim" style={{ fontSize: 11 }}>{engine.input ? `Micro : ${engine.input.device.label || 'par défaut'}` : 'Le micro s’ouvre au premier enregistrement'} · départ {fmtTime(engine.getPosition())}, pré-roll {p.preroll} s</span>
        </div>
        <button onClick={() => (engine.playing ? engine.stop() : void engine.play())} disabled={engine.recording}>{engine.playing ? '❚❚' : '▶'}</button>
      </div>
    </div>
  );
}
