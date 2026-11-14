/**
 * AI Audio Engineer — rule-based decision engine working on REAL measurements
 * (analysis/analyze.ts). It does not "listen" like a human and makes no claim to:
 * every decision is derived from measured values and is explained in plain words.
 * An LLM layer can later sit on top of this (it would receive the same numbers).
 */
import type { Analysis } from '../analysis/analyze';
import type { EqBand } from '../dsp/eq';
import { defaultEqBands } from '../dsp/eq';
import { createInsert, type InsertState } from '../plugins/registry';

export interface Suggestion { inserts: InsertState[]; volume?: number; notes: string[]; extra?: { target: string; inserts: InsertState[]; notes: string[] }[] }

export type VocalStyle = 'rap' | 'trap' | 'drill' | 'rnb' | 'pop' | 'afro' | 'natural' | 'aggressive' | 'bright' | 'warm' | 'intimate' | 'upfront' | 'airy';

interface StyleProfile {
  label: string; air: number; presence: number; warmth: number; comp: { ratio: number; attack: number; release: number; depth: number };
  sat: number; satMode: 'soft' | 'tape' | 'tube'; reverb: number; decay: number; delay: number; division: string; relLu: number; doubler?: boolean;
}

export const STYLES: Record<VocalStyle, StyleProfile> = {
  rap: { label: 'Rap moderne', air: 2, presence: 1.5, warmth: 0, comp: { ratio: 4, attack: 8, release: 90, depth: 6 }, sat: 6, satMode: 'tape', reverb: 0.08, decay: 1.1, delay: 0.1, division: '1/4', relLu: 1.5 },
  trap: { label: 'Trap', air: 3, presence: 2, warmth: 0, comp: { ratio: 5, attack: 5, release: 70, depth: 8 }, sat: 8, satMode: 'tape', reverb: 0.12, decay: 1.6, delay: 0.16, division: '1/8d', relLu: 1 },
  drill: { label: 'Drill', air: 2, presence: 2.5, warmth: -0.5, comp: { ratio: 6, attack: 3, release: 60, depth: 8 }, sat: 9, satMode: 'soft', reverb: 0.07, decay: 1, delay: 0.12, division: '1/8', relLu: 1 },
  rnb: { label: 'R&B', air: 3, presence: 1, warmth: 1.5, comp: { ratio: 3, attack: 15, release: 150, depth: 5 }, sat: 4, satMode: 'tube', reverb: 0.2, decay: 2.2, delay: 0.14, division: '1/4', relLu: 0.5 },
  pop: { label: 'Pop', air: 3.5, presence: 1.5, warmth: 0.5, comp: { ratio: 4, attack: 10, release: 100, depth: 6 }, sat: 4, satMode: 'tape', reverb: 0.16, decay: 1.8, delay: 0.1, division: '1/8', relLu: 1.5 },
  afro: { label: 'Afro', air: 2.5, presence: 1, warmth: 1, comp: { ratio: 3, attack: 12, release: 120, depth: 5 }, sat: 5, satMode: 'tube', reverb: 0.15, decay: 1.5, delay: 0.15, division: '1/8d', relLu: 0.5 },
  natural: { label: 'Voix naturelle', air: 1, presence: 0.5, warmth: 0.5, comp: { ratio: 2.5, attack: 20, release: 150, depth: 4 }, sat: 0, satMode: 'tape', reverb: 0.1, decay: 1.2, delay: 0, division: '1/4', relLu: 1 },
  aggressive: { label: 'Voix agressive', air: 1.5, presence: 3, warmth: -1, comp: { ratio: 8, attack: 2, release: 50, depth: 10 }, sat: 12, satMode: 'soft', reverb: 0.05, decay: 0.8, delay: 0.08, division: '1/8', relLu: 2 },
  bright: { label: 'Voix brillante', air: 4.5, presence: 2, warmth: -0.5, comp: { ratio: 4, attack: 10, release: 100, depth: 6 }, sat: 4, satMode: 'tape', reverb: 0.12, decay: 1.4, delay: 0.08, division: '1/8', relLu: 1.5 },
  warm: { label: 'Voix chaude', air: 0.5, presence: 0, warmth: 2.5, comp: { ratio: 3, attack: 15, release: 140, depth: 5 }, sat: 6, satMode: 'tube', reverb: 0.12, decay: 1.5, delay: 0.08, division: '1/4', relLu: 1 },
  intimate: { label: 'Voix intimiste', air: 2, presence: 0.5, warmth: 1.5, comp: { ratio: 3, attack: 20, release: 160, depth: 6 }, sat: 3, satMode: 'tube', reverb: 0.06, decay: 0.9, delay: 0, division: '1/4', relLu: 2 },
  upfront: { label: 'Voix très présente', air: 2.5, presence: 3, warmth: 0, comp: { ratio: 6, attack: 4, release: 70, depth: 9 }, sat: 7, satMode: 'tape', reverb: 0.04, decay: 0.8, delay: 0.06, division: '1/8', relLu: 3 },
  airy: { label: 'Voix large et aérienne', air: 5, presence: 1, warmth: 0, comp: { ratio: 3, attack: 12, release: 120, depth: 5 }, sat: 3, satMode: 'tape', reverb: 0.22, decay: 2.6, delay: 0.18, division: '1/8d', relLu: 0.5, doubler: true },
};

const r1 = (x: number): number => Math.round(x * 10) / 10;

export function suggestVocalChain(v: Analysis, beat: Analysis | null, style: VocalStyle): Suggestion {
  const s = STYLES[style];
  const notes: string[] = [];
  const bands: EqBand[] = defaultEqBands();
  // HPF
  bands[0] = { on: true, type: 'highpass', freq: v.bands.sub > -25 ? 100 : 80, gain: 0, q: 0.707 };
  notes.push(v.bands.sub > -25
    ? `Coupe-bas à 100 Hz : ${r1(v.bands.sub)} dB d’énergie sous 60 Hz (grondements, pop du micro), inutile sur une voix.`
    : 'Coupe-bas à 80 Hz pour nettoyer les graves inutiles sur la voix.');
  // Mud
  const mud = v.bands.lowmid;
  if (mud > -9) {
    const cut = Math.min(4, r1((mud + 9) * 0.8 + 1.5));
    bands[2] = { on: true, type: 'peaking', freq: 300, gain: -cut, q: 1.2 };
    notes.push(`Réduction de ${cut} dB autour de 300 Hz : les bas-médiums pèsent ${r1(mud)} dB du total, ce qui rend la voix boueuse.`);
  } else bands[2] = { ...bands[2], freq: 300, gain: 0 };
  // Warmth
  if (s.warmth !== 0) { bands[1] = { on: true, type: 'lowshelf', freq: 180, gain: s.warmth, q: 0.7 }; notes.push(`${s.warmth > 0 ? 'Ajout' : 'Retrait'} de ${Math.abs(s.warmth)} dB sous 180 Hz pour une couleur ${s.warmth > 0 ? 'plus chaude' : 'plus sèche'} (${s.label}).`); }
  // Harshness
  const harsh = v.bands.highmid;
  if (harsh > -12) {
    const cut = Math.min(3.5, r1((harsh + 12) * 0.6 + 1));
    bands[4] = { on: true, type: 'peaking', freq: 3200, gain: -cut, q: 2 };
    notes.push(`Creux de ${cut} dB vers 3,2 kHz : les haut-médiums sont forts (${r1(harsh)} dB), source d’agressivité.`);
  } else if (s.presence > 0) {
    bands[4] = { on: true, type: 'peaking', freq: 3500, gain: s.presence, q: 1 };
    notes.push(`+${s.presence} dB de présence vers 3,5 kHz pour que la voix passe devant l’instru.`);
  }
  // Air
  bands[5] = { on: true, type: 'highshelf', freq: 10000, gain: s.air - (v.bands.air > -22 ? 1.5 : 0), q: 0.7 };
  notes.push(`Shelf aigu +${r1(bands[5].gain)} dB à 10 kHz pour l’air${v.bands.air > -22 ? ' (réduit car la voix est déjà brillante)' : ''}.`);
  const eq = createInsert('eq', { output: 0 }, bands);

  // Compression: threshold from the measured RMS level
  const thr = Math.round(v.rmsDb + 6 - s.comp.depth);
  const comp = createInsert('compressor', { threshold: thr, ratio: s.comp.ratio, attack: s.comp.attack, release: s.comp.release, knee: 6, makeup: r1(s.comp.depth * (1 - 1 / s.comp.ratio) * 0.6), scHpf: 100 });
  notes.push(`Compresseur ${s.comp.ratio}:1, seuil ${thr} dB (RMS mesuré de la voix : ${r1(v.rmsDb)} dBFS), attaque ${s.comp.attack} ms : vise ~${s.comp.depth} dB de réduction sur les passages forts. Dynamique mesurée : crest ${r1(v.crestDb)} dB, LRA ${r1(v.lra)} LU.`);

  // De-esser from the measured sibilance band level
  const sib = v.rmsDb + v.bands.presence;
  const ds = createInsert('deesser', { frequency: 6500, threshold: Math.round(sib + 3), range: v.bands.presence > -16 ? 8 : 5 });
  notes.push(`De-esser à 6,5 kHz, seuil ${Math.round(sib + 3)} dB : la bande 5–10 kHz représente ${r1(v.bands.presence)} dB du total${v.bands.presence > -16 ? ' (sifflantes marquées)' : ''}.`);

  const list: InsertState[] = [createInsert('gate', { threshold: Math.round(Math.max(-70, v.rmsDb - 30)), ratio: 3, range: 15 }), eq, comp, ds];
  list[0].enabled = v.silenceRatio > 0.15;
  if (list[0].enabled) notes.push(`Expander léger : ${Math.round(v.silenceRatio * 100)} % de la prise est quasi silencieuse, on réduit le bruit de fond entre les phrases.`);
  if (s.sat > 0) { list.push(createInsert('saturation', { drive: s.sat, mode: s.satMode, mix: 0.35, output: -1 })); notes.push(`Saturation ${s.satMode} (drive ${s.sat} dB, 35 % parallèle) pour la densité harmonique.`); }
  if (s.doubler) list.push(createInsert('doubler', { mix: 0.25 }));
  if (s.delay > 0) { list.push(createInsert('delay', { division: s.division, feedback: 0.25, mix: s.delay, pingpong: true })); notes.push(`Delay ${s.division} synchronisé au tempo, ${Math.round(s.delay * 100)} % wet.`); }
  if (s.reverb > 0) { list.push(createInsert('reverb', { algo: 'plate', decay: s.decay, mix: s.reverb, predelay: 25 })); notes.push(`Reverb plate ${s.decay} s, ${Math.round(s.reverb * 100)} % wet.`); }

  let volume: number | undefined;
  const extra: Suggestion['extra'] = [];
  if (beat && isFinite(beat.integratedLufs) && isFinite(v.integratedLufs)) {
    // loudness after the chain is unknown until rendered: we only correct the measured raw gap
    const gap = v.integratedLufs - beat.integratedLufs;
    volume = r1(Math.max(-24, Math.min(12, s.relLu - gap)));
    notes.push(`Volume : voix brute à ${r1(v.integratedLufs)} LUFS, instru à ${r1(beat.integratedLufs)} LUFS. Fader réglé à ${volume} dB pour viser la voix ~${s.relLu} LU au-dessus de l’instru (point de départ, à valider à l’oreille).`);
    if (beat.bands.highmid > -14) {
      const b2 = defaultEqBands(); b2[4] = { on: true, type: 'peaking', freq: 3000, gain: -1.5, q: 1.4 };
      extra.push({ target: 'beat', inserts: [createInsert('eq', {}, b2)], notes: [`Instru : creux de 1,5 dB vers 3 kHz pour laisser la place à la voix (haut-médiums de l’instru à ${r1(beat.bands.highmid)} dB).`] });
    }
  }
  if (v.clippedSamples > 0) notes.unshift(`⚠ ${v.clippedSamples} échantillons écrêtés détectés dans la prise : la saturation numérique ne peut pas être annulée. Baisse le gain d’entrée et réenregistre si possible.`);
  return { inserts: list, volume, notes, extra };
}

export type Destination = 'streaming' | 'spotify' | 'apple' | 'youtube' | 'soundcloud' | 'dynamic' | 'dense';
export const DESTINATIONS: Record<Destination, { label: string; lufs: number; tp: number; note: string }> = {
  streaming: { label: 'Streaming (général)', lufs: -14, tp: -1, note: 'Les plateformes normalisent autour de -14 LUFS : un master plus fort sera baissé, pas plus fort à l’écoute.' },
  spotify: { label: 'Spotify', lufs: -14, tp: -1, note: 'Normalisation à -14 LUFS par défaut. En rap, beaucoup de masters sont à -9/-7 LUFS par choix artistique : ils seront baissés.' },
  apple: { label: 'Apple Music', lufs: -16, tp: -1, note: 'Sound Check normalise vers -16 LUFS ; plus de dynamique est conservée.' },
  youtube: { label: 'YouTube', lufs: -14, tp: -1, note: 'YouTube baisse les morceaux au-dessus de ~-14 LUFS, sans les remonter.' },
  soundcloud: { label: 'SoundCloud', lufs: -10, tp: -1, note: 'Pas de normalisation systématique : les masters sont souvent plus forts. Attention à l’encodage (plafond -1 dBTP).' },
  dynamic: { label: 'Master haute dynamique', lufs: -16, tp: -1, note: 'Privilégie les transitoires et le punch.' },
  dense: { label: 'Master dense', lufs: -9, tp: -1, note: 'Fort et compact : coûte de la dynamique, à réserver aux styles qui le demandent.' },
};

/** Rough tonal-balance reference for modern rap/pop mixes (band energy share, dB). Heuristic, not a standard. */
const REF: Record<string, number> = { sub: -8, bass: -3.5, lowmid: -10, mid: -11, highmid: -16, presence: -21, air: -28 };

export function suggestMaster(m: Analysis, dest: Destination): Suggestion {
  const d = DESTINATIONS[dest];
  const notes: string[] = [`Mesures du mix : ${r1(m.integratedLufs)} LUFS intégré, true peak ${r1(m.truePeakDb)} dBTP, LRA ${r1(m.lra)} LU, crest ${r1(m.crestDb)} dB, corrélation ${r1(m.correlation)}.`];
  notes.push(`Cible ${d.label} : ${d.lufs} LUFS, plafond ${d.tp} dBTP. ${d.note} Il n’existe pas de cible universelle : le bon niveau dépend du style et du mix.`);
  const bands = defaultEqBands();
  const diff = (k: string): number => (m.bands as Record<string, number>)[k] - REF[k];
  const corr = (k: string, idx: number, freq: number, type: EqBand['type'], label: string): void => {
    const e = diff(k);
    if (Math.abs(e) > 2) {
      const g = r1(Math.max(-2.5, Math.min(2.5, -e * 0.4)));
      bands[idx] = { on: true, type, freq, gain: g, q: type === 'peaking' ? 0.8 : 0.7 };
      notes.push(`EQ : ${g > 0 ? '+' : ''}${g} dB sur ${label} (écart de ${r1(e)} dB par rapport à une balance tonale de référence).`);
    }
  };
  bands[0] = { on: true, type: 'highpass', freq: 25, gain: 0, q: 0.707 };
  corr('bass', 1, 90, 'lowshelf', 'les basses'); corr('lowmid', 2, 350, 'peaking', 'les bas-médiums');
  corr('highmid', 4, 3500, 'peaking', 'les haut-médiums'); corr('air', 5, 11000, 'highshelf', 'l’air');
  const list: InsertState[] = [createInsert('eq', {}, bands)];
  const glue = createInsert('compressor', { threshold: Math.round(m.rmsDb + 4), ratio: dest === 'dense' ? 2.5 : 1.6, attack: 30, release: 200, knee: 10, scHpf: 90 });
  list.push(glue); notes.push(`Compression de « colle » douce (seuil ${Math.round(m.rmsDb + 4)} dB, ratio ${dest === 'dense' ? 2.5 : 1.6}:1, attaque lente).`);
  if (dest === 'dense') { list.push(createInsert('saturation', { drive: 4, mode: 'tape', mix: 0.3 })); list.push(createInsert('clipper', { ceiling: -0.8, softness: 0.4 })); notes.push('Saturation tape légère + clipper doux pour gagner en densité avant le limiteur.'); }
  if (m.correlation > 0.2) { list.push(createInsert('imager', { width: dest === 'dynamic' ? 1.05 : 1.1, monoBass: 120 })); notes.push('Imager : basses en mono sous 120 Hz, léger élargissement du haut.'); }
  else notes.push(`⚠ Corrélation basse (${r1(m.correlation)}) : risque de problèmes de phase en mono, pas d’élargissement stéréo.`);
  const gain = isFinite(m.integratedLufs) ? Math.max(0, Math.min(14, r1(d.lufs - m.integratedLufs))) : 0;
  list.push(createInsert('limiter', { inputGain: gain, ceiling: d.tp, release: dest === 'dense' ? 50 : 100, truePeak: true }));
  notes.push(`Limiteur true peak, plafond ${d.tp} dBTP, gain ${gain} dB (estimation). Utilise « Viser la cible » : le studio rend le master, mesure le LUFS réel et ajuste le gain.`);
  if (gain > 8) notes.push('⚠ Plus de 8 dB de limitation demandés : le mix est très en dessous de la cible, le limiteur va écraser la dynamique. Mieux vaut augmenter le niveau du mix lui-même.');
  if (m.truePeakDb > -0.1 || m.clippedSamples > 0) notes.push(`⚠ Le mix écrête déjà (${m.clippedSamples} échantillons) : baisse le master du mix avant mastering.`);
  return { inserts: list, notes };
}
