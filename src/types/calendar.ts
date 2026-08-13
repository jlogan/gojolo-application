export type CalendarProvider = 'google' | 'microsoft'

export type CalendarConnectionStatus = 'pending' | 'connected' | 'error' | 'disconnected'

export type CalendarEventVisibility = 'default' | 'public' | 'private' | 'busy_only'

export type CalendarEventStatus = 'confirmed' | 'tentative' | 'cancelled'

export type CalendarConnection = {
  id: string
  org_id: string
  user_id: string
  provider: CalendarProvider
  provider_account_id: string | null
  email: string | null
  status: CalendarConnectionStatus
  sync_error: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export type CalendarEvent = {
  id: string
  org_id: string
  connection_id: string
  user_id: string
  external_id: string
  title: string | null
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string
  all_day: boolean
  visibility: CalendarEventVisibility
  status: CalendarEventStatus
  created_at: string
  updated_at: string
}

export type CalendarTeamMember = {
  user_id: string
  display_name: string | null
  email: string | null
}
