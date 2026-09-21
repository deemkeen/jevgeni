// Mono 16-bit PCM WAV at 16 kHz, box-filter resampled. ~32 kB per second.

export const WAV_RATE = 16000;

export function encodeWav(frames: Float32Array[], inputRate: number): Blob {
  const total = frames.reduce((a, f) => a + f.length, 0);
  const joined = new Float32Array(total);
  let o = 0;
  for (const f of frames) {
    joined.set(f, o);
    o += f.length;
  }
  const ratio = inputRate / WAV_RATE;
  const outLen = Math.floor(joined.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(joined.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += joined[j];
    const v = end > start ? sum / (end - start) : 0;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const str = (off: number, s: string) => [...s].forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, WAV_RATE, true);
  dv.setUint32(28, WAV_RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer], { type: "audio/wav" });
}
