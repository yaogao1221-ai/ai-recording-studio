import { useSyncExternalStore } from 'react';
import type { Clip, Project } from '../engine/model';
import { createProject } from '../engine/model';
import type { InsertState } from '../engine/plugins/registry';
import { engine } from '../engine/engine';
import { saveProject } from '../engine/storage';

export type View = 'studio' | 'record' | 'mixer' | 'master' | 'analyzer' | 'export' | 'projects';
export interface Ui {
  view: View; selectedTrack: string | null; selectedClip: string | null;
  editing: { channel: string; insert: string } | null;
  zoom: number; mode: 'beginner' | 'advanced'; toast: string | null; snap: boolean;
  chainClipboard: InsertState[] | null; onboarding: boolean;
}
interface State { project: Project; ui: Ui; past: Project[]; future: Project[]; savedAt: number; saving: boolean }

const LS = (k: string, v?: string): string | null => {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* storage unavailable */ }
  return null;
};

let state: State = {
  project: createProject(),
  ui: {
    view: 'studio', selectedTrack: null, selectedClip: null, editing: null, zoom: 60,
    mode: (LS('ars.mode') as Ui['mode']) || 'beginner', toast: null, snap: true, chainClipboard: null,
    onboarding: LS('ars.onboarded') !== '1',
  },
  past: [], future: [], savedAt: 0, saving: false,
};
const subs = new Set<() => void>();
const notify = (): void => subs.forEach((f) => f());

export const getState = (): State => state;
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}

let lastCoalesce = ''; let lastCoalesceAt = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Apply a change to the project. Every change is undoable; rapid changes with the same
 * coalesce key (e.g. dragging a fader) are merged into one history step.
 */
export function update(fn: (p: Project) => void, coalesce?: string): void {
  const next = structuredClone(state.project);
  fn(next);
  next.updatedAt = Date.now();
  const now = performance.now();
  const merge = coalesce && coalesce === lastCoalesce && now - lastCoalesceAt < 800;
  lastCoalesce = coalesce ?? ''; lastCoalesceAt = now;
  const past = merge ? state.past : [...state.past, state.project].slice(-150);
  setProject(next, past, []);
}

function setProject(p: Project, past: Project[], future: Project[]): void {
  state = { ...state, project: p, past, future };
  engine.setProject(p);
  scheduleSave();
  notify();
}

export function undo(): void {
  const prev = state.past[state.past.length - 1];
  if (!prev) return;
  setProject(prev, state.past.slice(0, -1), [state.project, ...state.future]);
  toast('Annulé');
}
export function redo(): void {
  const nxt = state.future[0];
  if (!nxt) return;
  setProject(nxt, [...state.past, state.project], state.future.slice(1));
  toast('Rétabli');
}

/** Replace the whole project (open / new) without history. */
export function loadIntoStore(p: Project): void {
  state = { ...state, project: p, past: [], future: [], ui: { ...state.ui, selectedClip: null, editing: null, selectedTrack: p.tracks.find((t) => t.armed)?.id ?? p.tracks[0]?.id ?? null } };
  LS('ars.lastProject', p.id);
  engine.setProject(p);
  notify();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 1200);
}
export async function saveNow(): Promise<void> {
  state = { ...state, saving: true }; notify();
  try { await saveProject(state.project); LS('ars.lastProject', state.project.id); state = { ...state, saving: false, savedAt: Date.now() }; }
  catch (e) { state = { ...state, saving: false }; toast('Sauvegarde impossible : ' + (e as Error).message); }
  notify();
}

export function setUi(p: Partial<Ui>): void {
  state = { ...state, ui: { ...state.ui, ...p } };
  if (p.mode) LS('ars.mode', p.mode);
  if (p.onboarding === false) LS('ars.onboarded', '1');
  notify();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string): void {
  setUi({ toast: msg });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setUi({ toast: null }), 3200);
}

// ---- helpers ----
export function findChannel(p: Project, id: string): { inserts: InsertState[] } | undefined {
  if (id === 'master') return p.master;
  return p.tracks.find((t) => t.id === id) ?? p.buses.find((b) => b.id === id);
}
export function clipById(p: Project, id: string | null): Clip | undefined { return id ? p.clips.find((c) => c.id === id) : undefined; }
