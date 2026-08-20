-- Calendar event project association + Slack create notification (v1)

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS slack_create_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS slack_upcoming_reminder_notified_at timestamptz;

COMMENT ON COLUMN public.calendar_events.project_id IS
  'Optional GoJoLo project link for app-created/managed events (not synced from Google).';
COMMENT ON COLUMN public.calendar_events.slack_create_notified_at IS
  'When a Slack create notification was sent for this event (dedupe).';
COMMENT ON COLUMN public.calendar_events.slack_upcoming_reminder_notified_at IS
  'TODO: set by a future cron when an upcoming reminder Slack notification is sent.';

CREATE INDEX IF NOT EXISTS idx_calendar_events_project ON public.calendar_events(project_id)
  WHERE project_id IS NOT NULL;

-- Extend viewer RPC to return project_id. Return signature changed, so drop first.
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
  project_id uuid,
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
    e.project_id,
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

-- Slack notification when a GoJoLo event is linked to a project.
CREATE OR REPLACE FUNCTION public.notify_slack_calendar_event_created_by_id(p_event_id uuid)
RETURNS void AS $$
DECLARE
  v_event public.calendar_events%ROWTYPE;
  v_tz text;
  v_config record;
  v_channel text;
  v_project_name text;
  v_calendar_url text;
  v_title_escaped text;
  v_time_label text;
  v_created_by_name text;
  v_footer_ts text;
  v_body jsonb;
BEGIN
  SELECT * INTO v_event FROM public.calendar_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_event.source <> 'gojolo' OR v_event.project_id IS NULL THEN RETURN; END IF;
  IF v_event.slack_create_notified_at IS NOT NULL THEN RETURN; END IF;

  SELECT o.timezone INTO v_tz FROM public.organizations o WHERE o.id = v_event.org_id;
  v_tz := COALESCE(NULLIF(trim(v_tz), ''), 'America/New_York');

  SELECT * INTO v_config FROM public.slack_configs
  WHERE org_id = v_event.org_id AND is_active = true AND bot_token IS NOT NULL
  LIMIT 1;
  IF v_config IS NULL THEN RETURN; END IF;

  SELECT spc.channel_id INTO v_channel
  FROM public.slack_project_channels spc
  WHERE spc.project_id = v_event.project_id
  LIMIT 1;
  IF v_channel IS NULL THEN
    v_channel := public.slack_channel_for_api(COALESCE(v_config.default_channel, v_config.inbox_channel));
  END IF;
  IF v_channel IS NULL THEN RETURN; END IF;

  SELECT name INTO v_project_name FROM public.projects WHERE id = v_event.project_id;
  v_calendar_url := 'https://app.gojolo.io/calendar';
  v_title_escaped := public.slack_escape_mrkdwn(COALESCE(v_event.title, 'Untitled'));

  IF v_event.all_day THEN
    v_time_label := to_char(v_event.starts_at AT TIME ZONE v_tz, 'Mon DD, YYYY') || ' (all day)';
    IF v_event.ends_at IS NOT NULL AND v_event.ends_at::date <> v_event.starts_at::date THEN
      v_time_label := to_char(v_event.starts_at AT TIME ZONE v_tz, 'Mon DD, YYYY')
        || ' – '
        || to_char(v_event.ends_at AT TIME ZONE v_tz, 'Mon DD, YYYY')
        || ' (all day)';
    END IF;
  ELSE
    v_time_label := to_char(v_event.starts_at AT TIME ZONE v_tz, 'Mon DD, YYYY')
      || ' · '
      || to_char(v_event.starts_at AT TIME ZONE v_tz, 'HH12:MI AM')
      || ' – '
      || to_char(v_event.ends_at AT TIME ZONE v_tz, 'HH12:MI AM');
  END IF;
  v_time_label := public.slack_escape_mrkdwn(v_time_label);

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_created_by_name
  FROM public.profiles p
  WHERE p.id = v_event.created_by_user_id
  LIMIT 1;
  IF v_created_by_name IS NULL THEN v_created_by_name := '—'; END IF;
  v_created_by_name := public.slack_escape_mrkdwn(v_created_by_name);

  v_footer_ts := to_char(now() AT TIME ZONE v_tz, 'FMDD Mon') || ' at ' || to_char(now() AT TIME ZONE v_tz, 'HH12:MI AM');

  v_body := jsonb_build_object(
    'channel', v_channel,
    'text', 'New calendar event: ' || COALESCE(v_event.title, 'Untitled'),
    'unfurl_links', false,
    'attachments', jsonb_build_array(
      jsonb_build_object(
        'color', '#4A90D9',
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '*New calendar event:* <' || v_calendar_url || '|' || v_title_escaped || '>'
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'fields', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', '*Project*' || E'\n' || public.slack_escape_mrkdwn(COALESCE(v_project_name, '—'))),
              jsonb_build_object('type', 'mrkdwn', 'text', '*When*' || E'\n' || v_time_label),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Created by*' || E'\n' || v_created_by_name)
            )
          ),
          jsonb_build_object(
            'type', 'context',
            'elements', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', 'GoJoLo Calendar ' || v_calendar_url || ' ' || v_footer_ts)
            )
          )
        )
      )
    )
  );

  PERFORM net.http_post(
    url := 'https://slack.com/api/chat.postMessage',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_config.bot_token),
    body := v_body
  );

  UPDATE public.calendar_events
  SET slack_create_notified_at = now()
  WHERE id = p_event_id AND slack_create_notified_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.notify_slack_on_calendar_event_project()
RETURNS trigger AS $$
BEGIN
  IF NEW.source = 'gojolo'
    AND NEW.project_id IS NOT NULL
    AND NEW.slack_create_notified_at IS NULL
  THEN
    PERFORM public.notify_slack_calendar_event_created_by_id(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS notify_slack_on_calendar_event_project ON public.calendar_events;
CREATE TRIGGER notify_slack_on_calendar_event_project
  AFTER INSERT OR UPDATE OF project_id ON public.calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_slack_on_calendar_event_project();

-- Upcoming reminder v1: notify the same project Slack channel shortly before a linked GoJoLo event starts.
CREATE OR REPLACE FUNCTION public.notify_slack_calendar_event_upcoming_by_id(p_event_id uuid)
RETURNS void AS $$
DECLARE
  v_event public.calendar_events%ROWTYPE;
  v_tz text;
  v_config record;
  v_channel text;
  v_project_name text;
  v_calendar_url text;
  v_title_escaped text;
  v_time_label text;
  v_body jsonb;
BEGIN
  SELECT * INTO v_event FROM public.calendar_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_event.source <> 'gojolo'
    OR v_event.project_id IS NULL
    OR v_event.status = 'cancelled'
    OR v_event.slack_upcoming_reminder_notified_at IS NOT NULL
  THEN
    RETURN;
  END IF;

  SELECT o.timezone INTO v_tz FROM public.organizations o WHERE o.id = v_event.org_id;
  v_tz := COALESCE(NULLIF(trim(v_tz), ''), 'America/New_York');

  SELECT * INTO v_config FROM public.slack_configs
  WHERE org_id = v_event.org_id AND is_active = true AND bot_token IS NOT NULL
  LIMIT 1;
  IF v_config IS NULL THEN RETURN; END IF;

  SELECT spc.channel_id INTO v_channel
  FROM public.slack_project_channels spc
  WHERE spc.project_id = v_event.project_id
  LIMIT 1;
  IF v_channel IS NULL THEN
    v_channel := public.slack_channel_for_api(COALESCE(v_config.default_channel, v_config.inbox_channel));
  END IF;
  IF v_channel IS NULL THEN RETURN; END IF;

  SELECT name INTO v_project_name FROM public.projects WHERE id = v_event.project_id;
  v_calendar_url := 'https://app.gojolo.io/calendar';
  v_title_escaped := public.slack_escape_mrkdwn(COALESCE(v_event.title, 'Untitled'));

  IF v_event.all_day THEN
    v_time_label := to_char(v_event.starts_at AT TIME ZONE v_tz, 'Mon DD, YYYY') || ' (all day)';
  ELSE
    v_time_label := to_char(v_event.starts_at AT TIME ZONE v_tz, 'Mon DD, YYYY')
      || ' · '
      || to_char(v_event.starts_at AT TIME ZONE v_tz, 'HH12:MI AM')
      || ' – '
      || to_char(v_event.ends_at AT TIME ZONE v_tz, 'HH12:MI AM');
  END IF;
  v_time_label := public.slack_escape_mrkdwn(v_time_label);

  v_body := jsonb_build_object(
    'channel', v_channel,
    'text', 'Upcoming calendar event: ' || COALESCE(v_event.title, 'Untitled'),
    'unfurl_links', false,
    'attachments', jsonb_build_array(
      jsonb_build_object(
        'color', '#F2C94C',
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '*Upcoming calendar event:* <' || v_calendar_url || '|' || v_title_escaped || '>'
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'fields', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', '*Project*' || E'\n' || public.slack_escape_mrkdwn(COALESCE(v_project_name, '—'))),
              jsonb_build_object('type', 'mrkdwn', 'text', '*When*' || E'\n' || v_time_label)
            )
          )
        )
      )
    )
  );

  PERFORM net.http_post(
    url := 'https://slack.com/api/chat.postMessage',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_config.bot_token),
    body := v_body
  );

  UPDATE public.calendar_events
  SET slack_upcoming_reminder_notified_at = now()
  WHERE id = p_event_id AND slack_upcoming_reminder_notified_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.notify_upcoming_project_calendar_events()
RETURNS void AS $$
DECLARE
  v_event record;
BEGIN
  FOR v_event IN
    SELECT id
    FROM public.calendar_events
    WHERE source = 'gojolo'
      AND project_id IS NOT NULL
      AND status <> 'cancelled'
      AND slack_upcoming_reminder_notified_at IS NULL
      AND starts_at >= now()
      AND starts_at < now() + interval '15 minutes'
    ORDER BY starts_at ASC
  LOOP
    PERFORM public.notify_slack_calendar_event_upcoming_by_id(v_event.id);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'calendar-project-event-upcoming-reminders';

    PERFORM cron.schedule(
      'calendar-project-event-upcoming-reminders',
      '*/5 * * * *',
      $CRON$
      SELECT public.notify_upcoming_project_calendar_events();
      $CRON$
    );
  END IF;
END
$$;
