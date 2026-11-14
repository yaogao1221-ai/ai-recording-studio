/**
 * Microphone source management with real browser capabilities only.
 *
 * iOS / Safari facts this module is built around (verified against WebKit behaviour):
 *  - Device labels are empty until the user has granted microphone permission once.
 *  - iOS routes audio through the system "audio route". Safari lists the inputs the
 *    route currently exposes (built-in mic, AirPods/Bluetooth HFP headset, USB-C
 *    mic/interface). Depending on the iOS version, a connected Bluetooth or USB device
 *    may not appear as a separate entry and the system route decides which mic is used.
 *  - Choosing a Bluetooth mic switches the headset to the HFP/hands-free profile:
 *    the mic is narrow-band (8–24 kHz sample rate) and playback quality drops too.
 *  - We never claim a device is used: we read the label/settings of the live track
 *    returned by getUserMedia and show that to the user.
 */
export type InputKind = 'builtin' | 'bluetooth' | 'usb' | 'other';

export interface InputDevice { deviceId: string; groupId: string; label: string; kind: InputKind }

export interface ActiveInput {
  stream: MediaStream; track: MediaStreamTrack; device: InputDevice;
  settings: MediaTrackSettings; requestedKind: InputKind | null; matchedRequest: boolean;
}

const BT = /airpods|bluetooth|beats|headset|buds|bose|sony wh|sony wf|jabra|powerbeats|hands-?free|\bbt\b|mains libres/i;
const USB = /usb|interface|focusrite|scarlett|shure|mv7|mv88|rode|røde|audient|irig|zoom|presonus|motu|universal audio|apogee|\bssl\b|behringer|steinberg|tascam|yeti|samson|audio-technica|at2020|tc helicon|lightning|external|externe|digital audio/i;
const BUILTIN = /iphone|ipad|built-?in|intégré|interne|internal|default|par défaut|micro de l.iphone|microphone$/i;

export function classifyLabel(label: string): InputKind {
  if (!label) return 'other';
  if (BT.test(label)) return 'bluetooth';
  if (USB.test(label)) return 'usb';
  if (BUILTIN.test(label)) return 'builtin';
  return 'other';
}

export const KIND_LABEL: Record<InputKind, string> = {
  builtin: 'Micro iPhone / intégré', bluetooth: 'Micro Bluetooth', usb: 'Micro USB-C / interface', other: 'Autre entrée',
};

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function inputSupport(): { ok: boolean; reason?: string } {
  if (!window.isSecureContext) return { ok: false, reason: 'Le micro exige une connexion HTTPS (ou localhost).' };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'Ce navigateur ne donne pas accès au micro.' };
  if (typeof AudioWorkletNode === 'undefined') return { ok: false, reason: 'AudioWorklet non supporté (iOS 14.5+ requis).' };
  return { ok: true };
}

/** Safari 16.4+ Audio Session API: allow simultaneous playback + recording without ducking. */
export function configureAudioSession(mode: 'play-and-record' | 'playback'): void {
  const s = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (s) { try { s.type = mode; } catch { /* unsupported value */ } }
}

export async function listInputs(): Promise<InputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d) => ({
    deviceId: d.deviceId, groupId: d.groupId, label: d.label, kind: classifyLabel(d.label),
  }));
}

export function hasLabels(list: InputDevice[]): boolean { return list.some((d) => d.label); }

export interface OpenOptions { deviceId?: string; kind?: InputKind; processing?: boolean }

/** Open a microphone. Raw capture by default (no echo cancellation / noise suppression / AGC). */
export async function openInput(o: OpenOptions): Promise<ActiveInput> {
  const raw = !o.processing;
  const base: MediaTrackConstraints = {
    echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw,
    channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 },
  };
  let deviceId = o.deviceId;
  if (!deviceId && o.kind) {
    const match = (await listInputs()).find((d) => d.kind === o.kind);
    deviceId = match?.deviceId;
  }
  const constraints: MediaStreamConstraints = { audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  // Labels become available after permission: resolve the device actually opened.
  const list = await listInputs();
  const dev = list.find((d) => d.deviceId === settings.deviceId) ?? {
    deviceId: settings.deviceId ?? '', groupId: settings.groupId ?? '', label: track.label, kind: classifyLabel(track.label),
  };
  if (!dev.label) dev.label = track.label;
  if (dev.kind === 'other') dev.kind = classifyLabel(track.label);
  const requestedKind = o.kind ?? null;
  return { stream, track, device: dev, settings, requestedKind, matchedRequest: !requestedKind || dev.kind === requestedKind };
}

export function closeInput(a: ActiveInput | null): void { a?.stream.getTracks().forEach((t) => t.stop()); }

/** Human-readable explanation when the requested kind is not exposed by the browser. */
export function unavailableMessage(kind: InputKind, ios: boolean): string {
  if (kind === 'bluetooth') {
    return ios
      ? 'Aucun micro Bluetooth n’est exposé à Safari. Vérifie que les AirPods / le casque sont connectés dans Réglages > Bluetooth, puis recharge la liste. Sur certaines versions d’iOS, Safari n’affiche qu’une entrée et c’est iOS qui choisit le micro actif : la source réellement utilisée est affichée ci-dessous. Note : en Bluetooth, iOS passe en profil « mains libres » (qualité micro réduite).'
      : 'Aucun micro Bluetooth détecté. Connecte le casque au système puis recharge la liste.';
  }
  if (kind === 'usb') {
    return ios
      ? 'Aucun micro USB-C détecté. Branche le micro ou l’interface (alimentation externe si besoin), attends quelques secondes puis recharge la liste. iOS bascule automatiquement l’entrée sur le périphérique USB quand il est reconnu.'
      : 'Aucun micro USB détecté. Branche le périphérique puis recharge la liste.';
  }
  return 'Aucun micro intégré détecté.';
}
