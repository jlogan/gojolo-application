-- Rich Google Calendar event fields + org-admin-only connection label updates

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS meeting_url text,
  ADD COLUMN IF NOT EXISTS conference_data jsonb,
  ADD COLUMN IF NOT EXISTS attendees jsonb,
  ADD COLUMN IF NOT EXISTS attachments jsonb,
  ADD COLUMN IF NOT EXISTS reminders jsonb,
  ADD COLUMN IF NOT EXISTS organizer jsonb,
  ADD COLUMN IF NOT EXISTS creator jsonb,
  ADD COLUMN IF NOT EXISTS recurrence_rules text[],
  ADD COLUMN IF NOT EXISTS recurring_event_id text,
  ADD COLUMN IF NOT EXISTS html_link text,
  ADD COLUMN IF NOT EXISTS provider_updated_at timestamptz;

COMMENT ON COLUMN public.calendar_events.meeting_url IS 'Primary video/meeting join URL (e.g. Google Meet hangoutLink or conference entry point).';
COMMENT ON COLUMN public.calendar_events.conference_data IS 'Google conferenceData payload (entry points, pins, phone numbers).';
COMMENT ON COLUMN public.calendar_events.attendees IS 'Event guest list from provider sync.';
COMMENT ON COLUMN public.calendar_events.attachments IS 'Drive/file attachments from provider sync.';
COMMENT ON COLUMN public.calendar_events.reminders IS 'Reminder overrides from provider sync.';
COMMENT ON COLUMN public.calendar_events.organizer IS 'Event organizer from provider sync.';
COMMENT ON COLUMN public.calendar_events.creator IS 'Event creator from provider sync.';
COMMENT ON COLUMN public.calendar_events.recurrence_rules IS 'RFC5545 recurrence rules when event is recurring.';
COMMENT ON COLUMN public.calendar_events.recurring_event_id IS 'Provider recurring series id.';
COMMENT ON COLUMN public.calendar_events.html_link IS 'Open in Google Calendar link.';
COMMENT ON COLUMN public.calendar_events.provider_updated_at IS 'Provider last-updated timestamp.';

CREATE OR REPLACE FUNCTION public.update_calendar_connection_label(
  p_org_id uuid,
  p_connection_id uuid,
  p_account_label text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF NOT public.is_org_admin(p_org_id) THEN
    RAISE EXCEPTION 'Forbidden: org admin required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.calendar_connections
    WHERE id = p_connection_id
      AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Calendar connection not found';
  END IF;

  UPDATE public.calendar_connections
  SET
    account_label = NULLIF(trim(p_account_label), ''),
    updated_at = now()
  WHERE id = p_connection_id
    AND org_id = p_org_id;
END;
$$;

COMMENT ON FUNCTION public.update_calendar_connection_label(uuid, uuid, text) IS
  'Update display nickname for a calendar connection. Org admins only.';

-- Privacy-safe calendar event reads: mask private/busy_only details for non-owners.
-- Direct authenticated SELECT on calendar_events is revoked; use this RPC instead.
-- Service role (calendar-sync Edge Function) continues to read/write the table directly.

CREATE OR REPLACE FUNCTION public.get_calendar_events_for_viewer(
  p_org_id uuid,
  p_range_start timestamptz,
  p_range_end timestamptz
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  connection_id uuid,
  user_id uuid,
  external_id text,
  title text,
  description text,
  location text,
  starts_at timestamptz,
  ends_at timestamptz,
  all_day boolean,
  visibility text,
  status text,
  meeting_url text,
  conference_data jsonb,
  attendees jsonb,
  attachments jsonb,
  reminders jsonb,
  organizer jsonb,
  creator jsonb,
  recurrence_rules text[],
  recurring_event_id text,
  html_link text,
  provider_updated_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF NOT public.user_has_permission(p_org_id, 'calendar.view') THEN
    RAISE EXCEPTION 'Forbidden: calendar.view required';
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.org_id,
    e.connection_id,
    e.user_id,
    e.external_id,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN 'Busy'
      ELSE e.title
    END AS title,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.description
    END AS description,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.location
    END AS location,
    e.starts_at,
    e.ends_at,
    e.all_day,
    e.visibility::text,
    e.status::text,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.meeting_url
    END AS meeting_url,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.conference_data
    END AS conference_data,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.attendees
    END AS attendees,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.attachments
    END AS attachments,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.reminders
    END AS reminders,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.organizer
    END AS organizer,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.creator
    END AS creator,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.recurrence_rules
    END AS recurrence_rules,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.recurring_event_id
    END AS recurring_event_id,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.html_link
    END AS html_link,
    CASE
      WHEN e.visibility IN ('private', 'busy_only') AND e.user_id <> auth.uid() THEN NULL
      ELSE e.provider_updated_at
    END AS provider_updated_at,
    e.created_at,
    e.updated_at
  FROM public.calendar_events e
  WHERE e.org_id = p_org_id
    AND e.starts_at >= p_range_start
    AND e.starts_at < p_range_end
    AND e.status <> 'cancelled'
  ORDER BY e.starts_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_calendar_events_for_viewer(uuid, timestamptz, timestamptz) IS
  'Return org calendar events for viewers with calendar.view. Masks title/details for private and busy_only events owned by other users.';

GRANT EXECUTE ON FUNCTION public.get_calendar_events_for_viewer(uuid, timestamptz, timestamptz) TO authenticated;

DROP POLICY IF EXISTS "ce_select" ON public.calendar_events;

REVOKE SELECT ON public.calendar_events FROM authenticated;
