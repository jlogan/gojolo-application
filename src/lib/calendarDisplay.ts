import { formatCalendarEventStartTime, formatCalendarEventTime } from '@/lib/calendarTimezone'
import type { CalendarConnection, CalendarEvent, CalendarEventVisibility, CalendarTeamMember } from '@/types/calendar'

const CONNECTION_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#eab308',
  '#ef4444',
  '#6366f1',
  '#06b6d4',
] as const

const UNKNOWN_CONNECTION_COLOR = '#6b7280'

export type ConnectionColorMap = ReadonlyMap<string, string>

export type ConnectionColorStyles = {
  accent: string
  background: string
  border: string
}

function hashConnectionId(connectionId: string): number {
  let hash = 0
  for (let i = 0; i < connectionId.length; i++) {
    hash = ((hash << 5) - hash + connectionId.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100
  const lightness = l / 100
  const chroma = saturation * Math.min(lightness, 1 - lightness)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const color = lightness - chroma * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

function assignOverflowColor(connectionId: string, usedColors: Set<string>): string {
  const hash = hashConnectionId(connectionId)
  for (let attempt = 0; attempt < 720; attempt++) {
    const hue = (hash + attempt * 41) % 360
    const saturation = 62 + (attempt % 4) * 8
    const lightness = 48 + (Math.floor(attempt / 4) % 5) * 6
    const hex = hslToHex(hue, saturation, lightness)
    if (!usedColors.has(hex)) return hex
  }
  return hslToHex(hash % 360, 70, 52)
}

function assignColorForConnection(connectionId: string, usedColors: Set<string>): string {
  const paletteLength = CONNECTION_COLORS.length
  const preferredIndex = hashConnectionId(connectionId) % paletteLength

  for (let offset = 0; offset < paletteLength; offset++) {
    const color = CONNECTION_COLORS[(preferredIndex + offset) % paletteLength]
    if (!usedColors.has(color)) return color
  }

  return assignOverflowColor(connectionId, usedColors)
}

/** Stable unique accent colors for a set of calendar connection IDs. */
export function buildConnectionColorMap(connectionIds: Iterable<string>): ConnectionColorMap {
  const uniqueIds = [...new Set(connectionIds)].sort()
  const map = new Map<string, string>()
  const usedColors = new Set<string>()

  for (const connectionId of uniqueIds) {
    const color = assignColorForConnection(connectionId, usedColors)
    map.set(connectionId, color)
    usedColors.add(color)
  }

  return map
}

export function getConnectionColorFromMap(
  connectionId: string,
  colorMap: ConnectionColorMap,
): string {
  return colorMap.get(connectionId) ?? UNKNOWN_CONNECTION_COLOR
}

export function getConnectionColorStyles(accent: string): ConnectionColorStyles {
  return {
    accent,
    background: hexToRgba(accent, 0.1),
    border: hexToRgba(accent, 0.28),
  }
}

export function getConnectionChipActiveStyles(accent: string): {
  borderColor: string
  backgroundColor: string
} {
  return {
    borderColor: accent,
    backgroundColor: hexToRgba(accent, 0.18),
  }
}

export function getConnectionEventCardStyles(accent: string): {
  borderLeftColor: string
  borderColor: string
  backgroundColor: string
} {
  const { background, border } = getConnectionColorStyles(accent)
  return {
    borderLeftColor: accent,
    borderColor: border,
    backgroundColor: background,
  }
}

export function isEventMasked(
  visibility: CalendarEventVisibility,
  eventUserId: string,
  viewerUserId: string | undefined,
): boolean {
  if (!viewerUserId || eventUserId === viewerUserId) return false
  return visibility === 'private' || visibility === 'busy_only'
}

export function displayEventTitle(
  event: Pick<CalendarEvent, 'title' | 'visibility' | 'user_id'>,
  viewerUserId: string | undefined,
): string {
  if (isEventMasked(event.visibility, event.user_id, viewerUserId)) return 'Busy'
  return event.title?.trim() || '(No title)'
}

export function displayEventDescription(
  event: Pick<CalendarEvent, 'description' | 'visibility' | 'user_id'>,
  viewerUserId: string | undefined,
): string | null {
  if (isEventMasked(event.visibility, event.user_id, viewerUserId)) return null
  return event.description
}

export function displayEventLocation(
  event: Pick<CalendarEvent, 'location' | 'visibility' | 'user_id'>,
  viewerUserId: string | undefined,
): string | null {
  if (isEventMasked(event.visibility, event.user_id, viewerUserId)) return null
  return event.location
}

export function canViewEventRichDetails(
  event: Pick<CalendarEvent, 'visibility' | 'user_id'>,
  viewerUserId: string | undefined,
): boolean {
  return !isEventMasked(event.visibility, event.user_id, viewerUserId)
}

export function displayEventMeetingUrl(
  event: Pick<CalendarEvent, 'meeting_url' | 'visibility' | 'user_id'>,
  viewerUserId: string | undefined,
): string | null {
  if (!canViewEventRichDetails(event, viewerUserId)) return null
  const url = event.meeting_url?.trim()
  return url || null
}

export function displayEventHtmlLink(
  event: Pick<CalendarEvent, 'html_link' | 'visibility' | 'user_id'>,
  viewerUserId: string | undefined,
): string | null {
  if (!canViewEventRichDetails(event, viewerUserId)) return null
  const url = event.html_link?.trim()
  return url || null
}

export function memberLabel(member: Pick<CalendarTeamMember, 'display_name' | 'email'>): string {
  return member.display_name?.trim() || member.email?.trim() || 'Unknown user'
}

export function connectionAccountLabel(
  conn: Pick<CalendarConnection, 'account_label' | 'email' | 'provider'>,
): string {
  return conn.account_label?.trim() || conn.email?.trim() || conn.provider
}

/** Sort connections by displayed nickname/account label; tie-break by email then id. */
export function sortConnectionsByDisplayLabel(
  connections: CalendarConnection[],
  labelFn: (conn: CalendarConnection) => string = connectionAccountLabel,
): CalendarConnection[] {
  return [...connections].sort((a, b) => {
    const labelCmp = labelFn(a).localeCompare(labelFn(b), undefined, { sensitivity: 'base' })
    if (labelCmp !== 0) return labelCmp
    const emailA = (a.email?.trim() || a.id).toLowerCase()
    const emailB = (b.email?.trim() || b.id).toLowerCase()
    const emailCmp = emailA.localeCompare(emailB)
    if (emailCmp !== 0) return emailCmp
    return a.id.localeCompare(b.id)
  })
}

/** Email shown under a custom nickname when it differs from account_label. */
export function connectionEmailSecondary(
  conn: Pick<CalendarConnection, 'account_label' | 'email'>,
): string | null {
  const label = conn.account_label?.trim()
  const email = conn.email?.trim()
  if (!email) return null
  if (!label || label.toLowerCase() === email.toLowerCase()) return null
  return email
}

export function formatEventStartTime(
  event: Pick<CalendarEvent, 'all_day' | 'starts_at'>,
): string {
  return formatCalendarEventStartTime(event.starts_at, event.all_day)
}

export function formatEventTimeRange(
  event: Pick<CalendarEvent, 'all_day' | 'starts_at' | 'ends_at'>,
): string {
  return formatCalendarEventTime(event.starts_at, event.ends_at, event.all_day)
}

export function connectionCreateEventLabel(
  conn: Pick<CalendarConnection, 'account_label' | 'email' | 'provider'>,
): string {
  const nickname = conn.account_label?.trim()
  const email = conn.email?.trim()
  if (nickname && (!email || nickname.toLowerCase() !== email.toLowerCase())) {
    return email ? `${nickname} (${email})` : nickname
  }
  return email || conn.provider
}

export function connectionFilterLabel(
  member: CalendarTeamMember,
  conn: CalendarConnection,
): string {
  return `${memberLabel(member)} · ${connectionAccountLabel(conn)}`
}

export function eventOwnerLabel(
  member: CalendarTeamMember | undefined,
  conn: CalendarConnection | undefined,
): string {
  const owner = member ? memberLabel(member) : 'Unknown'
  const account = conn ? connectionAccountLabel(conn) : null
  return account ? `${owner} · ${account}` : owner
}

export function connectionStatusLabel(status: string): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'pending':
      return 'Pending'
    case 'error':
      return 'Error'
    case 'disconnected':
      return 'Disconnected'
    default:
      return status
  }
}

export function formatLastSynced(lastSyncedAt: string | null | undefined): string {
  if (!lastSyncedAt) return 'Never synced'
  const date = new Date(lastSyncedAt)
  if (Number.isNaN(date.getTime())) return 'Never synced'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
