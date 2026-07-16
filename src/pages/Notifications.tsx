import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Bell, Settings } from 'lucide-react'
import { useNotifications, type AppNotification } from '@/contexts/NotificationsContext'

export default function Notifications() {
  const navigate = useNavigate()
  const { notifications, unreadCount, markRead, markAllRead, refreshNotifications } = useNotifications()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void refreshNotifications().finally(() => setLoading(false))
  }, [refreshNotifications])

  const handleNotificationClick = (n: AppNotification) => {
    if (!n.read_at) void markRead(n.id)
    if (n.link) navigate(n.link)
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl" data-testid="notifications-page">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 mb-6 font-medium"
        data-testid="notifications-back"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </Link>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-2">
          <Bell className="w-5 h-5 text-gray-400" />
          <h1 className="text-xl font-semibold text-white">Notifications</h1>
          {unreadCount > 0 && (
            <span className="text-xs font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-full">
              {unreadCount} unread
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="text-sm text-gray-400 hover:text-accent shrink-0"
            data-testid="notifications-mark-all-read"
          >
            Mark all read
          </button>
        )}
      </div>

      <Link
        to="/profile?tab=notifications"
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 mb-4"
        data-testid="notifications-settings-link"
      >
        <Settings className="w-4 h-4" />
        Notification settings
      </Link>

      {loading ? (
        <p className="text-sm text-gray-500" data-testid="notifications-loading">
          Loading…
        </p>
      ) : notifications.length === 0 ? (
        <div
          className="rounded-lg border border-border bg-surface-elevated p-8 text-center"
          data-testid="notifications-empty"
        >
          <p className="text-sm text-gray-400">No notifications yet.</p>
          <p className="text-xs text-gray-500 mt-1">You&apos;ll see assignments and mentions here.</p>
        </div>
      ) : (
        <ul className="rounded-lg border border-border bg-surface-elevated overflow-hidden divide-y divide-border">
          {notifications.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => handleNotificationClick(n)}
                className={`w-full text-left px-4 py-3 hover:bg-surface-muted/50 transition-colors ${!n.read_at ? 'bg-accent/5' : ''}`}
                data-testid={`notification-item-${n.id}`}
              >
                <p className={`text-sm ${!n.read_at ? 'text-white font-medium' : 'text-gray-300'}`}>{n.title}</p>
                {n.body && <p className="text-xs text-gray-500 mt-0.5">{n.body}</p>}
                <p className="text-[10px] text-gray-600 mt-1">{new Date(n.created_at).toLocaleString()}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
