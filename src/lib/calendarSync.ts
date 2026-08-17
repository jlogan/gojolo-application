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

async function parseInvokeError(error: unknown, data: CalendarSyncResponse | null): Promise<string> {
  const fromData = messageFromResponseBody(data)
  if (fromData) return fromData

  if (error && typeof error === 'object') {
    if ('context' in error && error.context instanceof Response) {
      try {
        const body = await error.context.clone().json() as CalendarSyncResponse
        const fromBody = messageFromResponseBody(body)
        if (fromBody) return fromBody
      } catch {
        // ignore non-JSON error bodies
      }
    }
    if ('message' in error) {
      const msg = String((error as { message: string }).message)
      if (msg && msg !== 'Edge Function returned a non-2xx status code') return msg
    }
  }
  return 'Calendar request failed'
}

export async function fetchCalendarSyncStatus(orgId: string): Promise<CalendarSyncResponse> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: { orgId, action: 'status' },
  })
  if (error) throw new Error(await parseInvokeError(error, data))
  return data ?? {}
}

export async function startGoogleCalendarConnect(
  orgId: string,
  returnPath = '/calendar',
): Promise<string> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: {
      orgId,
      action: 'start',
      provider: 'google' satisfies CalendarProvider,
      returnPath,
    },
  })
  if (error || !data?.authUrl) {
    throw new Error(await parseInvokeError(error, data ?? null))
  }
  return data.authUrl
}

export async function syncGoogleCalendar(orgId: string, connectionId?: string): Promise<CalendarSyncResponse> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: { orgId, action: 'sync', provider: 'google', ...(connectionId ? { connectionId } : {}) },
  })
  if (error) throw new Error(await parseInvokeError(error, data ?? null))
  return data ?? {}
}

export async function disconnectGoogleCalendar(orgId: string, connectionId?: string): Promise<CalendarSyncResponse> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: { orgId, action: 'disconnect', provider: 'google', ...(connectionId ? { connectionId } : {}) },
  })
  if (error) throw new Error(await parseInvokeError(error, data ?? null))
  return data ?? {}
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
  const { data, error } = await supabase.functions.invoke<CreateCalendarEventResult>('calendar-sync', {
    body: {
      orgId,
      action: 'createEvent',
      provider: 'google' satisfies CalendarProvider,
      ...input,
    },
  })
  if (error) throw new Error(await parseInvokeError(error, data ?? null))
  if (data?.error) throw new Error(data.message ?? data.error)
  return data ?? {}
}

export async function updateGoogleCalendarEvent(
  orgId: string,
  input: UpdateCalendarEventInput,
): Promise<UpdateCalendarEventResult> {
  const { data, error } = await supabase.functions.invoke<UpdateCalendarEventResult>('calendar-sync', {
    body: {
      orgId,
      action: 'updateEvent',
      provider: 'google' satisfies CalendarProvider,
      ...input,
    },
  })
  if (error) throw new Error(await parseInvokeError(error, data ?? null))
  if (data?.error) throw new Error(data.message ?? data.error)
  return data ?? {}
}

export async function deleteGoogleCalendarEvent(
  orgId: string,
  input: DeleteCalendarEventInput,
): Promise<DeleteCalendarEventResult> {
  const { data, error } = await supabase.functions.invoke<DeleteCalendarEventResult>('calendar-sync', {
    body: {
      orgId,
      action: 'deleteEvent',
      provider: 'google' satisfies CalendarProvider,
      ...input,
    },
  })
  if (error) throw new Error(await parseInvokeError(error, data ?? null))
  if (data?.error) throw new Error(data.message ?? data.error)
  return data ?? {}
}
