import { supabase } from '@/lib/supabase'
import type { CalendarProvider } from '@/types/calendar'

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

function parseInvokeError(error: unknown, data: CalendarSyncResponse | null): string {
  if (data?.error) return data.error
  if (data?.message && data.ok === false) return data.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message)
  }
  return 'Calendar request failed'
}

export async function fetchCalendarSyncStatus(orgId: string): Promise<CalendarSyncResponse> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: { orgId, action: 'status' },
  })
  if (error) throw new Error(parseInvokeError(error, data))
  return data ?? {}
}

export async function startGoogleCalendarConnect(orgId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: {
      orgId,
      action: 'start',
      provider: 'google' satisfies CalendarProvider,
      returnPath: '/calendar',
    },
  })
  if (error || !data?.authUrl) {
    throw new Error(parseInvokeError(error, data ?? null))
  }
  return data.authUrl
}

export async function syncGoogleCalendar(orgId: string, connectionId?: string): Promise<CalendarSyncResponse> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: { orgId, action: 'sync', provider: 'google', ...(connectionId ? { connectionId } : {}) },
  })
  if (error) throw new Error(parseInvokeError(error, data ?? null))
  return data ?? {}
}

export async function disconnectGoogleCalendar(orgId: string, connectionId?: string): Promise<CalendarSyncResponse> {
  const { data, error } = await supabase.functions.invoke<CalendarSyncResponse>('calendar-sync', {
    body: { orgId, action: 'disconnect', provider: 'google', ...(connectionId ? { connectionId } : {}) },
  })
  if (error) throw new Error(parseInvokeError(error, data ?? null))
  return data ?? {}
}

export async function updateCalendarConnectionLabel(
  orgId: string,
  userId: string,
  connectionId: string,
  accountLabel: string,
): Promise<void> {
  const trimmed = accountLabel.trim()
  const { error } = await supabase
    .from('calendar_connections')
    .update({
      account_label: trimmed || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectionId)
    .eq('org_id', orgId)
    .eq('user_id', userId)

  if (error) throw new Error(error.message)
}
