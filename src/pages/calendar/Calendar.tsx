import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  RefreshCw,
  Unlink,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import {
  disconnectGoogleCalendar,
  fetchCalendarSyncStatus,
  startGoogleCalendarConnect,
  syncGoogleCalendar,
  updateCalendarConnectionLabel,
} from '@/lib/calendarSync'
import { usePermission } from '@/lib/usePermission'
import {
  buildConnectionColorMap,
  connectionAccountLabel,
  connectionEmailSecondary,
  connectionFilterLabel,
  connectionStatusLabel,
  displayEventDescription,
  displayEventLocation,
  displayEventTitle,
  eventOwnerLabel,
  formatEventStartTime,
  formatEventTimeRange,
  formatLastSynced,
  getConnectionChipActiveStyles,
  getConnectionColorFromMap,
  getConnectionEventCardStyles,
  type ConnectionColorMap,
} from '@/lib/calendarDisplay'
import {
  addCalendarDays,
  CALENDAR_TIMEZONE_LABEL,
  calendarDayKeyFromDate,
  endOfCalendarMonth,
  eventCalendarDayKey,
  formatCalendarDayHeading,
  formatCalendarDayLabel,
  formatCalendarMonthLabel,
  nowInCalendarTz,
  sameCalendarDay,
  startOfCalendarDay,
  startOfCalendarMonth,
  startOfCalendarWeek,
  calendarDaysInMonth,
} from '@/lib/calendarTimezone'
import type {
  CalendarConnection,
  CalendarEvent,
  CalendarTeamMember,
} from '@/types/calendar'

type ViewMode = 'day' | 'week' | 'month'

function ConnectionColorDot({ color, className = 'w-2 h-2' }: { color: string; className?: string }) {
  return (
    <span
      className={`${className} rounded-full shrink-0`}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

function CalendarEventDetailModal({
  event,
  owner,
  conn,
  viewerUserId,
  connectionColor,
  onClose,
}: {
  event: CalendarEvent
  owner: CalendarTeamMember | undefined
  conn: CalendarConnection | undefined
  viewerUserId: string | undefined
  connectionColor: string
  onClose: () => void
}) {
  const title = displayEventTitle(event, viewerUserId)
  const location = displayEventLocation(event, viewerUserId)
  const description = displayEventDescription(event, viewerUserId)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-event-detail-title"
      data-testid="calendar-event-detail-modal"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-2 min-w-0">
            <ConnectionColorDot color={connectionColor} className="w-2.5 h-2.5 mt-1.5" />
            <div className="min-w-0">
              <h2 id="calendar-event-detail-title" className="text-lg font-semibold text-white break-words">
                {title}
              </h2>
              <p className="text-sm text-gray-400 mt-0.5">{formatEventTimeRange(event)}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-surface-muted shrink-0"
            aria-label="Close event details"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-gray-500">Calendar</dt>
            <dd className="text-gray-200">{eventOwnerLabel(owner, conn)}</dd>
          </div>
          {location && (
            <div>
              <dt className="text-gray-500">Location</dt>
              <dd className="text-gray-200 break-words">{location}</dd>
            </div>
          )}
          {description && (
            <div>
              <dt className="text-gray-500">Description</dt>
              <dd className="text-gray-200 whitespace-pre-wrap break-words">{description}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

function CalendarEventCard({
  event,
  owner,
  conn,
  viewerUserId,
  connectionColor,
  variant,
  onSelect,
}: {
  event: CalendarEvent
  owner: CalendarTeamMember | undefined
  conn: CalendarConnection | undefined
  viewerUserId: string | undefined
  connectionColor: string
  variant: 'compact' | 'day'
  onSelect: (event: CalendarEvent) => void
}) {
  const title = displayEventTitle(event, viewerUserId)
  const location = displayEventLocation(event, viewerUserId)
  const colorStyles = getConnectionEventCardStyles(connectionColor)

  if (variant === 'compact') {
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(event)}
          className="w-full text-left rounded-md border border-l-[3px] px-2 py-1 text-xs hover:brightness-110 transition-[filter]"
          style={colorStyles}
        >
          <p className="text-gray-400 truncate">{formatEventStartTime(event)}</p>
          <p className="font-medium text-white truncate">{title}</p>
        </button>
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(event)}
        className="w-full text-left rounded-md border border-l-[3px] px-2 py-1.5 text-xs hover:brightness-110 transition-[filter]"
        style={colorStyles}
      >
        <p className="font-medium text-white truncate">{title}</p>
        <p className="text-gray-400 mt-0.5">{formatEventTimeRange(event)}</p>
        <p className="text-gray-500 truncate mt-0.5">{eventOwnerLabel(owner, conn)}</p>
        {location && <p className="text-gray-500 truncate mt-0.5">{location}</p>}
      </button>
    </li>
  )
}

function CalendarDayCard({
  day,
  dayEvents,
  viewerUserId,
  membersById,
  connectionsById,
  connectionColorMap,
  variant,
  onSelectEvent,
  showDayHeader = true,
}: {
  day: Date
  dayEvents: CalendarEvent[]
  viewerUserId: string | undefined
  membersById: Map<string, CalendarTeamMember>
  connectionsById: Map<string, CalendarConnection>
  connectionColorMap: ConnectionColorMap
  variant: 'compact' | 'day'
  onSelectEvent: (event: CalendarEvent) => void
  showDayHeader?: boolean
}) {
  const isToday = sameCalendarDay(day, new Date())

  return (
    <div
      className={`rounded-lg border min-h-[140px] ${
        isToday ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface-muted/20'
      }`}
    >
      {showDayHeader && (
        <div className={`px-2 py-2 text-xs font-medium border-b border-border ${isToday ? 'text-accent' : 'text-gray-400'}`}>
          {formatCalendarDayLabel(day)}
        </div>
      )}
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
              connectionColor={getConnectionColorFromMap(event.connection_id, connectionColorMap)}
              variant={variant}
              onSelect={onSelectEvent}
            />
          ))
        )}
      </ul>
    </div>
  )
}

function ConnectedCalendarCard({
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

export default function CalendarPage() {
  const { user } = useAuth()
  const { currentOrg, isOrgAdmin } = useOrg()
  const canView = usePermission(currentOrg?.id, 'calendar.view')
  const canConnect = usePermission(currentOrg?.id, 'calendar.connect')
  const canManage = usePermission(currentOrg?.id, 'calendar.manage')
  const [searchParams, setSearchParams] = useSearchParams()

  const [viewMode, setViewMode] = useState<ViewMode>('week')
  const [anchorDate, setAnchorDate] = useState(() => nowInCalendarTz())
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
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
    if (viewMode === 'day') {
      const start = startOfCalendarDay(anchorDate)
      const end = addCalendarDays(start, 1)
      return { start, end, days: [start] }
    }
    if (viewMode === 'week') {
      const start = startOfCalendarWeek(anchorDate)
      const end = addCalendarDays(start, 7)
      return { start, end, days: Array.from({ length: 7 }, (_, i) => addCalendarDays(start, i)) }
    }
    const start = startOfCalendarMonth(anchorDate)
    const end = addCalendarDays(endOfCalendarMonth(anchorDate), 1)
    const days = calendarDaysInMonth(anchorDate)
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

  const canSyncConnection = useCallback((conn: CalendarConnection) => {
    const isOwner = conn.user_id === user?.id
    if (isOwner && canConnect === true) return true
    return isOrgAdmin || canManage === true
  }, [canConnect, canManage, isOrgAdmin, user?.id])

  const canDisconnectConnection = useCallback((conn: CalendarConnection) => {
    return conn.user_id === user?.id && canConnect === true
  }, [canConnect, user?.id])

  const canEditConnectionLabel = useCallback((conn: CalendarConnection) => {
    const isOwner = conn.user_id === user?.id
    if (isOwner && canConnect === true) return true
    return isOrgAdmin || canManage === true
  }, [canConnect, canManage, isOrgAdmin, user?.id])

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

  const connectionColorMap = useMemo(
    () => buildConnectionColorMap(
      connections.filter((c) => c.status !== 'disconnected').map((c) => c.id),
    ),
    [connections],
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
      map.set(calendarDayKeyFromDate(day), [])
    }
    for (const event of filteredEvents) {
      const key = eventCalendarDayKey(event.starts_at, event.all_day)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(event)
    }
    return map
  }, [filteredEvents, range.days])

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
      if (viewMode === 'day') return addCalendarDays(prev, direction)
      if (viewMode === 'week') return addCalendarDays(prev, direction * 7)
      const monthStart = startOfCalendarMonth(prev)
      return startOfCalendarMonth(addCalendarDays(monthStart, direction > 0 ? 32 : -1))
    })
  }

  const goToToday = () => {
    setViewMode('day')
    setAnchorDate(nowInCalendarTz())
  }

  const eventTileVariant = viewMode === 'day' ? 'day' : 'compact'

  const rangeHeading = viewMode === 'day'
    ? formatCalendarDayHeading(anchorDate)
    : viewMode === 'week'
      ? `${formatCalendarDayLabel(range.days[0])} – ${formatCalendarDayLabel(range.days[6])}`
      : formatCalendarMonthLabel(anchorDate)

  const selectedEventDetails = selectedEvent ? {
    event: selectedEvent,
    owner: membersById.get(selectedEvent.user_id),
    conn: connectionsById.get(selectedEvent.connection_id),
    color: getConnectionColorFromMap(selectedEvent.connection_id, connectionColorMap),
  } : null

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
      {selectedEventDetails && (
        <CalendarEventDetailModal
          event={selectedEventDetails.event}
          owner={selectedEventDetails.owner}
          conn={selectedEventDetails.conn}
          viewerUserId={user?.id}
          connectionColor={selectedEventDetails.color}
          onClose={() => setSelectedEvent(null)}
        />
      )}

      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl font-semibold text-white flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-accent" />
                Team Calendar
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-surface-muted p-1">
                <button
                  type="button"
                  onClick={() => setViewMode('day')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    viewMode === 'day' ? 'bg-surface-elevated text-white shadow' : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  Day
                </button>
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

          <div className="flex flex-wrap items-center gap-2 mb-1">
            <button
              type="button"
              onClick={goToToday}
              className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                viewMode === 'day' && sameCalendarDay(anchorDate, new Date())
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border text-gray-300 hover:bg-surface-muted'
              }`}
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
              {rangeHeading}
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-4">{CALENDAR_TIMEZONE_LABEL}</p>

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
                  const chipLabel = member ? connectionFilterLabel(member, conn) : connectionAccountLabel(conn)
                  const accent = getConnectionColorFromMap(conn.id, connectionColorMap)
                  return (
                    <button
                      key={conn.id}
                      type="button"
                      onClick={() => toggleConnection(conn.id)}
                      style={active ? getConnectionChipActiveStyles(accent) : undefined}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        active
                          ? 'text-white'
                          : 'border-border text-gray-400 hover:text-gray-200 hover:bg-surface-muted'
                      }`}
                    >
                      <ConnectionColorDot color={accent} />
                      {chipLabel}
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
              className={
                viewMode === 'day'
                  ? 'max-w-xl'
                  : 'grid grid-cols-1 md:grid-cols-7 gap-2'
              }
              data-testid={
                viewMode === 'day'
                  ? 'calendar-day-grid'
                  : viewMode === 'week'
                    ? 'calendar-week-grid'
                    : 'calendar-month-grid'
              }
            >
              {range.days.map((day) => (
                <CalendarDayCard
                  key={day.toISOString()}
                  day={day}
                  dayEvents={eventsByDay.get(calendarDayKeyFromDate(day)) ?? []}
                  viewerUserId={user?.id}
                  membersById={membersById}
                  connectionsById={connectionsById}
                  connectionColorMap={connectionColorMap}
                  variant={eventTileVariant}
                  onSelectEvent={setSelectedEvent}
                  showDayHeader={viewMode !== 'day'}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="w-full lg:w-80 shrink-0 space-y-4">
          {connectMessage && (
            <p className={`text-sm ${connectMessage.includes('failed') ? 'text-red-400' : 'text-green-400'}`}>
              {connectMessage}
            </p>
          )}

          {filterableConnections.length > 0 && (
            <section className="rounded-lg border border-border bg-surface-muted/20 p-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
                <CalendarDays className="w-4 h-4" />
                Connected calendars
              </h2>
              <ul className="space-y-3">
                {filterableConnections.map((conn) => {
                  const member = membersById.get(conn.user_id)
                  const cardLabel = member ? connectionFilterLabel(member, conn) : connectionAccountLabel(conn)
                  return (
                    <ConnectedCalendarCard
                      key={conn.id}
                      conn={conn}
                      accent={getConnectionColorFromMap(conn.id, connectionColorMap)}
                      syncBusy={syncBusyIds.has(conn.id)}
                      disconnectBusy={disconnectBusyIds.has(conn.id)}
                      canEditLabel={canEditConnectionLabel(conn)}
                      canSync={canSyncConnection(conn)}
                      canDisconnect={canDisconnectConnection(conn)}
                      onSync={() => void handleSyncGoogle(conn.id)}
                      onDisconnect={() => void handleDisconnectGoogle(conn.id, cardLabel)}
                      onLabelSaved={loadData}
                    />
                  )
                })}
              </ul>
            </section>
          )}

          {(isOrgAdmin || canConnect) && (
            <section className="rounded-lg border border-dashed border-border bg-surface-muted/20 p-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
                <Link2 className="w-4 h-4" />
                Connect Google Calendar
              </h2>

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
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
