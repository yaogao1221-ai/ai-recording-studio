import type { InsertState } from './plugins/registry';
import { createInsert, uid } from './plugins/registry';

export type TrackRole = 'lead' | 'double' | 'adlib' | 'harmony' | 'beat' | 'other';
export const ROLE_LABEL: Record<TrackRole, string> = {
  lead: 'Voix lead', double: 'Doubles', adlib: 'Adlibs', harmony: 'Harmonies', beat: 'Instrumental', other: 'Audio',
};

export interface Clip {
  id: string; trackId: string; assetId: string; name: string;
  /** timeline position (s) */ start: number;
  /** offset into the source asset (s) */ offset: number;
  duration: number; gain: number; fadeIn: number; fadeOut: number; muted: boolean;
  /** recording pass this clip came from (for take management) */ take?: number;
}

export interface Channel {
  id: string; name: string; color: string;
  volume: number; pan: number; mute: boolean; solo: boolean;
  inserts: InsertState[]; output: string; // 'master' or bus id
}
export interface Track extends Channel { kind: 'track'; role: TrackRole; armed: boolean; inputGain: number }
export interface Bus extends Channel { kind: 'bus' }
export interface Master { id: 'master'; volume: number; inserts: InsertState[] }

export interface Project {
  id: string; name: string; bpm: number; createdAt: number; updatedAt: number;
  tracks: Track[]; buses: Bus[]; master: Master; clips: Clip[];
  loop: { on: boolean; start: number; end: number };
  punch: { on: boolean; start: number; end: number };
  preroll: number; // seconds
  /** manual extra latency compensation for recordings (ms) */ recordOffsetMs: number;
  schema: 1;
}

export interface AssetMeta { id: string; name: string; sampleRate: number; channels: number; duration: number; createdAt: number }

export const TRACK_COLORS = ['#ff6b4a', '#ffb347', '#f5d547', '#7bd389', '#4ad6c9', '#5aa9ff', '#9b8cff', '#ff7ab6', '#c0c6d4'];

export function newTrack(name: string, role: TrackRole, color: string, output = 'master'): Track {
  return { kind: 'track', id: uid('trk'), name, role, color, volume: 0, pan: 0, mute: false, solo: false, armed: false, inputGain: 0, inserts: [], output };
}
export function newBus(name: string, color: string): Bus {
  return { kind: 'bus', id: uid('bus'), name, color, volume: 0, pan: 0, mute: false, solo: false, inserts: [], output: 'master' };
}

/** Default rap/vocal session template: vocal tracks routed to a vocal bus, beat to an instrumental bus. */
export function createProject(name = 'Nouveau projet'): Project {
  const vb = newBus('Bus voix', '#ff6b4a');
  const ib = newBus('Bus instru', '#5aa9ff');
  vb.inserts = [createInsert('compressor', { threshold: -16, ratio: 2, attack: 20, release: 150, knee: 8 }), createInsert('reverb', { mix: 0.12 })];
  vb.inserts[1].enabled = false;
  const lead = newTrack('Voix lead', 'lead', '#ff6b4a', vb.id);
  lead.inserts = [createInsert('gate', { threshold: -55 }), createInsert('eq'), createInsert('compressor'), createInsert('deesser'), createInsert('saturation', { drive: 4, mix: 0.3 })];
  lead.inserts[0].enabled = false; lead.inserts[4].enabled = false;
  lead.armed = true;
  const t = Date.now();
  return {
    id: uid('prj'), name, bpm: 90, createdAt: t, updatedAt: t,
    tracks: [
      newTrack('Instrumental', 'beat', '#5aa9ff', ib.id),
      lead,
      newTrack('Doubles', 'double', '#ffb347', vb.id),
      newTrack('Adlibs', 'adlib', '#f5d547', vb.id),
      newTrack('Harmonies', 'harmony', '#9b8cff', vb.id),
    ],
    buses: [vb, ib],
    master: { id: 'master', volume: 0, inserts: [createInsert('eq'), createInsert('compressor', { threshold: -12, ratio: 1.5, attack: 30, release: 200, knee: 10 }), createInsert('limiter')] },
    clips: [], loop: { on: false, start: 0, end: 8 }, punch: { on: false, start: 4, end: 8 }, preroll: 2, recordOffsetMs: 0, schema: 1,
  };
}

export function projectDuration(p: Project): number {
  return p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}
