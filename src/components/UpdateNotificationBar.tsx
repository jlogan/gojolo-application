import { useCallback, useEffect, useState } from 'react'

type VersionPayload = {
  version?: string
}

const CHECK_INTERVAL_MS = 60_000

export default function UpdateNotificationBar() {
  const [updateAvailable, setUpdateAvailable] = useState(false)

  const checkVersion = useCallback(async () => {
    if (import.meta.env.DEV || updateAvailable) return
    try {
      const res = await fetch('/version.json?ts=' + Date.now(), { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as VersionPayload
      if (data.version && data.version !== __APP_VERSION__) {
        setUpdateAvailable(true)
      }
    } catch {
      // Ignore transient network failures.
    }
  }, [updateAvailable])

  useEffect(() => {
    if (import.meta.env.DEV) return
    void checkVersion()
    const interval = window.setInterval(() => void checkVersion(), CHECK_INTERVAL_MS)
    const onFocus = () => void checkVersion()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkVersion()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [checkVersion])

  if (!updateAvailable) return null

  return (
    <div className="fixed top-0 inset-x-0 z-[70] border-b border-accent/40 bg-surface-elevated/95 backdrop-blur">
      <div className="mx-auto max-w-6xl px-3 py-2 text-xs sm:text-sm flex items-center justify-between gap-3">
        <span className="text-gray-200">A new version is available. Reload to get the latest updates.</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-3 py-1.5 rounded-md bg-accent text-white font-medium hover:opacity-90 shrink-0"
        >
          Reload
        </button>
      </div>
    </div>
  )
}
