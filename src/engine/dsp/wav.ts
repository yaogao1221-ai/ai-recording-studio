export type BitDepth = 16 | 24 | 32;

/**
 * Encode planar float channels to a RIFF/WAVE file.
 * 16/24-bit: integer PCM with TPDF dither; 32: IEEE float.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: BitDepth, dither = true): ArrayBuffer {
  const nCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const bytes = bitDepth / 8;
  const dataSize = len * nCh * bytes;
  const isFloat = bitDepth === 32;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, isFloat ? 3 : 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * bytes, true);
  v.setUint16(32, nCh * bytes, true); v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  const maxInt = bitDepth === 16 ? 32767 : 8388607;
  const lsb = 1 / maxInt;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let x = channels[c][i];
      if (isFloat) { v.setFloat32(o, x, true); o += 4; continue; }
      if (dither) x += (Math.random() - Math.random()) * lsb;
      x = x > 1 ? 1 : x < -1 ? -1 : x;
      const q = Math.round(x * maxInt);
      if (bitDepth === 16) { v.setInt16(o, q, true); o += 2; }
      else { v.setUint8(o, q & 0xff); v.setUint8(o + 1, (q >> 8) & 0xff); v.setUint8(o + 2, (q >> 16) & 0xff); o += 3; }
    }
  }
  return buf;
}

/** Minimal WAV decoder (PCM 16/24/32 int, float 32) — used by tests and session import. */
export function decodeWav(buf: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const v = new DataView(buf);
  let o = 12; let fmt = 1, nCh = 2, sr = 44100, bits = 16; let dataOff = -1, dataLen = 0;
  while (o + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') { fmt = v.getUint16(o + 8, true); nCh = v.getUint16(o + 10, true); sr = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true); }
    if (id === 'data') { dataOff = o + 8; dataLen = size; break; }
    o += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('WAV: data chunk not found');
  const bytes = bits / 8; const len = Math.floor(dataLen / (bytes * nCh));
  const ch = Array.from({ length: nCh }, () => new Float32Array(len));
  let p = dataOff;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) {
    let x: number;
    if (fmt === 3) x = v.getFloat32(p, true);
    else if (bits === 16) x = v.getInt16(p, true) / 32768;
    else if (bits === 24) { let q = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (q & 0x800000) q |= ~0xffffff; x = q / 8388608; }
    else x = v.getInt32(p, true) / 2147483648;
    ch[c][i] = x; p += bytes;
  }
  return { sampleRate: sr, channels: ch };
}
