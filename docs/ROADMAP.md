# Feuille de route — fonctionnalités avancées

Classement de la liste « Final professional DAW expansion » selon ce qui est réellement faisable.
✅ = déjà dans le studio · 🟢 = faisable en navigateur, prochaines étapes · 🟡 = faisable en navigateur mais lourd (WASM / gros chantier) · 🔴 = nécessite un serveur, un modèle IA ou un moteur natif

## Édition audio
| Fonction | État | Notes |
|---|---|---|
| Clip gain, fondus, édition non destructive | ✅ | les clips pointent vers l’audio source, rien n’est réécrit |
| Crossfades automatiques | 🟢 | fondus croisés au chevauchement de clips |
| Beat slicing | 🟢 | détection de transitoires + découpe |
| Quantification audio | 🟢 | après détection des transitoires |
| Time stretch / pitch shift / warping | 🟡 | qualité pro = Rubber Band (GPL, licence commerciale payante) ou SoundTouch (LGPL) en WASM |
| Édition / réparation spectrale | 🟡 | STFT + resynthèse en worker, gros chantier UI |

## Production musicale
| Fonction | État | Notes |
|---|---|---|
| Step sequencer, drum machine, sampler | 🟢 | Web Audio natif |
| Piano roll, éditeur MIDI, vélocité, quantification MIDI, groove | 🟢 | nouveau type de piste MIDI |
| Arpégiateur, générateur d’accords, pattern sequencer | 🟢 | logique musicale pure |
| Instruments virtuels | 🟢/🟡 | synthés simples en worklet ; banques de sons = poids et licences |

## Mixage avancé
| Fonction | État | Notes |
|---|---|---|
| Compression parallèle, bus, groupes, stéréo M/S, corrélation | ✅ | mix du compresseur, bus, imager, mètres |
| Sends / returns | 🟢 | prochaine étape prioritaire |
| Sidechain routing | 🟢 | entrée sidechain externe dans le worklet |
| Dynamic EQ, compression multibande | 🟢 | noyaux DSP à ajouter (crossover LR4 déjà présent) |
| Automation | 🟢 | prioritaire |
| Snapshots de mix, pistes de référence, loudness matching | 🟢 | |

## IA
| Fonction | État | Notes |
|---|---|---|
| Analyse mix / master, critique chiffrée, variantes de mastering | ✅/🟢 | règles sur mesures réelles ; variantes = plusieurs destinations rendues |
| Détection de structure, analyse de beat (BPM, tonalité) | 🟡 | Essentia.js (AGPL : attention à la licence) ou algorithmes maison |
| Correction de hauteur (type autotune) | 🟡 | détection YIN + PSOLA en worklet, faisable mais long à rendre propre |
| Nettoyage vocal IA, séparation de stems | 🔴 | modèles (Demucs, etc.) : serveur GPU ou ONNX WASM très lent sur iPhone |
| Arrangement vocal, génération d’harmonies | 🔴/🟡 | harmonies = pitch shift ; arrangement = modèle |
| Assistant conversationnel | 🔴 | backend + API de modèle de langage |

## Workflow pro
| Fonction | État | Notes |
|---|---|---|
| Autosave, undo/redo, versions, récupération, export stems / instru / voix / bus / session | ✅ | |
| Export MP3 / FLAC | 🟡 | encodeur WASM (LAME LGPL, libFLAC BSD) |
| Cloud backup, partage, collaboration | 🔴 | backend + stockage + authentification |

## Architecture
| Fonction | État | Notes |
|---|---|---|
| AudioWorklet, routing, plugins extensibles (registre) | ✅ | |
| Tests audio automatisés, test navigateur | ✅ | vitest + Playwright |
| Workers pour calculs lourds | 🟢 | analyse et rendu à déplacer en Worker |
| WASM DSP | 🟡 | utile seulement là où le TS ne suffit pas |
| Tests iPhone | 🔴 ici | impossible sans appareil : à faire sur ton iPhone |

## Ordre proposé
1. Sends/returns + automation
2. Crossfades auto, pistes de référence, snapshots
3. Compression multibande + dynamic EQ
4. Pistes MIDI : step sequencer, sampler, piano roll
5. Correction de hauteur (YIN + PSOLA)
6. Export MP3/FLAC (WASM)
7. Backend (comptes, cloud, IA conversationnelle, séparation de stems)
