import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'public', 'sounds', 'notification.wav')

function buildNotificationWav() {
  const sampleRate = 22050
  const duration = 0.12
  const freq = 880
  const numSamples = Math.floor(sampleRate * duration)
  const data = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const env =
      Math.min(1, i / (sampleRate * 0.01)) *
      Math.max(0, 1 - (t - duration * 0.4) / (duration * 0.6))
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.35 * env
    data.writeInt16LE(
      Math.max(-32767, Math.min(32767, Math.floor(sample * 32767))),
      i * 2,
    )
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, buildNotificationWav())
console.log('Wrote', out)
