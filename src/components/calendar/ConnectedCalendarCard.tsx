import { useState } from 'react'
import { Check, RefreshCw, Unlink } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import { updateCalendarConnectionLabel } from '@/lib/calendarSync'
import {
  connectionAccountLabel,
  connectionEmailSecondary,
  connectionStatusLabel,
  formatLastSynced,
} from '@/lib/calendarDisplay'
import type { CalendarConnection } from '@/types/calendar'

function ConnectionColorDot({ color, className = 'w-2 h-2' }: { color: string; className?: string }) {
  return (
    <span
      className={`${className} rounded-full shrink-0`}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

export default function ConnectedCalendarCard({
  conn,
  accent,
  syncBusy,
  disconnectBusy,
  canEditLabel,
  canSync,
  canDisconnect,
  onSync,
  onDisconnect,
  onLabelSaved,
}: {
  conn: CalendarConnection
  accent: string
  syncBusy: boolean
  disconnectBusy: boolean
  canEditLabel: boolean
  canSync: boolean
  canDisconnect: boolean
  onSync: () => void
  onDisconnect: (label: string) => void
  onLabelSaved: () => Promise<void>
}) {
  const { currentOrg } = useOrg()
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelMessage, setLabelMessage] = useState<string | null>(null)

  const label = connectionAccountLabel(conn)
  const emailSecondary = connectionEmailSecondary(conn)

  const startEdit = () => {
    setLabelDraft(label)
    setLabelMessage(null)
    setEditingLabel(true)
  }

  const cancelEdit = () => {
    setEditingLabel(false)
    setLabelDraft('')
    setLabelMessage(null)
  }

  const saveLabel = async () => {
    if (!currentOrg?.id) return
    setLabelBusy(true)
    setLabelMessage(null)
    try {
      await updateCalendarConnectionLabel(currentOrg.id, conn.id, labelDraft)
      setEditingLabel(false)
      setLabelMessage('Nickname saved')
      await onLabelSaved()
    } catch (err) {
      setLabelMessage((err as Error).message)
    } finally {
      setLabelBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface-muted/40 p-3">
      {editingLabel ? (
        <div className="space-y-2">
          <input
            type="text"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            disabled={labelBusy}
            placeholder="Calendar nickname"
            className="w-full h-9 rounded-lg border border-border bg-surface-muted px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveLabel()
              if (e.key === 'Escape') cancelEdit()
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void saveLabel()}
              disabled={labelBusy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              {labelBusy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={labelBusy}
              className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-gray-300 hover:bg-surface-muted disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <ConnectionColorDot color={accent} className="w-2 h-2 mt-1.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white truncate">{label}</p>
              {emailSecondary && (
                <p className="text-xs text-gray-500 truncate mt-0.5">{emailSecondary}</p>
              )}
            </div>
          </div>
          {canEditLabel && (
            <button
              type="button"
              onClick={startEdit}
              className="text-xs text-accent hover:underline"
            >
              Edit nickname
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-2">
        {connectionStatusLabel(conn.status)} · Last synced: {formatLastSynced(conn.last_synced_at)}
      </p>
      {conn.sync_error && (
        <p className="text-xs text-red-400 mt-0.5 truncate">{conn.sync_error}</p>
      )}
      {labelMessage && (
        <p className={`text-xs mt-1 ${labelMessage.includes('saved') ? 'text-green-400' : 'text-red-400'}`}>
          {labelMessage}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        {canSync && (
          <button
            type="button"
            onClick={onSync}
            disabled={syncBusy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncBusy ? 'animate-spin' : ''}`} />
            {syncBusy ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {canDisconnect && (
          <button
            type="button"
            onClick={() => onDisconnect(label)}
            disabled={disconnectBusy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted disabled:opacity-50"
          >
            <Unlink className="w-4 h-4" />
            {disconnectBusy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
      </div>
    </li>
  )
}
