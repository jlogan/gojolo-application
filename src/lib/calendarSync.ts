import { supabase } from '@/lib/supabase'
import type {
  CalendarProvider,
  CreateCalendarEventInput,
  CreateCalendarEventResult,
  DeleteCalendarEventInput,
  DeleteCalendarEventResult,
  UpdateCalendarEventInput,
  UpdateCalendarEventResult,
} from '@/types/calendar'

type CalendarSyncResponse = {
  ok?: boolean
  authUrl?: string
  connectionId?: string
  returnPath?: string
  synced?: number
  message?: string
  error?: string
  providers?: { google?: boolean }
  redirectUri?: string | null
}

function messageFromResponseBody(body: CalendarSyncResponse | null | undefined): string | null {
  if (!body) return null
  if (body.message?.trim()) return body.message.trim()
  if (body.error?.trim()) return body.error.trim()
  return null
}

async function invokeCalendarSync<T>(body: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error('Please sign in again.')
  }

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/calendar-sync`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    },
  )

  const data = await response.json().catch(() => null) as T | null

  if (!response.ok) {
    const msg = messageFromResponseBody(data as CalendarSyncResponse | null)
    throw new Error(msg ?? 'Calendar request failed')
  }

  return (data ?? {}) as T
}

export async function fetchCalendarSyncStatus(orgId: string): Promise<CalendarSyncResponse> {
  return invokeCalendarSync<CalendarSyncResponse>({ orgId, action: 'status' })
}

export async function startGoogleCalendarConnect(
  orgId: string,
  returnPath = '/calendar',
): Promise<string> {
  const data = await invokeCalendarSync<CalendarSyncResponse>({
    orgId,
    action: 'start',
    provider: 'google' satisfies CalendarProvider,
    returnPath,
  })
  if (!data.authUrl) {
    throw new Error(messageFromResponseBody(data) ?? 'Calendar request failed')
  }
  return data.authUrl
}

export async function syncGoogleCalendar(orgId: string, connectionId?: string): Promise<CalendarSyncResponse> {
  return invokeCalendarSync<CalendarSyncResponse>({
    orgId,
    action: 'sync',
    provider: 'google',
    ...(connectionId ? { connectionId } : {}),
  })
}

export async function disconnectGoogleCalendar(orgId: string, connectionId?: string): Promise<CalendarSyncResponse> {
  return invokeCalendarSync<CalendarSyncResponse>({
    orgId,
    action: 'disconnect',
    provider: 'google',
    ...(connectionId ? { connectionId } : {}),
  })
}

export async function updateCalendarConnectionLabel(
  orgId: string,
  connectionId: string,
  accountLabel: string,
): Promise<void> {
  const { error } = await supabase.rpc('update_calendar_connection_label', {
    p_org_id: orgId,
    p_connection_id: connectionId,
    p_account_label: accountLabel,
  })

  if (error) throw new Error(error.message)
}

export async function createGoogleCalendarEvent(
  orgId: string,
  input: CreateCalendarEventInput,
): Promise<CreateCalendarEventResult> {
  const data = await invokeCalendarSync<CreateCalendarEventResult>({
    orgId,
    action: 'createEvent',
    provider: 'google' satisfies CalendarProvider,
    ...input,
  })
  if (data?.error) throw new Error(data.message ?? data.error)
  return data ?? {}
}

export async function updateGoogleCalendarEvent(
  orgId: string,
  input: UpdateCalendarEventInput,
): Promise<UpdateCalendarEventResult> {
  const data = await invokeCalendarSync<UpdateCalendarEventResult>({
    orgId,
    action: 'updateEvent',
    provider: 'google' satisfies CalendarProvider,
    ...input,
  })
  if (data?.error) throw new Error(data.message ?? data.error)
  return data ?? {}
}

export async function deleteGoogleCalendarEvent(
  orgId: string,
  input: DeleteCalendarEventInput,
): Promise<DeleteCalendarEventResult> {
  const data = await invokeCalendarSync<DeleteCalendarEventResult>({
    orgId,
    action: 'deleteEvent',
    provider: 'google' satisfies CalendarProvider,
    ...input,
  })
  if (data?.error) throw new Error(data.message ?? data.error)
  return data ?? {}
}
