import { useRef } from 'react';
import { engine } from '../../engine/engine';
import { fmtDb, toDb, useFrame, useTicker } from '../components/common';

/** Real-time analysers fed by the master output (AnalyserNode + meter worklet). */
export function Analyzer(): JSX.Element {
  useTicker(true);
  const spec = useRef<HTMLCanvasElement>(null);
  const sgram = useRef<HTMLCanvasElement>(null);
  const gonio = useRef<HTMLCanvasElement>(null);
  const buf = useRef<Float32Array | null>(null);
  const td = useRef<{ l: Float32Array; r: Float32Array } | null>(null);
  const m = engine.graph?.master.meterValue;
  useFrame(() => {
    const an = engine.graph?.master.analyser; if (!an) return;
    if (!buf.current) buf.current = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(buf.current);
    const sr = an.context.sampleRate, binHz = sr / an.fftSize;
    const xf = (x: number, w: number): number => 20 * Math.pow(10, (x / w) * 3);
    const c = spec.current;
    if (c) {
      const w = (c.width = c.clientWidth), h = (c.height = c.clientHeight);
      const g = c.getContext('2d')!; g.fillStyle = '#090b0f'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#1b2029'; for (const f of [100, 1000, 10000]) { const x = (Math.log10(f / 20) / 3) * w; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      g.beginPath(); g.strokeStyle = '#ff6b4a'; g.lineWidth = 1.5;
      for (let x = 0; x < w; x++) { const k = Math.min(buf.current.length - 1, Math.round(xf(x, w) / binHz)); const v = buf.current[k] + 4.5 * Math.log2(xf(x, w) / 1000); const y = h - ((v + 110) / 110) * h; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    }
    const s = sgram.current;
    if (s) {
      if (s.width !== s.clientWidth) { s.width = s.clientWidth; s.height = s.clientHeight; }
      const g = s.getContext('2d')!; const w = s.width, h = s.height;
      g.drawImage(s, -1, 0);
      for (let y = 0; y < h; y++) {
        const f = 20 * Math.pow(10, ((h - y) / h) * 3); const k = Math.min(buf.current.length - 1, Math.round(f / binHz));
        const v = Math.max(0, Math.min(1, (buf.current[k] + 100) / 80));
        g.fillStyle = `hsl(${260 - v * 250},90%,${v * 55}%)`; g.fillRect(w - 1, y, 1, 1);
      }
    }
    // goniometer (vectorscope) from the two channel analysers
    const gc = gonio.current; const aL = engine.graph?.master.analyserL, aR = engine.graph?.master.analyserR;
    if (gc && aL && aR) {
      if (!td.current) td.current = { l: new Float32Array(aL.fftSize), r: new Float32Array(aR.fftSize) };
      aL.getFloatTimeDomainData(td.current.l); aR.getFloatTimeDomainData(td.current.r);
      const w = (gc.width = gc.clientWidth), h = (gc.height = gc.clientHeight);
      const g = gc.getContext('2d')!; g.fillStyle = '#090b0f'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#1b2029'; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      g.fillStyle = 'rgba(255,179,71,.5)';
      for (let i = 0; i < td.current.l.length; i += 2) {
        const l = td.current.l[i], r = td.current.r[i];
        const x = w / 2 + ((r - l) * Math.SQRT1_2) * w * 0.45, y = h / 2 - ((l + r) * Math.SQRT1_2) * h * 0.45;
        g.fillRect(x, y, 1.2, 1.2);
      }
    }
  });
  const corr = m?.correlation ?? 0;
  return (
    <div className="page">
      <div className="card"><h3>Analyseur de spectre (sortie master)</h3><canvas ref={spec} style={{ width: '100%', height: 220, borderRadius: 10 }} /></div>
      <div className="row wrap" style={{ alignItems: 'stretch', gap: 14 }}>
        <div className="card grow" style={{ minWidth: 280 }}><h3>Spectrogramme</h3><canvas ref={sgram} style={{ width: '100%', height: 200, borderRadius: 10, background: '#090b0f' }} /></div>
        <div className="card" style={{ width: 240 }}><h3>Stéréo / phase</h3><canvas ref={gonio} style={{ width: '100%', height: 200, borderRadius: 10 }} />
          <div className="levelbar" style={{ marginTop: 8 }}><i style={{ left: `${Math.min(50, (corr + 1) * 50)}%`, width: `${Math.abs(corr) * 50}%`, background: corr < 0 ? 'var(--bad)' : 'var(--ok)' }} /></div>
          <div className="row mono" style={{ fontSize: 11 }}><span>-1</span><span className="sp" style={{ textAlign: 'center' }}>corrélation {corr.toFixed(2)}</span><span>+1</span></div>
        </div>
      </div>
      <div className="card">
        <h3>Niveaux</h3>
        <div className="metrics">
          <div className="metric"><small>Crête L / R</small><b>{fmtDb(toDb(m?.peakL ?? 0))} / {fmtDb(toDb(m?.peakR ?? 0))}</b></div>
          <div className="metric"><small>RMS L / R</small><b>{fmtDb(toDb(m?.rmsL ?? 0))} / {fmtDb(toDb(m?.rmsR ?? 0))}</b></div>
          <div className="metric"><small>True peak</small><b>{fmtDb(toDb(m?.truePeak ?? 0), 2)}</b> <span className="dim">dBTP</span></div>
          <div className="metric"><small>Momentary</small><b>{fmtDb(m?.momentary)}</b> <span className="dim">LUFS</span></div>
          <div className="metric"><small>Short-term</small><b>{fmtDb(m?.shortTerm)}</b> <span className="dim">LUFS</span></div>
          <div className="metric"><small>Intégré</small><b>{fmtDb(m?.integrated)}</b> <span className="dim">LUFS</span></div>
          <div className="metric"><small>Plage dynamique (LRA)</small><b>{(m?.lra ?? 0).toFixed(1)}</b> <span className="dim">LU</span></div>
          <div className="metric"><small>PLR (crête − LUFS)</small><b>{m && isFinite(m.shortTerm ?? -Infinity) ? (toDb(m.truePeak ?? 0) - (m.shortTerm ?? 0)).toFixed(1) : '—'}</b> <span className="dim">dB</span></div>
        </div>
        {!engine.playing && <div className="dim" style={{ marginTop: 8 }}>Lance la lecture pour alimenter les analyseurs.</div>}
      </div>
    </div>
  );
}
