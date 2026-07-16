const SOUND_ENABLED_KEY = 'jolo_profile_notification_sound'
import { buildNotificationWavBytes } from '@/lib/notificationWavBytes'

export const NOTIFICATION_SOUND_URL = '/sounds/notification.wav'

let audio: HTMLAudioElement | null = null
let unlocked = false
let unlockListenersAttached = false
let objectUrl: string | null = null

function getSoundSrc(): string {
  if (!objectUrl) {
    objectUrl = URL.createObjectURL(
      new Blob([buildNotificationWavBytes()], { type: 'audio/wav' }),
    )
  }
  return objectUrl
}

export function isNotificationSoundEnabled(): boolean {
  const stored = localStorage.getItem(SOUND_ENABLED_KEY)
  if (stored === null) return true
  return stored === 'true'
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  localStorage.setItem(SOUND_ENABLED_KEY, enabled ? 'true' : 'false')
}

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(getSoundSrc())
    audio.preload = 'auto'
  }
  return audio
}

export function unlockNotificationAudio(): void {
  if (unlocked) return
  const el = getAudio()
  const prevVolume = el.volume
  el.volume = 0
  void el
    .play()
    .then(() => {
      el.pause()
      el.currentTime = 0
      el.volume = prevVolume
      unlocked = true
    })
    .catch(() => {
      el.volume = prevVolume
    })
}

export function attachNotificationAudioUnlock(): () => void {
  if (unlockListenersAttached) return () => {}
  unlockListenersAttached = true
  const onInteract = () => unlockNotificationAudio()
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  document.addEventListener('pointerdown', onInteract, opts)
  document.addEventListener('keydown', onInteract, opts)
  document.addEventListener('touchstart', onInteract, opts)
  return () => {
    document.removeEventListener('pointerdown', onInteract, opts)
    document.removeEventListener('keydown', onInteract, opts)
    document.removeEventListener('touchstart', onInteract, opts)
    unlockListenersAttached = false
  }
}

export function playNotificationSound(): void {
  if (!isNotificationSoundEnabled()) return
  const el = getAudio()
  el.volume = 1
  el.currentTime = 0
  void el.play().catch(() => {})
}
