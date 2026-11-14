import type { EqBand } from '../dsp/eq';
import { defaultEqBands } from '../dsp/eq';

export type ParamValue = number | boolean | string;
export interface ParamDef {
  key: string; label: string; kind: 'number' | 'bool' | 'enum';
  min?: number; max?: number; step?: number; unit?: string; log?: boolean;
  options?: { value: string; label: string }[];
  def: ParamValue; help?: string; advanced?: boolean;
}
export type PluginType =
  | 'utility' | 'gate' | 'eq' | 'compressor' | 'deesser' | 'saturation' | 'transient'
  | 'imager' | 'clipper' | 'limiter' | 'reverb' | 'delay' | 'chorus' | 'doubler';

export interface PluginDef {
  type: PluginType; name: string; short: string; category: string;
  engine: 'worklet' | 'native'; params: ParamDef[]; description: string;
}

const n = (key: string, label: string, min: number, max: number, def: number, unit = '', extra: Partial<ParamDef> = {}): ParamDef =>
  ({ key, label, kind: 'number', min, max, def, unit, step: extra.step ?? (max - min) / 1000, ...extra });
const b = (key: string, label: string, def: boolean, extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, kind: 'bool', def, ...extra });

export const PLUGINS: Record<PluginType, PluginDef> = {
  utility: { type: 'utility', name: 'Gain / Utility', short: 'GAIN', category: 'Utilitaire', engine: 'worklet',
    description: 'Gain d’entrée, inversion de phase et mono.',
    params: [n('gain', 'Gain', -24, 24, 0, 'dB', { step: 0.1 }), b('invertL', 'Phase L', false), b('invertR', 'Phase R', false), b('mono', 'Mono', false)] },
  gate: { type: 'gate', name: 'Gate / Expander', short: 'GATE', category: 'Dynamique', engine: 'worklet',
    description: 'Atténue le signal sous le seuil (bruit de fond, respirations).',
    params: [n('threshold', 'Seuil', -80, 0, -50, 'dB', { step: 0.5 }), n('ratio', 'Ratio', 1, 20, 4, ':1', { step: 0.1 }),
      n('range', 'Plage', 0, 80, 30, 'dB', { step: 1 }), n('attack', 'Attaque', 0.1, 50, 1, 'ms', { log: true }),
      n('hold', 'Hold', 0, 500, 30, 'ms', { step: 1 }), n('release', 'Release', 5, 1000, 150, 'ms', { log: true })] },
  eq: { type: 'eq', name: 'Parametric EQ', short: 'EQ', category: 'Égalisation', engine: 'worklet',
    description: 'EQ paramétrique 7 bandes (HPF, shelves, cloches, LPF).',
    params: [n('output', 'Sortie', -24, 24, 0, 'dB', { step: 0.1 })] },
  compressor: { type: 'compressor', name: 'Compressor', short: 'COMP', category: 'Dynamique', engine: 'worklet',
    description: 'Compresseur feed-forward, genou doux, sidechain HPF, mix parallèle.',
    params: [n('threshold', 'Seuil', -60, 0, -18, 'dB', { step: 0.5 }), n('ratio', 'Ratio', 1, 20, 3, ':1', { step: 0.1 }),
      n('attack', 'Attaque', 0.1, 100, 10, 'ms', { log: true }), n('release', 'Release', 10, 1000, 120, 'ms', { log: true }),
      n('knee', 'Genou', 0, 24, 6, 'dB', { step: 0.5 }), n('makeup', 'Makeup', -12, 24, 0, 'dB', { step: 0.1 }),
      b('autoMakeup', 'Auto gain', false), n('mix', 'Mix', 0, 1, 1, '', { step: 0.01 }),
      n('scHpf', 'SC HPF', 0, 300, 0, 'Hz', { step: 1, advanced: true })] },
  deesser: { type: 'deesser', name: 'De-Esser', short: 'DS', category: 'Dynamique', engine: 'worklet',
    description: 'Réduit les sifflantes (S, CH) au-dessus de la fréquence choisie.',
    params: [n('frequency', 'Fréquence', 2000, 12000, 6500, 'Hz', { log: true }), n('threshold', 'Seuil', -60, 0, -28, 'dB', { step: 0.5 }),
      n('range', 'Réduction max', 0, 24, 8, 'dB', { step: 0.5 }), b('listen', 'Écouter la zone', false)] },
  saturation: { type: 'saturation', name: 'Saturation', short: 'SAT', category: 'Couleur', engine: 'worklet',
    description: 'Saturation suréchantillonnée 4x (soft, tape, tube, hard).',
    params: [n('drive', 'Drive', 0, 36, 6, 'dB', { step: 0.1 }),
      { key: 'mode', label: 'Mode', kind: 'enum', def: 'soft', options: [{ value: 'soft', label: 'Soft' }, { value: 'tape', label: 'Tape' }, { value: 'tube', label: 'Tube' }, { value: 'hard', label: 'Hard' }] },
      n('tone', 'Tonalité', -12, 12, 0, 'dB', { step: 0.1 }), n('mix', 'Mix', 0, 1, 0.5, '', { step: 0.01 }), n('output', 'Sortie', -24, 12, 0, 'dB', { step: 0.1 })] },
  transient: { type: 'transient', name: 'Transient Shaper', short: 'TRS', category: 'Dynamique', engine: 'worklet',
    description: 'Renforce ou adoucit les attaques et le sustain.',
    params: [n('attack', 'Attaque', -12, 12, 0, 'dB', { step: 0.1 }), n('sustain', 'Sustain', -12, 12, 0, 'dB', { step: 0.1 }), n('output', 'Sortie', -12, 12, 0, 'dB', { step: 0.1 })] },
  imager: { type: 'imager', name: 'Stereo Imager', short: 'IMG', category: 'Stéréo', engine: 'worklet',
    description: 'Largeur stéréo mid/side et basses en mono.',
    params: [n('width', 'Largeur', 0, 2, 1, '×', { step: 0.01 }), n('monoBass', 'Mono sous', 0, 300, 0, 'Hz', { step: 1 })] },
  clipper: { type: 'clipper', name: 'Clipper', short: 'CLIP', category: 'Dynamique', engine: 'worklet',
    description: 'Écrêtage doux/dur des pics.',
    params: [n('inputGain', 'Entrée', -12, 24, 0, 'dB', { step: 0.1 }), n('ceiling', 'Plafond', -12, 0, -0.3, 'dB', { step: 0.1 }), n('softness', 'Douceur', 0, 0.95, 0.2, '', { step: 0.01 })] },
  limiter: { type: 'limiter', name: 'Limiter', short: 'LIM', category: 'Dynamique', engine: 'worklet',
    description: 'Limiteur brickwall à anticipation, détection true peak.',
    params: [n('inputGain', 'Gain', 0, 24, 0, 'dB', { step: 0.1 }), n('ceiling', 'Plafond', -6, 0, -1, 'dBTP', { step: 0.1 }),
      n('release', 'Release', 5, 1000, 80, 'ms', { log: true }), n('lookahead', 'Anticipation', 1, 10, 5, 'ms', { step: 0.1, advanced: true }),
      b('truePeak', 'True peak', true, { advanced: true })] },
  reverb: { type: 'reverb', name: 'Reverb', short: 'VERB', category: 'Espace', engine: 'native',
    description: 'Réverbération à convolution (réponse générée : room, hall, plate).',
    params: [{ key: 'algo', label: 'Type', kind: 'enum', def: 'plate', options: [{ value: 'room', label: 'Room' }, { value: 'hall', label: 'Hall' }, { value: 'plate', label: 'Plate' }] },
      n('decay', 'Decay', 0.2, 8, 1.6, 's', { step: 0.05 }), n('predelay', 'Pré-délai', 0, 150, 20, 'ms', { step: 1 }),
      n('damping', 'Amorti', 1000, 18000, 7000, 'Hz', { log: true }), n('width', 'Largeur', 0, 1, 1, '', { step: 0.01 }),
      n('lowCut', 'Low cut', 20, 1000, 250, 'Hz', { log: true }), n('mix', 'Wet', 0, 1, 0.18, '', { step: 0.01 })] },
  delay: { type: 'delay', name: 'Delay', short: 'DLY', category: 'Espace', engine: 'native',
    description: 'Delay synchronisable au tempo, ping-pong, filtré.',
    params: [{ key: 'division', label: 'Division', kind: 'enum', def: '1/8', options: ['free', '1/2', '1/4', '1/4d', '1/8', '1/8d', '1/8t', '1/16'].map((v) => ({ value: v, label: v === 'free' ? 'Libre' : v.replace('d', ' pointé').replace('t', ' triolet') })) },
      n('time', 'Temps libre', 10, 2000, 350, 'ms', { step: 1 }), n('feedback', 'Feedback', 0, 0.95, 0.3, '', { step: 0.01 }),
      b('pingpong', 'Ping-pong', false), n('lowCut', 'Low cut', 20, 2000, 200, 'Hz', { log: true }),
      n('highCut', 'High cut', 1000, 20000, 6000, 'Hz', { log: true }), n('mix', 'Wet', 0, 1, 0.15, '', { step: 0.01 })] },
  chorus: { type: 'chorus', name: 'Chorus / Flanger', short: 'CHO', category: 'Modulation', engine: 'native',
    description: 'Ligne à retard modulée par LFO (chorus ou flanger selon le délai).',
    params: [n('rate', 'Vitesse', 0.05, 8, 0.8, 'Hz', { log: true }), n('depth', 'Profondeur', 0, 10, 3, 'ms', { step: 0.1 }),
      n('delay', 'Délai', 0.5, 30, 12, 'ms', { step: 0.1 }), n('feedback', 'Feedback', 0, 0.9, 0, '', { step: 0.01 }), n('mix', 'Mix', 0, 1, 0.35, '', { step: 0.01 })] },
  doubler: { type: 'doubler', name: 'Vocal Doubler', short: 'DBL', category: 'Modulation', engine: 'native',
    description: 'Deux copies retardées et modulées, panoramiquées gauche/droite.',
    params: [n('spread', 'Écart', 5, 40, 18, 'ms', { step: 0.5 }), n('detune', 'Variation', 0, 2, 0.6, 'ms', { step: 0.05 }), n('width', 'Largeur', 0, 1, 0.9, '', { step: 0.01 }), n('mix', 'Niveau', 0, 1, 0.35, '', { step: 0.01 })] },
};

export interface InsertState {
  id: string; type: PluginType; enabled: boolean;
  params: Record<string, ParamValue>; bands?: EqBand[];
}

let idc = 0;
export const uid = (p = 'id'): string => `${p}_${Date.now().toString(36)}_${(idc++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function createInsert(type: PluginType, overrides: Record<string, ParamValue> = {}, bands?: EqBand[]): InsertState {
  const def = PLUGINS[type];
  const params: Record<string, ParamValue> = {};
  for (const p of def.params) params[p.key] = p.def;
  Object.assign(params, overrides);
  return { id: uid('fx'), type, enabled: true, params, bands: type === 'eq' ? (bands ?? defaultEqBands()) : undefined };
}

export const DELAY_DIVISIONS: Record<string, number> = { '1/2': 2, '1/4': 1, '1/4d': 1.5, '1/8': 0.5, '1/8d': 0.75, '1/8t': 1 / 3, '1/16': 0.25 };
export function delaySeconds(params: Record<string, ParamValue>, bpm: number): number {
  const d = String(params.division);
  if (d === 'free' || !(d in DELAY_DIVISIONS)) return Number(params.time) / 1000;
  return (60 / bpm) * DELAY_DIVISIONS[d];
}
