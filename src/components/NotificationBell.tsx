import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, X } from 'lucide-react'
import { useNotifications } from '@/contexts/NotificationsContext'

export default function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="relative p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted">
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent text-white text-[9px] font-bold flex items-center justify-center">{unreadCount}</span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-80 bg-surface-elevated border border-border rounded-lg shadow-xl z-50 max-h-96 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
              <h3 className="text-sm font-medium text-white">Notifications</h3>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button type="button" onClick={markAllRead} className="text-[10px] text-gray-400 hover:text-accent">Mark all read</button>
                )}
                <button type="button" onClick={() => setOpen(false)} className="p-1 text-gray-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {notifications.length === 0 ? (
                <p className="p-4 text-sm text-gray-400 text-center">No notifications</p>
              ) : (
                notifications.map(n => (
                  <div key={n.id} className={`px-4 py-3 border-b border-border hover:bg-surface-muted/50 cursor-pointer ${!n.read_at ? 'bg-accent/5' : ''}`}
                    onClick={() => { markRead(n.id); setOpen(false) }}>
                    {n.link ? (
                      <Link to={n.link} className="block">
                        <p className={`text-sm ${!n.read_at ? 'text-white font-medium' : 'text-gray-300'}`}>{n.title}</p>
                        {n.body && <p className="text-xs text-gray-500 mt-0.5">{n.body}</p>}
                        <p className="text-[10px] text-gray-600 mt-1">{new Date(n.created_at).toLocaleString()}</p>
                      </Link>
                    ) : (
                      <>
                        <p className={`text-sm ${!n.read_at ? 'text-white font-medium' : 'text-gray-300'}`}>{n.title}</p>
                        {n.body && <p className="text-xs text-gray-500 mt-0.5">{n.body}</p>}
                        <p className="text-[10px] text-gray-600 mt-1">{new Date(n.created_at).toLocaleString()}</p>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
