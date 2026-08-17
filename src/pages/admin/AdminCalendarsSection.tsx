import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, Link2 } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import {
  disconnectGoogleCalendar,
  fetchCalendarSyncStatus,
  startGoogleCalendarConnect,
  syncGoogleCalendar,
} from '@/lib/calendarSync'
import {
  buildConnectionColorMap,
  connectionAccountLabel,
  getConnectionColorFromMap,
  sortConnectionsByDisplayLabel,
} from '@/lib/calendarDisplay'
import ConnectedCalendarCard from '@/components/calendar/ConnectedCalendarCard'
import type { CalendarConnection } from '@/types/calendar'

export default function AdminCalendarsSection() {
  const { currentOrg, isOrgAdmin } = useOrg()
  const [searchParams, setSearchParams] = useSearchParams()

  const [connections, setConnections] = useState<CalendarConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [syncBusyIds, setSyncBusyIds] = useState<Set<string>>(new Set())
  const [disconnectBusyIds, setDisconnectBusyIds] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<string | null>(null)

  const loadConnections = useCallback(async () => {
    if (!currentOrg?.id) return
    setLoading(true)

    const { data, error } = await supabase
      .from('calendar_connections')
      .select('*')
      .eq('org_id', currentOrg.id)
      .order('updated_at', { ascending: false })

    if (error) {
      setMessage(error.message)
    } else {
      setConnections((data ?? []) as CalendarConnection[])
    }
    setLoading(false)
  }, [currentOrg?.id])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  useEffect(() => {
    if (!currentOrg?.id || !isOrgAdmin) return
    fetchCalendarSyncStatus(currentOrg.id)
      .then((status) => setGoogleConfigured(status.ok === true && status.providers?.google === true))
      .catch(() => setGoogleConfigured(false))
  }, [currentOrg?.id, isOrgAdmin])

  useEffect(() => {
    const result = searchParams.get('calendar')
    if (!result) return

    if (result === 'connected') {
      setMessage('Google Calendar connected. Events will appear after sync completes.')
      void loadConnections()
    } else if (result === 'error') {
      const errorMessage = searchParams.get('message')
      setMessage(
        errorMessage
          ? `Calendar connect failed: ${decodeURIComponent(errorMessage)}`
          : 'Calendar connect failed.',
      )
    }

    const next = new URLSearchParams(searchParams)
    next.delete('calendar')
    next.delete('message')
    next.delete('provider')
    setSearchParams(next, { replace: true })
  }, [loadConnections, searchParams, setSearchParams])

  const manageableConnections = useMemo(
    () => connections.filter((c) => c.status === 'connected' || c.status === 'error'),
    [connections],
  )

  const sortedConnections = useMemo(
    () => sortConnectionsByDisplayLabel(manageableConnections),
    [manageableConnections],
  )

  const connectionColorMap = useMemo(
    () => buildConnectionColorMap(manageableConnections.map((c) => c.id)),
    [manageableConnections],
  )

  const hasConnectedAccount = manageableConnections.some(
    (c) => c.status === 'connected' || c.status === 'error',
  )

  const handleConnectGoogle = async () => {
    if (!currentOrg?.id) return
    setConnectBusy(true)
    setMessage(null)
    try {
      const authUrl = await startGoogleCalendarConnect(currentOrg.id, '/admin')
      window.location.href = authUrl
    } catch (err) {
      setMessage((err as Error).message)
      setConnectBusy(false)
    }
  }

  const handleSyncGoogle = async (connectionId: string) => {
    if (!currentOrg?.id) return
    setSyncBusyIds((prev) => new Set(prev).add(connectionId))
    setMessage(null)
    try {
      const result = await syncGoogleCalendar(currentOrg.id, connectionId)
      setMessage(result.message ?? `Synced ${result.synced ?? 0} events`)
      await loadConnections()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setSyncBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(connectionId)
        return next
      })
    }
  }

  const handleDisconnectGoogle = async (connectionId: string, accountLabel: string) => {
    if (!currentOrg?.id) return
    if (!window.confirm(`Disconnect ${accountLabel}? Synced events for this account will be removed.`)) return
    setDisconnectBusyIds((prev) => new Set(prev).add(connectionId))
    setMessage(null)
    try {
      const result = await disconnectGoogleCalendar(currentOrg.id, connectionId)
      setMessage(result.message ?? 'Calendar disconnected')
      await loadConnections()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setDisconnectBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(connectionId)
        return next
      })
    }
  }

  return (
    <>
      <h2 className="text-xl font-semibold text-white mb-2 flex items-center gap-2">
        <CalendarDays className="w-5 h-5 text-accent" />
        Calendars
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        Connect Google Calendar accounts, manage nicknames, and sync events for this workspace.
      </p>

      {message && (
        <p
          className={`text-sm mb-4 ${
            message.includes('failed') || message.toLowerCase().includes('error')
              ? 'text-red-400'
              : 'text-green-400'
          }`}
        >
          {message}
        </p>
      )}

      {googleConfigured === false && (
        <div className="rounded-lg border border-border bg-surface-muted/30 p-4 mb-4 text-sm text-gray-400 space-y-2">
          <p>Google Calendar OAuth is not configured yet. Set Supabase secrets:</p>
          <ul className="list-disc list-inside text-xs text-gray-500 space-y-1">
            <li><code>GOOGLE_CALENDAR_CLIENT_ID</code> and <code>GOOGLE_CALENDAR_CLIENT_SECRET</code></li>
            <li><code>ENCRYPTION_KEY</code> (64 hex chars — same as IMAP vault)</li>
          </ul>
          <p className="text-xs text-gray-500">
            In Google Cloud Console, add redirect URI:
            {' '}
            <code className="break-all">https://YOUR_PROJECT_REF.supabase.co/functions/v1/calendar-sync?action=callback</code>
          </p>
        </div>
      )}

      <div className="mb-6">
        <button
          type="button"
          onClick={() => void handleConnectGoogle()}
          disabled={connectBusy || googleConfigured !== true}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          data-testid="admin-connect-google-calendar"
        >
          <Link2 className="w-4 h-4" />
          {connectBusy
            ? 'Redirecting…'
            : hasConnectedAccount
              ? 'Connect another Google account'
              : 'Connect Google Calendar'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading connected calendars…</p>
      ) : sortedConnections.length === 0 ? (
        <p className="text-sm text-gray-500">No connected calendars yet.</p>
      ) : (
        <ul className="space-y-3" data-testid="admin-connected-calendars">
          {sortedConnections.map((conn) => (
            <ConnectedCalendarCard
              key={conn.id}
              conn={conn}
              accent={getConnectionColorFromMap(conn.id, connectionColorMap)}
              syncBusy={syncBusyIds.has(conn.id)}
              disconnectBusy={disconnectBusyIds.has(conn.id)}
              canEditLabel={isOrgAdmin}
              canSync={isOrgAdmin}
              canDisconnect={isOrgAdmin}
              onSync={() => void handleSyncGoogle(conn.id)}
              onDisconnect={() => void handleDisconnectGoogle(conn.id, connectionAccountLabel(conn))}
              onLabelSaved={loadConnections}
            />
          ))}
        </ul>
      )}
    </>
  )
}
