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

export function getConnectionColor(connectionId: string): string {
  const index = hashConnectionId(connectionId) % CONNECTION_COLORS.length
  return CONNECTION_COLORS[index]
}

export function getConnectionColorStyles(connectionId: string): ConnectionColorStyles {
  const accent = getConnectionColor(connectionId)
  return {
    accent,
    background: hexToRgba(accent, 0.1),
    border: hexToRgba(accent, 0.28),
  }
}

export function getConnectionChipActiveStyles(connectionId: string): {
  borderColor: string
  backgroundColor: string
} {
  const { accent } = getConnectionColorStyles(connectionId)
  return {
    borderColor: accent,
    backgroundColor: hexToRgba(accent, 0.18),
  }
}

export function getConnectionEventCardStyles(connectionId: string): {
  borderLeftColor: string
  borderColor: string
  backgroundColor: string
} {
  const { accent, background, border } = getConnectionColorStyles(connectionId)
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

export function memberLabel(member: Pick<CalendarTeamMember, 'display_name' | 'email'>): string {
  return member.display_name?.trim() || member.email?.trim() || 'Unknown user'
}

export function connectionAccountLabel(
  conn: Pick<CalendarConnection, 'account_label' | 'email' | 'provider'>,
): string {
  return conn.account_label?.trim() || conn.email?.trim() || conn.provider
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
