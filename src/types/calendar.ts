export type CalendarProvider = 'google' | 'microsoft'

export type CalendarConnectionStatus = 'pending' | 'connected' | 'error' | 'disconnected'

export type CalendarEventVisibility = 'default' | 'public' | 'private' | 'busy_only'

export type CalendarEventStatus = 'confirmed' | 'tentative' | 'cancelled'

export type CalendarConferenceEntryPoint = {
  entryPointType?: string
  uri?: string
  label?: string
  pin?: string
  meetingCode?: string
  passcode?: string
  regionCode?: string
}

export type CalendarConferenceData = {
  entryPoints?: CalendarConferenceEntryPoint[]
  conferenceId?: string
  signature?: string
  notes?: string
}

export type CalendarAttendee = {
  email?: string
  displayName?: string
  responseStatus?: string
  organizer?: boolean
  self?: boolean
  optional?: boolean
}

export type CalendarAttachment = {
  fileUrl?: string
  title?: string
  mimeType?: string
  iconLink?: string
  fileId?: string
}

export type CalendarReminder = {
  method?: string
  minutes?: number
}

export type CalendarReminders = {
  useDefault?: boolean
  overrides?: CalendarReminder[]
}

export type CalendarPerson = {
  email?: string
  displayName?: string
  self?: boolean
}

export type CalendarConnection = {
  id: string
  org_id: string
  user_id: string
  provider: CalendarProvider
  provider_account_id: string | null
  email: string | null
  account_label: string | null
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
  meeting_url: string | null
  conference_data: CalendarConferenceData | null
  attendees: CalendarAttendee[] | null
  attachments: CalendarAttachment[] | null
  reminders: CalendarReminders | null
  organizer: CalendarPerson | null
  creator: CalendarPerson | null
  recurrence_rules: string[] | null
  recurring_event_id: string | null
  html_link: string | null
  provider_updated_at: string | null
  created_at: string
  updated_at: string
}

export type CalendarTeamMember = {
  user_id: string
  display_name: string | null
  email: string | null
}
