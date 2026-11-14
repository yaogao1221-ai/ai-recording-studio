import { useEffect, useRef } from 'react';
import { engine } from '../../engine/engine';
import { eqResponseDb, type EqBand } from '../../engine/dsp/eq';
import type { FilterType } from '../../engine/dsp/biquad';
import { PLUGINS, type InsertState, type ParamValue } from '../../engine/plugins/registry';
import { findChannel, update, useStore } from '../../state/store';
import { ParamControl, useFrame } from './common';

const FT: { v: FilterType; l: string }[] = [
  { v: 'highpass', l: 'Coupe-bas' }, { v: 'lowshelf', l: 'Low shelf' }, { v: 'peaking', l: 'Cloche' },
  { v: 'notch', l: 'Notch' }, { v: 'highshelf', l: 'High shelf' }, { v: 'lowpass', l: 'Coupe-haut' },
];

function EqGraph({ bands, onChange, sr }: { bands: EqBand[]; onChange: (b: EqBand[]) => void; sr: number }): JSX.Element {
  const cv = useRef<HTMLCanvasElement>(null);
  const dragI = useRef(-1);
  const spec = useRef<Float32Array | null>(null);
  const fx = (f: number, w: number): number => (Math.log10(f / 20) / 3) * w;
  const xf = (x: number, w: number): number => 20 * Math.pow(10, (x / w) * 3);
  const gy = (g: number, h: number): number => h / 2 - (g / 18) * (h / 2 - 10);
  useFrame(() => {
    const c = cv.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1; const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    g.strokeStyle = '#1b2029'; g.lineWidth = 1; g.font = '10px JetBrains Mono'; g.fillStyle = '#5d6574';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = fx(f, w); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 4); }
    for (const d of [-12, -6, 0, 6, 12]) { const y = gy(d, h); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillText(String(d), 2, y - 2); }
    // live spectrum of the master output (real data)
    const an = engine.graph?.master.analyser;
    if (an) {
      if (!spec.current || spec.current.length !== an.frequencyBinCount) spec.current = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(spec.current);
      g.beginPath(); g.fillStyle = 'rgba(90,169,255,.12)'; g.moveTo(0, h);
      const binHz = an.context.sampleRate / an.fftSize;
      for (let x = 0; x < w; x += 2) { const k = Math.min(spec.current.length - 1, Math.round(xf(x, w) / binHz)); const v = Math.max(-100, spec.current[k] + 4.5 * Math.log2(xf(x, w) / 1000)); g.lineTo(x, h - ((v + 100) / 100) * h); }
      g.lineTo(w, h); g.fill();
    }
    const fs: number[] = []; for (let x = 0; x <= w; x += 2) fs.push(xf(x, w));
    const r = eqResponseDb(bands, fs, sr);
    g.beginPath(); g.strokeStyle = '#ff6b4a'; g.lineWidth = 2;
    r.forEach((d, i) => { const y = gy(Math.max(-18, Math.min(18, d)), h); if (i) g.lineTo(i * 2, y); else g.moveTo(0, y); }); g.stroke();
    bands.forEach((b, i) => {
      const x = fx(b.freq, w), y = b.type === 'highpass' || b.type === 'lowpass' || b.type === 'notch' ? h / 2 : gy(b.gain, h);
      g.globalAlpha = b.on ? 1 : 0.35; g.fillStyle = '#ffb347'; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill();
      g.fillStyle = '#1a0c06'; g.font = '600 9px Inter'; g.fillText(String(i + 1), x - 2.5, y + 3); g.globalAlpha = 1;
    });
  });
  const pos = (e: React.PointerEvent): { x: number; y: number; w: number; h: number } => { const r = cv.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
  return <canvas ref={cv} className="eqcanvas"
    onPointerDown={(e) => { const p = pos(e); let best = -1, bd = 400; bands.forEach((b, i) => { const dx = fx(b.freq, p.w) - p.x; const dy = (b.type === 'peaking' || b.type.includes('shelf') ? gy(b.gain, p.h) : p.h / 2) - p.y; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }); dragI.current = best; (e.target as Element).setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { const i = dragI.current; if (i < 0) return; const p = pos(e); const nb = bands.map((b) => ({ ...b })); const b = nb[i]; b.freq = Math.round(Math.max(20, Math.min(20000, xf(p.x, p.w)))); if (b.type === 'peaking' || b.type.includes('shelf')) b.gain = Math.round(Math.max(-18, Math.min(18, ((p.h / 2 - p.y) / (p.h / 2 - 10)) * 18)) * 10) / 10; b.on = true; onChange(nb); }}
    onPointerUp={() => { dragI.current = -1; }}
    onWheel={(e) => { const p = { x: e.nativeEvent.offsetX }; const w = cv.current!.clientWidth; let best = -1, bd = 1e9; bands.forEach((b, i) => { const d = Math.abs(fx(b.freq, w) - p.x); if (d < bd) { bd = d; best = i; } }); if (best < 0) return; const nb = bands.map((b) => ({ ...b })); nb[best].q = Math.max(0.1, Math.min(18, nb[best].q * (e.deltaY < 0 ? 1.1 : 0.9))); onChange(nb); }} />;
}

export function PluginEditor({ channel, insertId }: { channel: string; insertId: string }): JSX.Element | null {
  const p = useStore((s) => s.project);
  const mode = useStore((s) => s.ui.mode);
  const ins = findChannel(p, channel)?.inserts.find((i) => i.id === insertId);
  const grRef = useRef<HTMLSpanElement>(null);
  useEffect(() => { /* noop: re-render on id change */ }, [insertId]);
  useFrame(() => {
    const strip = channel === 'master' ? engine.graph?.master : engine.graph?.strips.get(channel);
    if (grRef.current && strip) grRef.current.textContent = (strip.gr[insertId] ?? 0).toFixed(1);
  });
  if (!ins) return null;
  const def = PLUGINS[ins.type];
  const set = (fn: (i: InsertState) => void, key: string): void => update((q) => { const i = findChannel(q, channel)!.inserts.find((x) => x.id === insertId)!; fn(i); }, insertId + key);
  const setParam = (k: string, v: ParamValue): void => set((i) => { i.params[k] = v; }, k);
  const sr = engine.isReady ? engine.ctx.sampleRate : 48000;
  const hasGr = ['compressor', 'gate', 'deesser', 'limiter', 'clipper'].includes(ins.type);
  return (
    <div className="editor">
      <div className="row" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>{def.name}</b><span className="muted">{def.description}</span><span className="sp" />
        {hasGr && <span className="badge">Réduction <span ref={grRef} className="mono">0.0</span> dB</span>}
        <button className={ins.enabled ? 'on' : ''} onClick={() => set((i) => { i.enabled = !i.enabled; }, 'en')}>{ins.enabled ? 'Actif' : 'Bypass'}</button>
      </div>
      {ins.type === 'eq' && ins.bands && (
        <div className="col" style={{ marginBottom: 10 }}>
          <EqGraph bands={ins.bands} sr={sr} onChange={(b) => set((i) => { i.bands = b; }, 'bands')} />
          <div className="params">
            {ins.bands.map((b, k) => (
              <div key={k} className="param" style={{ opacity: b.on ? 1 : 0.55 }}>
                <label><span><input type="checkbox" checked={b.on} onChange={(e) => set((i) => { i.bands![k].on = e.target.checked; }, 'b' + k)} /> Bande {k + 1}</span>
                  <select value={b.type} style={{ fontSize: 10, padding: '0 2px' }} onChange={(e) => set((i) => { i.bands![k].type = e.target.value as FilterType; }, 'bt' + k)}>{FT.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select></label>
                <div className="row mono" style={{ fontSize: 11 }}>
                  <input type="number" value={b.freq} min={20} max={20000} style={{ width: 70 }} onChange={(e) => set((i) => { i.bands![k].freq = Number(e.target.value); }, 'bf' + k)} />Hz
                  <input type="number" value={b.gain} step={0.5} style={{ width: 54 }} onChange={(e) => set((i) => { i.bands![k].gain = Number(e.target.value); }, 'bg' + k)} />dB
                  {mode === 'advanced' && <><input type="number" value={b.q} step={0.1} min={0.1} style={{ width: 48 }} onChange={(e) => set((i) => { i.bands![k].q = Number(e.target.value); }, 'bq' + k)} />Q</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="params">
        {def.params.filter((d) => mode === 'advanced' || !d.advanced).map((d) => <ParamControl key={d.key} def={d} value={ins.params[d.key]} onChange={(v) => setParam(d.key, v)} />)}
      </div>
      <div className="dim" style={{ marginTop: 8, fontSize: 11 }}>Double-clic sur un curseur : valeur par défaut. EQ : glisse les points, molette = Q.</div>
    </div>
  );
}
