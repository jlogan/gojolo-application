import type { CalendarEvent, CalendarEventVisibility } from '@/types/calendar'

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
