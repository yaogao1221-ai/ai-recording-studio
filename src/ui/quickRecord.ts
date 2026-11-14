import { engine } from '../engine/engine';
import { getState, setUi, toast } from '../state/store';

/** Track that will receive the next recording: selected vocal track, else armed, else lead. */
export function recordTarget(): { id: string; name: string } | undefined {
  const { project: p, ui } = getState();
  return p.tracks.find((t) => t.id === ui.selectedTrack && t.role !== 'beat') ?? p.tracks.find((t) => t.armed) ?? p.tracks.find((t) => t.role === 'lead');
}

/** One-tap record/stop from anywhere. Opens the current system mic if none is open. */
export async function quickRecord(): Promise<void> {
  if (engine.recording) { await engine.stopRecording(); return; }
  const t = recordTarget();
  if (!t) { toast('Ajoute une piste voix pour enregistrer.'); return; }
  try {
    if (!engine.input) {
      const a = await engine.openMic({});
      toast(`Micro : ${a.device.label || 'micro par défaut'} (change-le dans Cabine)`);
    }
    await engine.startRecording(t.id);
  } catch (e) {
    const err = e as DOMException;
    if (err.name === 'NotAllowedError') toast('Micro refusé : Réglages > Safari > Microphone > Autoriser.');
    else toast('Enregistrement impossible : ' + (err.message || err.name));
    setUi({ view: 'record' });
  }
}
