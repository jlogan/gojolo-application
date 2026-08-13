import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Link2,
  RefreshCw,
  Unlink,
  Users,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import {
  disconnectGoogleCalendar,
  fetchCalendarSyncStatus,
  startGoogleCalendarConnect,
  syncGoogleCalendar,
} from '@/lib/calendarSync'
import { usePermission } from '@/lib/usePermission'
import {
  connectionAccountLabel,
  connectionFilterLabel,
  connectionStatusLabel,
  displayEventLocation,
  displayEventTitle,
  eventOwnerLabel,
  formatLastSynced,
  getConnectionChipActiveStyles,
  getConnectionColor,
  getConnectionEventCardStyles,
  memberLabel,
} from '@/lib/calendarDisplay'
import type {
  CalendarConnection,
  CalendarEvent,
  CalendarTeamMember,
} from '@/types/calendar'

type ViewMode = 'week' | 'month'

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function startOfWeek(date: Date): Date {
  const d = startOfDay(date)
  const day = d.getDay()
  d.setDate(d.getDate() - day)
  return d
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  )
}

function formatDayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function formatEventTime(event: CalendarEvent): string {
  if (event.all_day) return 'All day'
  const start = new Date(event.starts_at)
  const end = new Date(event.ends_at)
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  return `${start.toLocaleTimeString(undefined, opts)} – ${end.toLocaleTimeString(undefined, opts)}`
}

function ConnectionColorDot({ connectionId, className = 'w-2 h-2' }: { connectionId: string; className?: string }) {
  return (
    <span
      className={`${className} rounded-full shrink-0`}
      style={{ backgroundColor: getConnectionColor(connectionId) }}
      aria-hidden
    />
  )
}

function CalendarEventCard({
  event,
  owner,
  conn,
  viewerUserId,
}: {
  event: CalendarEvent
  owner: CalendarTeamMember | undefined
  conn: CalendarConnection | undefined
  viewerUserId: string | undefined
}) {
  const title = displayEventTitle(event, viewerUserId)
  const location = displayEventLocation(event, viewerUserId)
  const colorStyles = getConnectionEventCardStyles(event.connection_id)

  return (
    <li
      className="rounded-md border border-l-[3px] px-2 py-1.5 text-xs"
      style={colorStyles}
    >
      <p className="font-medium text-white truncate">{title}</p>
      <p className="text-gray-400 mt-0.5">{formatEventTime(event)}</p>
      <p className="text-gray-500 truncate mt-0.5">{eventOwnerLabel(owner, conn)}</p>
      {location && <p className="text-gray-500 truncate mt-0.5">{location}</p>}
    </li>
  )
}

function CalendarDayCard({
  day,
  dayEvents,
  viewerUserId,
  membersById,
  connectionsById,
}: {
  day: Date
  dayEvents: CalendarEvent[]
  viewerUserId: string | undefined
  membersById: Map<string, CalendarTeamMember>
  connectionsById: Map<string, CalendarConnection>
}) {
  const isToday = sameDay(day, new Date())

  return (
    <div
      className={`rounded-lg border min-h-[140px] ${
        isToday ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface-muted/20'
      }`}
    >
      <div className={`px-2 py-2 text-xs font-medium border-b border-border ${isToday ? 'text-accent' : 'text-gray-400'}`}>
        {formatDayLabel(day)}
      </div>
      <ul className="p-2 space-y-1.5">
        {dayEvents.length === 0 ? (
          <li className="text-xs text-gray-500 px-1">No events</li>
        ) : (
          dayEvents.map((event) => (
            <CalendarEventCard
              key={event.id}
              event={event}
              owner={membersById.get(event.user_id)}
              conn={connectionsById.get(event.connection_id)}
              viewerUserId={viewerUserId}
            />
          ))
        )}
      </ul>
    </div>
  )
}

export default function CalendarPage() {
  const { user } = useAuth()
  const { currentOrg, isOrgAdmin } = useOrg()
  const canView = usePermission(currentOrg?.id, 'calendar.view')
  const canConnect = usePermission(currentOrg?.id, 'calendar.connect')
  const [searchParams, setSearchParams] = useSearchParams()

  const [viewMode, setViewMode] = useState<ViewMode>('week')
  const [anchorDate, setAnchorDate] = useState(() => startOfDay(new Date()))
  const [teamMembers, setTeamMembers] = useState<CalendarTeamMember[]>([])
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(new Set())
  const [connections, setConnections] = useState<CalendarConnection[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [syncBusyIds, setSyncBusyIds] = useState<Set<string>>(new Set())
  const [disconnectBusyIds, setDisconnectBusyIds] = useState<Set<string>>(new Set())
  const [connectMessage, setConnectMessage] = useState<string | null>(null)

  const range = useMemo(() => {
    if (viewMode === 'week') {
      const start = startOfWeek(anchorDate)
      const end = addDays(start, 7)
      return { start, end, days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) }
    }
    const start = startOfMonth(anchorDate)
    const end = addDays(endOfMonth(anchorDate), 1)
    const daysInMonth = endOfMonth(anchorDate).getDate()
    const days = Array.from({ length: daysInMonth }, (_, i) => new Date(start.getFullYear(), start.getMonth(), i + 1))
    return { start, end, days }
  }, [anchorDate, viewMode])

  const loadData = useCallback(async () => {
    if (!currentOrg?.id || canView !== true) return
    setLoading(true)

    const rangeStart = range.start.toISOString()
    const rangeEnd = range.end.toISOString()

    const [membersRes, connectionsRes, eventsRes] = await Promise.all([
      supabase.rpc('org_users_with_permission', {
        p_org_id: currentOrg.id,
        p_permission: 'calendar.view',
      }),
      supabase
        .from('calendar_connections')
        .select('*')
        .eq('org_id', currentOrg.id)
        .order('updated_at', { ascending: false }),
      supabase
        .from('calendar_events')
        .select('*')
        .eq('org_id', currentOrg.id)
        .gte('starts_at', rangeStart)
        .lt('starts_at', rangeEnd)
        .neq('status', 'cancelled')
        .order('starts_at', { ascending: true }),
    ])

    const members = (membersRes.data ?? []) as CalendarTeamMember[]
    const loadedConnections = (connectionsRes.data ?? []) as CalendarConnection[]
    setTeamMembers(members)
    setConnections(loadedConnections)
    setEvents((eventsRes.data ?? []) as CalendarEvent[])

    setSelectedConnectionIds((prev) => {
      if (prev.size > 0) return prev
      const visible = loadedConnections.filter(
        (c) => c.status === 'connected' || c.status === 'error',
      )
      return new Set(visible.map((c) => c.id))
    })

    setLoading(false)
  }, [canView, currentOrg?.id, range.end, range.start])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!currentOrg?.id || canConnect !== true) return
    fetchCalendarSyncStatus(currentOrg.id)
      .then((status) => setGoogleConfigured(status.ok === true && status.providers?.google === true))
      .catch(() => setGoogleConfigured(false))
  }, [canConnect, currentOrg?.id])

  useEffect(() => {
    const result = searchParams.get('calendar')
    if (!result) return

    if (result === 'connected') {
      setConnectMessage('Google Calendar connected. Events will appear after sync completes.')
      loadData()
    } else if (result === 'error') {
      const message = searchParams.get('message')
      setConnectMessage(message ? `Calendar connect failed: ${decodeURIComponent(message)}` : 'Calendar connect failed.')
    }

    const next = new URLSearchParams(searchParams)
    next.delete('calendar')
    next.delete('message')
    next.delete('provider')
    setSearchParams(next, { replace: true })
  }, [loadData, searchParams, setSearchParams])

  const myConnections = useMemo(
    () => connections.filter(
      (c) => c.user_id === user?.id && c.provider === 'google' && c.status !== 'disconnected',
    ),
    [connections, user?.id],
  )

  const filterableConnections = useMemo(
    () => connections.filter((c) => c.status === 'connected' || c.status === 'error'),
    [connections],
  )

  const membersById = useMemo(() => {
    const map = new Map<string, CalendarTeamMember>()
    for (const member of teamMembers) map.set(member.user_id, member)
    return map
  }, [teamMembers])

  const connectionsById = useMemo(() => {
    const map = new Map<string, CalendarConnection>()
    for (const conn of connections) map.set(conn.id, conn)
    return map
  }, [connections])

  const handleConnectGoogle = async () => {
    if (!currentOrg?.id) return
    setConnectBusy(true)
    setConnectMessage(null)
    try {
      const authUrl = await startGoogleCalendarConnect(currentOrg.id)
      window.location.href = authUrl
    } catch (err) {
      setConnectMessage((err as Error).message)
      setConnectBusy(false)
    }
  }

  const handleSyncGoogle = async (connectionId: string) => {
    if (!currentOrg?.id) return
    setSyncBusyIds((prev) => new Set(prev).add(connectionId))
    setConnectMessage(null)
    try {
      const result = await syncGoogleCalendar(currentOrg.id, connectionId)
      setConnectMessage(result.message ?? `Synced ${result.synced ?? 0} events`)
      await loadData()
    } catch (err) {
      setConnectMessage((err as Error).message)
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
    setConnectMessage(null)
    try {
      const result = await disconnectGoogleCalendar(currentOrg.id, connectionId)
      setConnectMessage(result.message ?? 'Calendar disconnected')
      setSelectedConnectionIds((prev) => {
        const next = new Set(prev)
        next.delete(connectionId)
        return next
      })
      await loadData()
    } catch (err) {
      setConnectMessage((err as Error).message)
    } finally {
      setDisconnectBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(connectionId)
        return next
      })
    }
  }

  const filteredEvents = useMemo(
    () => events.filter((e) => selectedConnectionIds.has(e.connection_id)),
    [events, selectedConnectionIds],
  )

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const day of range.days) {
      map.set(day.toDateString(), [])
    }
    for (const event of filteredEvents) {
      const eventDay = startOfDay(new Date(event.starts_at))
      const key = eventDay.toDateString()
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(event)
    }
    return map
  }, [filteredEvents, range.days])

  const connectionsByUser = useMemo(() => {
    const map = new Map<string, CalendarConnection[]>()
    for (const conn of connections) {
      const list = map.get(conn.user_id) ?? []
      list.push(conn)
      map.set(conn.user_id, list)
    }
    return map
  }, [connections])

  const toggleConnection = (connectionId: string) => {
    setSelectedConnectionIds((prev) => {
      const next = new Set(prev)
      if (next.has(connectionId)) next.delete(connectionId)
      else next.add(connectionId)
      return next
    })
  }

  const shiftRange = (direction: -1 | 1) => {
    setAnchorDate((prev) => {
      if (viewMode === 'week') return addDays(prev, direction * 7)
      return new Date(prev.getFullYear(), prev.getMonth() + direction, 1)
    })
  }

  if (canView === null) {
    return (
      <div className="p-4 md:p-6 text-sm text-gray-400" data-testid="calendar-page">
        Loading…
      </div>
    )
  }

  if (canView === false) {
    return (
      <div className="p-4 md:p-6" data-testid="calendar-page">
        <h1 className="text-xl font-semibold text-white mb-2">Team Calendar</h1>
        <p className="text-gray-400 text-sm">You do not have permission to view the team calendar.</p>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6" data-testid="calendar-page">
      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl font-semibold text-white flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-accent" />
                Team Calendar
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                Read-only view of connected team calendars. For now, only Jay and Chris should connect their Google accounts.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-surface-muted p-1">
                <button
                  type="button"
                  onClick={() => setViewMode('week')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    viewMode === 'week' ? 'bg-surface-elevated text-white shadow' : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  Week
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('month')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    viewMode === 'month' ? 'bg-surface-elevated text-white shadow' : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  Month
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button
              type="button"
              onClick={() => setAnchorDate(startOfDay(new Date()))}
              className="px-3 py-1.5 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => shiftRange(-1)}
              className="p-2 rounded-lg border border-border text-gray-300 hover:bg-surface-muted"
              aria-label="Previous"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => shiftRange(1)}
              className="p-2 rounded-lg border border-border text-gray-300 hover:bg-surface-muted"
              aria-label="Next"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-white px-2">
              {viewMode === 'week'
                ? `${formatDayLabel(range.days[0])} – ${formatDayLabel(range.days[6])}`
                : formatMonthLabel(anchorDate)}
            </span>
          </div>

          <div className="rounded-lg border border-border bg-surface-muted/30 p-3 mb-4">
            <div className="flex items-center gap-2 text-sm text-gray-300 mb-2">
              <Users className="w-4 h-4" />
              <span className="font-medium">Calendars</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {filterableConnections.length === 0 ? (
                <span className="text-sm text-gray-500">No connected calendars yet.</span>
              ) : (
                filterableConnections.map((conn) => {
                  const member = membersById.get(conn.user_id)
                  const active = selectedConnectionIds.has(conn.id)
                  const label = member ? connectionFilterLabel(member, conn) : connectionAccountLabel(conn)
                  return (
                    <button
                      key={conn.id}
                      type="button"
                      onClick={() => toggleConnection(conn.id)}
                      style={active ? getConnectionChipActiveStyles(conn.id) : undefined}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        active
                          ? 'text-white'
                          : 'border-border text-gray-400 hover:text-gray-200 hover:bg-surface-muted'
                      }`}
                    >
                      <ConnectionColorDot connectionId={conn.id} />
                      {label}
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-gray-400">Loading calendar…</div>
          ) : (
            <div
              className="grid grid-cols-1 md:grid-cols-7 gap-2"
              data-testid={viewMode === 'week' ? 'calendar-week-grid' : 'calendar-month-grid'}
            >
              {range.days.map((day) => (
                <CalendarDayCard
                  key={day.toISOString()}
                  day={day}
                  dayEvents={eventsByDay.get(day.toDateString()) ?? []}
                  viewerUserId={user?.id}
                  membersById={membersById}
                  connectionsById={connectionsById}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="w-full lg:w-80 shrink-0 space-y-4">
          <section className="rounded-lg border border-border bg-surface-muted/30 p-4">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
              <RefreshCw className="w-4 h-4" />
              Connection status
            </h2>
            {teamMembers.length === 0 ? (
              <p className="text-sm text-gray-500">No team members to show.</p>
            ) : (
              <ul className="space-y-4">
                {teamMembers.map((member) => {
                  const userConnections = (connectionsByUser.get(member.user_id) ?? [])
                    .filter((c) => c.status !== 'disconnected')
                  return (
                    <li key={member.user_id} className="text-sm">
                      <p className="font-medium text-white truncate">{memberLabel(member)}</p>
                      {userConnections.length === 0 ? (
                        <p className="text-gray-500 mt-0.5">Not connected</p>
                      ) : (
                        <ul className="mt-2 space-y-2 border-l border-border pl-3">
                          {userConnections.map((conn) => (
                            <li key={conn.id}>
                              <p className="text-gray-300 truncate flex items-center gap-2">
                                <ConnectionColorDot connectionId={conn.id} />
                                {connectionAccountLabel(conn)}
                              </p>
                              <p className="text-gray-400 mt-0.5">
                                {connectionStatusLabel(conn.status)}
                                {conn.provider ? ` · ${conn.provider}` : ''}
                              </p>
                              <p className="text-xs text-gray-500 mt-0.5">
                                Last synced: {formatLastSynced(conn.last_synced_at)}
                              </p>
                              {conn.sync_error && (
                                <p className="text-xs text-red-400 mt-0.5 truncate">{conn.sync_error}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {(isOrgAdmin || canConnect) && (
            <section className="rounded-lg border border-dashed border-border bg-surface-muted/20 p-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
                <Link2 className="w-4 h-4" />
                Connect Google Calendar
              </h2>
              <p className="text-sm text-gray-400">
                Read-only access. Connect one or more Google accounts. Team members see event titles; Google private events appear as Busy for others.
              </p>
              <p className="text-xs text-gray-500 mt-2">
                For now, only Jay and Chris should connect calendars for this workspace.
              </p>

              {connectMessage && (
                <p className={`text-sm mt-3 ${connectMessage.includes('failed') ? 'text-red-400' : 'text-green-400'}`}>
                  {connectMessage}
                </p>
              )}

              {myConnections.some((c) => c.status === 'connected' || c.status === 'error') && (
                <ul className="mt-4 space-y-3">
                  {myConnections
                    .filter((c) => c.status === 'connected' || c.status === 'error')
                    .map((conn) => {
                      const label = connectionAccountLabel(conn)
                      const syncBusy = syncBusyIds.has(conn.id)
                      const disconnectBusy = disconnectBusyIds.has(conn.id)
                      return (
                        <li
                          key={conn.id}
                          className="rounded-lg border border-border bg-surface-muted/40 p-3"
                        >
                          <p className="text-sm font-medium text-white truncate flex items-center gap-2">
                            <ConnectionColorDot connectionId={conn.id} />
                            {label}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {connectionStatusLabel(conn.status)} · Last synced: {formatLastSynced(conn.last_synced_at)}
                          </p>
                          {conn.sync_error && (
                            <p className="text-xs text-red-400 mt-0.5 truncate">{conn.sync_error}</p>
                          )}
                          <div className="flex flex-wrap gap-2 mt-3">
                            <button
                              type="button"
                              onClick={() => handleSyncGoogle(conn.id)}
                              disabled={syncBusy}
                              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                            >
                              <RefreshCw className={`w-4 h-4 ${syncBusy ? 'animate-spin' : ''}`} />
                              {syncBusy ? 'Syncing…' : 'Sync now'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDisconnectGoogle(conn.id, label)}
                              disabled={disconnectBusy}
                              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted disabled:opacity-50"
                            >
                              <Unlink className="w-4 h-4" />
                              {disconnectBusy ? 'Disconnecting…' : 'Disconnect'}
                            </button>
                          </div>
                        </li>
                      )
                    })}
                </ul>
              )}

              <div className="mt-4 space-y-3">
                {googleConfigured === false && (
                  <div className="text-sm text-gray-400 space-y-2">
                    <p>Google Calendar OAuth is not configured yet. A workspace admin must set Supabase secrets:</p>
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
                <button
                  type="button"
                  onClick={handleConnectGoogle}
                  disabled={connectBusy || googleConfigured !== true}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                  data-testid="connect-google-calendar"
                >
                  <Link2 className="w-4 h-4" />
                  {connectBusy
                    ? 'Redirecting…'
                    : myConnections.some((c) => c.status === 'connected' || c.status === 'error')
                      ? 'Connect another Google account'
                      : 'Connect Google Calendar'}
                </button>
                {myConnections.some((c) => c.status === 'pending') && (
                  <p className="text-xs text-gray-500">
                    {myConnections
                      .filter((c) => c.status === 'pending')
                      .map((c) => `Pending: ${connectionStatusLabel(c.status)}${c.sync_error ? ` — ${c.sync_error}` : ''}`)
                      .join(' · ')}
                  </p>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
