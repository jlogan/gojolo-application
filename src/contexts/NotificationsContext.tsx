import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  attachNotificationAudioUnlock,
  isNotificationSoundEnabled,
  playNotificationSound,
  setNotificationSoundEnabled,
} from '@/lib/notificationSound'

export type AppNotification = {
  id: string
  org_id: string
  type: string
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

type NotificationsContextValue = {
  notifications: AppNotification[]
  unreadCount: number
  soundEnabled: boolean
  setSoundEnabled: (enabled: boolean) => void
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  refreshNotifications: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

const LIST_LIMIT = 20

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [soundEnabled, setSoundEnabledState] = useState(() => isNotificationSoundEnabled())

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setNotificationSoundEnabled(enabled)
    setSoundEnabledState(enabled)
  }, [])

  const refreshNotifications = useCallback(async () => {
    if (!user?.id) {
      setNotifications([])
      return
    }
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT)
    setNotifications((data as AppNotification[]) ?? [])
  }, [user?.id])

  useEffect(() => {
    void refreshNotifications()
  }, [refreshNotifications])

  useEffect(() => attachNotificationAudioUnlock(), [])

  useEffect(() => {
    if (!user?.id) return

    const ch = supabase
      .channel(`notifications:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as AppNotification
          setNotifications((prev) => [row, ...prev.filter((n) => n.id !== row.id)].slice(0, LIST_LIMIT))
          playNotificationSound()
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(ch)
    }
  }, [user?.id])

  const markRead = useCallback(async (id: string) => {
    const readAt = new Date().toISOString()
    await supabase.from('notifications').update({ read_at: readAt }).eq('id', id)
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: readAt } : n)))
  }, [])

  const markAllRead = useCallback(async () => {
    const unread = notifications.filter((n) => !n.read_at)
    if (unread.length === 0) return
    const readAt = new Date().toISOString()
    for (const n of unread) {
      await supabase.from('notifications').update({ read_at: readAt }).eq('id', n.id)
    }
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? readAt })))
  }, [notifications])

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read_at).length,
    [notifications],
  )

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      soundEnabled,
      setSoundEnabled,
      markRead,
      markAllRead,
      refreshNotifications,
    }),
    [notifications, unreadCount, soundEnabled, setSoundEnabled, markRead, markAllRead, refreshNotifications],
  )

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationsProvider')
  }
  return ctx
}
