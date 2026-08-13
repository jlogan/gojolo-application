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
  connectionStatusLabel,
  displayEventLocation,
  displayEventTitle,
  formatLastSynced,
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

function memberLabel(member: CalendarTeamMember): string {
  return member.display_name?.trim() || member.email?.trim() || 'Unknown user'
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
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())
  const [connections, setConnections] = useState<CalendarConnection[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [disconnectBusy, setDisconnectBusy] = useState(false)
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
    setTeamMembers(members)
    setConnections((connectionsRes.data ?? []) as CalendarConnection[])
    setEvents((eventsRes.data ?? []) as CalendarEvent[])

    setSelectedUserIds((prev) => {
      if (prev.size > 0) return prev
      return new Set(members.map((m) => m.user_id))
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

  const myConnection = useMemo(
    () => connections.find((c) => c.user_id === user?.id && c.provider === 'google'),
    [connections, user?.id],
  )

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

  const handleSyncGoogle = async () => {
    if (!currentOrg?.id) return
    setSyncBusy(true)
    setConnectMessage(null)
    try {
      const result = await syncGoogleCalendar(currentOrg.id)
      setConnectMessage(result.message ?? `Synced ${result.synced ?? 0} events`)
      await loadData()
    } catch (err) {
      setConnectMessage((err as Error).message)
    } finally {
      setSyncBusy(false)
    }
  }

  const handleDisconnectGoogle = async () => {
    if (!currentOrg?.id) return
    if (!window.confirm('Disconnect Google Calendar? Synced events for your calendar will be removed.')) return
    setDisconnectBusy(true)
    setConnectMessage(null)
    try {
      const result = await disconnectGoogleCalendar(currentOrg.id)
      setConnectMessage(result.message ?? 'Calendar disconnected')
      await loadData()
    } catch (err) {
      setConnectMessage((err as Error).message)
    } finally {
      setDisconnectBusy(false)
    }
  }

  const filteredEvents = useMemo(
    () => events.filter((e) => selectedUserIds.has(e.user_id)),
    [events, selectedUserIds],
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

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
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
              <p className="text-sm text-gray-400 mt-1">Read-only view of connected team calendars.</p>
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
              <span className="font-medium">People</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {teamMembers.length === 0 ? (
                <span className="text-sm text-gray-500">No team members with calendar access.</span>
              ) : (
                teamMembers.map((member) => {
                  const active = selectedUserIds.has(member.user_id)
                  return (
                    <button
                      key={member.user_id}
                      type="button"
                      onClick={() => toggleUser(member.user_id)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        active
                          ? 'border-accent bg-accent/15 text-white'
                          : 'border-border text-gray-400 hover:text-gray-200 hover:bg-surface-muted'
                      }`}
                    >
                      {memberLabel(member)}
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-gray-400">Loading calendar…</div>
          ) : viewMode === 'week' ? (
            <div className="grid grid-cols-1 md:grid-cols-7 gap-2" data-testid="calendar-week-grid">
              {range.days.map((day) => {
                const dayEvents = eventsByDay.get(day.toDateString()) ?? []
                const isToday = sameDay(day, new Date())
                return (
                  <div
                    key={day.toISOString()}
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
                        dayEvents.map((event) => {
                          const owner = teamMembers.find((m) => m.user_id === event.user_id)
                          const title = displayEventTitle(event, user?.id)
                          const location = displayEventLocation(event, user?.id)
                          return (
                            <li
                              key={event.id}
                              className="rounded-md bg-surface-elevated border border-border px-2 py-1.5 text-xs"
                            >
                              <p className="font-medium text-white truncate">{title}</p>
                              <p className="text-gray-400 mt-0.5">{formatEventTime(event)}</p>
                              <p className="text-gray-500 truncate mt-0.5">{owner ? memberLabel(owner) : 'Unknown'}</p>
                              {location && <p className="text-gray-500 truncate mt-0.5">{location}</p>}
                            </li>
                          )
                        })
                      )}
                    </ul>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border divide-y divide-border overflow-hidden" data-testid="calendar-month-list">
              {range.days.map((day) => {
                const dayEvents = eventsByDay.get(day.toDateString()) ?? []
                const isToday = sameDay(day, new Date())
                return (
                  <div key={day.toISOString()} className={isToday ? 'bg-accent/5' : ''}>
                    <div className={`px-4 py-2 text-sm font-medium border-b border-border ${isToday ? 'text-accent' : 'text-gray-300'}`}>
                      {formatDayLabel(day)}
                    </div>
                    {dayEvents.length === 0 ? (
                      <p className="px-4 py-3 text-sm text-gray-500">No events</p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {dayEvents.map((event) => {
                          const owner = teamMembers.find((m) => m.user_id === event.user_id)
                          const title = displayEventTitle(event, user?.id)
                          return (
                            <li key={event.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-white truncate">{title}</p>
                                <p className="text-xs text-gray-500 truncate">{owner ? memberLabel(owner) : 'Unknown'}</p>
                              </div>
                              <p className="text-xs text-gray-400 shrink-0">{formatEventTime(event)}</p>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )
              })}
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
              <ul className="space-y-3">
                {teamMembers.map((member) => {
                  const userConnections = connectionsByUser.get(member.user_id) ?? []
                  const primary = userConnections[0]
                  return (
                    <li key={member.user_id} className="text-sm">
                      <p className="font-medium text-white truncate">{memberLabel(member)}</p>
                      {primary ? (
                        <>
                          <p className="text-gray-400 mt-0.5">
                            {connectionStatusLabel(primary.status)}
                            {primary.provider ? ` · ${primary.provider}` : ''}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Last synced: {formatLastSynced(primary.last_synced_at)}
                          </p>
                          {primary.sync_error && (
                            <p className="text-xs text-red-400 mt-0.5 truncate">{primary.sync_error}</p>
                          )}
                        </>
                      ) : (
                        <p className="text-gray-500 mt-0.5">Not connected</p>
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
                Read-only access. Team members see event titles; Google private events appear as Busy for others.
              </p>

              {connectMessage && (
                <p className={`text-sm mt-3 ${connectMessage.includes('failed') ? 'text-red-400' : 'text-green-400'}`}>
                  {connectMessage}
                </p>
              )}

              {myConnection?.status === 'connected' ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-gray-300">
                    Connected{myConnection.email ? ` as ${myConnection.email}` : ''}.
                    {' '}Last synced: {formatLastSynced(myConnection.last_synced_at)}.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleSyncGoogle}
                      disabled={syncBusy}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-4 h-4 ${syncBusy ? 'animate-spin' : ''}`} />
                      {syncBusy ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button
                      type="button"
                      onClick={handleDisconnectGoogle}
                      disabled={disconnectBusy}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted disabled:opacity-50"
                    >
                      <Unlink className="w-4 h-4" />
                      {disconnectBusy ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  </div>
                </div>
              ) : (
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
                    {connectBusy ? 'Redirecting…' : 'Connect Google Calendar'}
                  </button>
                  {myConnection && (
                    <p className="text-xs text-gray-500">
                      Status: {connectionStatusLabel(myConnection.status)}
                      {myConnection.sync_error ? ` — ${myConnection.sync_error}` : ''}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
