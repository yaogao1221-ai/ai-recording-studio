// End-to-end check in real Chromium with a fake microphone (generates a tone).
// Usage: node e2e/smoke.mjs <baseUrl> <outDir>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const base = process.argv[2] ?? 'http://localhost:4173';
const out = process.argv[3] ?? 'e2e-out';
fs.mkdirSync(out, { recursive: true });

// 6 s stereo 48 kHz test "beat": 110 Hz + 2.5 kHz tones
function wav(sec = 6, sr = 48000) {
  const n = sec * sr, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = 0.3 * Math.sin(2 * Math.PI * 110 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 2500 * i / sr); const q = Math.round(v * 32767); buf.writeInt16LE(q, 44 + i * 4); buf.writeInt16LE(q, 46 + i * 4); }
  return buf;
}
const beatPath = path.join(out, 'beat.wav'); fs.writeFileSync(beatPath, wav());

const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`); };

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base);
await page.getByRole('button', { name: 'Commencer' }).click();
await page.waitForFunction(() => window.__ars?.engine?.isReady, null, { timeout: 15000 });
ok('audio engine + AudioWorklet loaded', true);

// import
await page.locator('input[type=file]').first().setInputFiles(beatPath);
await page.waitForFunction(() => window.__ars.store.getState().project.clips.length === 1, null, { timeout: 15000 });
ok('audio file imported as clip', true);

// playback drives the master meter
await page.evaluate(() => window.__ars.engine.play(0));
await page.waitForTimeout(1200);
const meter = await page.evaluate(() => window.__ars.engine.graph.master.meterValue);
ok('playback reaches master (meter > -30 dBFS)', meter.peakL > 0.03, `peakL=${meter.peakL?.toFixed(3)}`);
await page.screenshot({ path: path.join(out, 'studio-desktop.png') });
await page.evaluate(() => window.__ars.engine.stop());

// a real DSP check through the graph: mute EQ band → compressor GR should report
const gr = await page.evaluate(async () => {
  const { store, engine } = window.__ars;
  const beat = store.getState().project.tracks.find((t) => t.role === 'beat');
  store.update((p) => { const t = p.tracks.find((x) => x.id === beat.id); t.inserts = [{ id: 'fx_test', type: 'compressor', enabled: true, params: { threshold: -40, ratio: 8, attack: 1, release: 50, knee: 0, makeup: 0, autoMakeup: false, mix: 1, scHpf: 0 } }]; });
  await engine.play(0); await new Promise((r) => setTimeout(r, 1000));
  const v = engine.graph.strips.get(beat.id).gr['fx_test']; engine.stop(); return v;
});
ok('compressor worklet reduces gain in the live graph', gr > 10, `GR=${gr?.toFixed(1)} dB`);

// recording with the fake mic
await page.getByRole('button', { name: /Cabine/ }).click();
await page.getByRole('button', { name: /Micro iPhone/ }).click();
await page.waitForFunction(() => !!window.__ars.engine.input, null, { timeout: 10000 });
const label = await page.evaluate(() => window.__ars.engine.input.device.label);
ok('microphone opened, real device label shown', !!label, `label="${label}"`);
const lvl = await page.evaluate(async () => { let m = 0; for (let i = 0; i < 60; i++) { m = Math.max(m, window.__ars.engine.inputLevel.peak); await new Promise((r) => setTimeout(r, 30)); } return m; });
ok('live input level from recorder worklet', lvl > 0.001, `peak=${lvl.toFixed(3)}`);
await page.screenshot({ path: path.join(out, 'cabine-desktop.png'), fullPage: true });
await page.evaluate(() => window.__ars.store.update((p) => { p.preroll = 0.5; }));
await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
await page.waitForFunction(() => window.__ars.store.getState().project.clips.some((c) => c.take === 1), null, { timeout: 10000 });
const take = await page.evaluate(() => {
  const { store, engine } = window.__ars; const c = store.getState().project.clips.find((x) => x.take === 1);
  const b = engine.buffers.get(c.assetId); const d = b.getChannelData(0); let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
  return { dur: c.duration, start: c.start, pk, sr: b.sampleRate };
});
ok('take recorded as real PCM (non-silent, ~2 s)', take.pk > 0.001 && take.dur > 1.2 && take.dur < 3.5, JSON.stringify(take));

// offline export
await page.getByRole('button', { name: /Export/ }).first().click();
await page.getByRole('button', { name: 'Exporter', exact: true }).click();
await page.waitForSelector('text=Télécharger', { timeout: 30000 });
const row = await page.locator('.slot').first().innerText();
ok('offline render + WAV export with measured LUFS', /LUFS/.test(row), row.replace(/\s+/g, ' '));
await page.screenshot({ path: path.join(out, 'export-desktop.png') });

// mastering analysis + closed loop
await page.getByRole('button', { name: /Master/ }).first().click();
await page.getByRole('button', { name: '1. Analyser le mix' }).click();
await page.waitForSelector('text=Proposition de l’ingénieur IA', { timeout: 30000 });
await page.getByRole('button', { name: '2. Appliquer la chaîne proposée' }).click();
await page.getByRole('button', { name: '3. Viser la cible (mesure réelle)' }).click();
await page.waitForSelector('text=Master rendu (mesuré)', { timeout: 60000 });
await page.waitForFunction(() => !document.body.innerText.includes('Itération'), null, { timeout: 60000 });
const lufs = await page.locator('.card:has-text("Master rendu") .metric').first().innerText();
ok('mastering loop reaches target (-14 LUFS ±1)', Math.abs(parseFloat(lufs.split('\n')[1]) + 14) < 1, lufs.replace(/\s+/g, ' '));
await page.screenshot({ path: path.join(out, 'master-desktop.png'), fullPage: true });

await page.getByRole('button', { name: /Console/ }).click();
await page.locator('.slot').first().click();
await page.screenshot({ path: path.join(out, 'console-desktop.png') });

// iPhone layout
const ip = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
const mp = await ip.newPage();
await mp.goto(base);
await mp.getByRole('button', { name: 'Commencer' }).click();
// touch: swipe moves the playhead, tap selects a track
await mp.locator('input[type=file]').first().setInputFiles(beatPath);
await mp.waitForFunction(() => window.__ars.store.getState().project.clips.length >= 1, null, { timeout: 15000 });
const touch = await mp.evaluate(async () => {
  const cv = document.querySelector('.timeline canvas'); const r = cv.getBoundingClientRect();
  const fire = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: true }));
  const { engine, store } = window.__ars;
  engine.seek(2);
  fire('pointerdown', 200, 60); for (let i = 1; i <= 10; i++) fire('pointermove', 200 - i * 12, 60); fire('pointerup', 80, 60);
  const afterSwipe = engine.getPosition();
  const row = 1; fire('pointerdown', 150, 28 + row * 72 + 30); fire('pointerup', 150, 28 + row * 72 + 30);
  await new Promise((r) => setTimeout(r, 50));
  const s = store.getState(); const t = s.project.tracks[row];
  return { afterSwipe, selected: s.ui.selectedTrack === t.id, armed: t.armed };
});
ok('touch swipe moves the playhead forward', touch.afterSwipe > 2.5, `pos=${touch.afterSwipe.toFixed(2)}`);
ok('touch tap selects and arms the track', touch.selected && touch.armed);
await mp.screenshot({ path: path.join(out, 'studio-iphone.png') });
await mp.getByRole('button', { name: /Cabine/ }).click();
await mp.waitForTimeout(500);
await mp.screenshot({ path: path.join(out, 'cabine-iphone.png'), fullPage: true });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok('iPhone layout has no horizontal page scroll', !overflow);

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.pass) ? 0 : 1);
