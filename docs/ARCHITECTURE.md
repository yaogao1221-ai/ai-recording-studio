# Architecture — AI Recording Studio

## Vue d’ensemble

```
UI (React)  ──actions──▶  store (projet immuable, undo/redo, autosave IndexedDB)
   │                              │ setProject()
   │ lit les mesures              ▼
   └────────────────────▶  AudioEngine (main thread)
                              ├─ MixGraph : pistes → bus → master (même code en temps réel et hors ligne)
                              │    Strip = gain → inserts → fader → pan → mute → meter
                              ├─ Transport : planification des clips (AudioBufferSourceNode), boucle sans trou
                              ├─ Recorder : micro → AudioWorklet de capture PCM (pas MediaRecorder)
                              └─ AudioWorklet (un module, 3 processeurs)
                                   studio-insert   : noyaux DSP en TypeScript (EQ, dynamique, saturation…)
                                   studio-meter    : crête, RMS, true peak, LUFS M/S/I, LRA, corrélation
                                   studio-recorder : capture PCM alignée sur le transport + niveau d’entrée
render.ts : OfflineAudioContext + MixGraph identique → WAV 16/24 (dither TPDF) / 32 float
analysis/ : mesures sur l’audio réel (BS.1770-4, true peak 4x, FFT, bandes, écrêtage, corrélation)
ai/engineer.ts : décisions d’ingénieur du son à partir des mesures, chacune expliquée
```

Les noyaux DSP (`src/engine/dsp/*`) sont du TypeScript pur, sans dépendance au navigateur :
ils sont testés en Node (vitest) **et** exécutés tels quels dans l’AudioWorklet.

## Ce qui fonctionne réellement (vérifié)

| Domaine | État | Comment c’est vérifié |
|---|---|---|
| EQ paramétrique 7 bandes (RBJ), courbe visuelle + spectre live | ✅ | tests unitaires (réponse mesurée = réponse analytique) |
| Compresseur (genou doux, SC HPF, mix parallèle, GR meter) | ✅ | tests unitaires + test navigateur (GR 26 dB dans le graphe live) |
| Gate / expander, de-esser split-band (Linkwitz-Riley 4) | ✅ | tests unitaires |
| Saturation 4x suréchantillonnée (soft, tape, tube, hard) | ✅ | tests (harmoniques 2 et 3 mesurées) |
| Limiteur look-ahead true peak, clipper, imager M/S, transient shaper | ✅ | tests (aucun échantillon au-dessus du plafond) |
| Reverb à convolution (IR générée room/hall/plate), delay sync BPM / ping-pong / filtré, chorus/flanger, doubler | ✅ | nœuds Web Audio natifs, contrôlés par le moteur |
| LUFS intégré / short-term / momentary, LRA, true peak | ✅ | tests de conformité BS.1770 (sinus 997 Hz = -3,01 LUFS, 44,1 et 48 kHz) |
| Enregistrement PCM (worklet), pré-roll, punch in/out, prises, compensation de latence | ✅ | test navigateur avec faux micro (prise de 2 s non silencieuse) |
| Sélecteur micro iPhone / Bluetooth / USB-C, source réelle affichée | ✅ navigateur, ⚠ iPhone réel non testé | test Chromium ; comportement iOS documenté ci-dessous |
| Timeline multipiste : import glisser-déposer, déplacer, couper, trim, gain de clip, fondus, zoom, boucle | ✅ | test navigateur (import, lecture, mètre master) |
| Console : inserts réordonnables, bypass, copier/coller de chaîne, A/B, presets, routing bus, mute/solo | ✅ | manuel + test |
| Mastering : analyse, chaîne proposée, boucle « viser la cible » qui rend et mesure le LUFS réel, A/B compensé | ✅ | test navigateur (atteint -14 LUFS ± 0,3) |
| Export WAV mix / instrumental / voix / stems / bus, 44,1 / 48 / 96 kHz | ✅ | test navigateur (fichier rendu et mesuré) |
| Projets : autosave, restauration au démarrage, versions, duplication, export/import de session | ✅ | manuel |
| Undo / redo global | ✅ | — |

## Limites connues (honnêtes)

- **Ingénieur IA** : moteur de règles sur des mesures réelles. Il n’« écoute » pas comme un humain et ne remplace pas une oreille. Aucun modèle de langage n’est branché (il faudrait un backend et une clé API).
- **Pas de compensation de latence des plugins (PDC)** : saturation (~12 échantillons) et limiteur (5 ms) décalent légèrement leur piste. Négligeable sur une voix, à corriger avant le travail en parallèle fin.
- **Automation** : pas encore (le modèle de projet est prêt pour l’ajouter).
- **MP3 / FLAC** : non disponibles (nécessite un encodeur WASM, voir ROADMAP).
- **Stockage** : IndexedDB du navigateur. Pas de cloud ni de collaboration.
- **iPhone** : le code suit le comportement de Safari iOS, mais **aucun test sur un iPhone réel** n’a pu être fait d’ici. À valider de ton côté.

## Micros sur iPhone (Safari iOS)

- Les noms des entrées n’existent qu’après autorisation du micro : le studio ouvre d’abord le micro par défaut, puis relit la liste.
- iOS gère une route audio système. Selon la version, Safari expose le micro intégré, un casque Bluetooth (profil HFP) et un micro/interface USB-C comme entrées distinctes, ou une seule entrée qui suit la route système. Le studio **affiche toujours la source réellement ouverte** (label et réglages de la piste `getUserMedia`) et signale si elle ne correspond pas au choix.
- Bluetooth : le micro passe en profil mains libres (bande étroite, latence élevée). Le studio l’indique.
- Capture brute : `echoCancellation`, `noiseSuppression`, `autoGainControl` désactivés. API Audio Session (Safari 16.4+) en `play-and-record`.
- HTTPS obligatoire pour accéder au micro.

## Lancer

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests DSP / analyse
npm run build && npx vite preview --port 4173
node e2e/smoke.mjs http://localhost:4173 e2e-out   # test navigateur (Playwright, faux micro)
```
