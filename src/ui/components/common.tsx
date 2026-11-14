import { useEffect, useRef, useState } from 'react';
import type { ParamDef, ParamValue } from '../../engine/plugins/registry';

export function useFrame(fn: (t: number) => void, active = true): void {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = (t: number): void => { ref.current(t); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}

/** Re-render at ~30 fps (for meters / clocks). */
export function useTicker(active = true): number {
  const [n, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => set((x) => x + 1), 33);
    return () => clearInterval(id);
  }, [active]);
  return n;
}

export const fmtDb = (v: number | undefined, d = 1): string => (v === undefined || !isFinite(v) || v < -150 ? '-∞' : v.toFixed(d));
export const toDb = (g: number): number => (g <= 1e-9 ? -Infinity : 20 * Math.log10(g));
export function fmtTime(s: number): string {
  const m = Math.floor(s / 60); const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** Meter bar from a linear value; scale -60..+3 dB */
export function MeterBar({ value, hold }: { value: number; hold?: number }): JSX.Element {
  const pct = (g: number): number => Math.max(0, Math.min(100, ((toDb(g) + 60) / 63) * 100));
  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <b style={{ height: `${pct(value)}%` }} />
      {hold !== undefined && <i style={{ position: 'absolute', left: 0, right: 0, height: 2, background: hold >= 1 ? 'var(--bad)' : '#fff', bottom: `${pct(hold)}%` }} />}
    </div>
  );
}

export function StereoMeter({ l, r }: { l: number; r: number }): JSX.Element {
  const hold = useRef({ l: 0, r: 0, t: 0 });
  const now = performance.now();
  if (l > hold.current.l || now - hold.current.t > 1500) { hold.current.l = l; hold.current.t = now; }
  if (r > hold.current.r || now - hold.current.t > 1500) hold.current.r = r;
  return <div className="meter" style={{ width: 16 }}><MeterBar value={l} hold={hold.current.l} /><MeterBar value={r} hold={hold.current.r} /></div>;
}

function fmtParam(d: ParamDef, v: ParamValue): string {
  if (d.kind === 'bool') return v ? 'On' : 'Off';
  if (d.kind === 'enum') return d.options?.find((o) => o.value === v)?.label ?? String(v);
  const n = Number(v);
  const s = Math.abs(n) >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 1 : 2) + 'k' : Math.abs(n) < 10 && d.step && d.step < 1 ? n.toFixed(2) : n.toFixed(Math.abs(n) < 100 ? 1 : 0);
  return `${s}${d.unit ? ' ' + d.unit : ''}`;
}

/** Generic control for a plugin parameter. Log-scaled ranges use a log slider. */
export function ParamControl({ def, value, onChange }: { def: ParamDef; value: ParamValue; onChange: (v: ParamValue) => void }): JSX.Element {
  if (def.kind === 'bool') {
    return <div className="param"><label>{def.label}</label><button className={value ? 'on' : ''} onClick={() => onChange(!value)}>{value ? 'Activé' : 'Désactivé'}</button></div>;
  }
  if (def.kind === 'enum') {
    return <div className="param"><label>{def.label}</label>
      <select value={String(value)} onChange={(e) => onChange(e.target.value)}>{def.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
  }
  const min = def.min!, max = def.max!;
  const log = def.log && min > 0;
  const toPos = (v: number): number => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number): number => {
    const v = log ? min * Math.pow(max / min, p) : min + p * (max - min);
    const st = def.step ?? 0; return st ? Math.round(v / st) * st : v;
  };
  return (
    <div className="param" title={def.help}>
      <label>{def.label}<b>{fmtParam(def, value)}</b></label>
      <input type="range" min={0} max={1000} value={Math.round(toPos(Number(value)) * 1000)}
        onChange={(e) => onChange(fromPos(Number(e.target.value) / 1000))}
        onDoubleClick={() => onChange(def.def)} aria-label={def.label} />
    </div>
  );
}
