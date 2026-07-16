/** Short in-app notification tone (~120ms). */
export function buildNotificationWavBytes(): Uint8Array {
  const sampleRate = 22050
  const duration = 0.12
  const freq = 880
  const numSamples = Math.floor(sampleRate * duration)
  const data = new Uint8Array(numSamples * 2)
  const view = new DataView(data.buffer)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const env =
      Math.min(1, i / (sampleRate * 0.01)) *
      Math.max(0, 1 - (t - duration * 0.4) / (duration * 0.6))
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.35 * env
    view.setInt16(i * 2, Math.max(-32767, Math.min(32767, Math.floor(sample * 32767))), true)
  }
  const header = new Uint8Array(44)
  const h = new DataView(header.buffer)
  header.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  h.setUint32(4, 36 + data.length, true)
  header.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  header.set([0x66, 0x6d, 0x74, 0x20], 12) // fmt
  h.setUint32(16, 16, true)
  h.setUint16(20, 1, true)
  h.setUint16(22, 1, true)
  h.setUint32(24, sampleRate, true)
  h.setUint32(28, sampleRate * 2, true)
  h.setUint16(32, 2, true)
  h.setUint16(34, 16, true)
  header.set([0x64, 0x61, 0x74, 0x61], 36) // data
  h.setUint32(40, data.length, true)
  const out = new Uint8Array(header.length + data.length)
  out.set(header, 0)
  out.set(data, header.length)
  return out
}
