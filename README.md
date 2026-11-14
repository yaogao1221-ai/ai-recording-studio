# AI Recording Studio

Studio d’enregistrement, de mixage et de mastering dans le navigateur — Web Audio API + AudioWorklet, DSP réel testé.

- **Studio** : timeline multipiste, import glisser-déposer, édition de clips
- **Cabine** : micro iPhone / Bluetooth / USB-C, test, prises, punch, pré-roll
- **Console** : chaînes d’effets par piste et bus, ingénieur IA (règles sur mesures réelles)
- **Master** : analyse LUFS / true peak, chaîne proposée, boucle de mesure vers la cible
- **Export** : WAV 16/24/32f, 44,1/48/96 kHz, mix / stems / instru / voix / bus

Docs : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (état réel, limites) · [`docs/ROADMAP.md`](docs/ROADMAP.md)

```bash
npm install && npm run dev
npm test
```
