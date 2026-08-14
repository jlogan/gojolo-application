-- Track GoJoLo-created calendar events vs provider-synced events

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.calendar_events.source IS 'Origin of the event row: gojolo for app-created events; null for provider sync.';
COMMENT ON COLUMN public.calendar_events.created_by_user_id IS 'User who created the event via GoJoLo (null for synced-only events).';

CREATE INDEX IF NOT EXISTS idx_calendar_events_source ON public.calendar_events(org_id, source)
  WHERE source IS NOT NULL;

-- Extend viewer RPC to return source metadata. Return signature changed, so drop first.
DROP FUNCTION IF EXISTS public.get_calendar_events_for_viewer(uuid, timestamptz, timestamptz);

CREATE FUNCTION public.get_calendar_events_for_viewer(
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
  source text,
  created_by_user_id uuid,
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
    e.source,
    e.created_by_user_id,
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
