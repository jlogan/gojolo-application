import type { CalendarConnection, CalendarEvent, CalendarEventVisibility, CalendarTeamMember } from '@/types/calendar'

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
