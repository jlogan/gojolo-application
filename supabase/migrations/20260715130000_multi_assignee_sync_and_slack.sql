-- Multi-assignee: keep tasks.assigned_to in sync with task_assignees (primary = earliest assignee).
-- Defer task-created Slack until assignees are written so the alert lists everyone selected at create time.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS slack_task_created_notified boolean NOT NULL DEFAULT false;

-- Existing tasks were already processed (or intentionally not processed). Only new tasks should be eligible.
UPDATE public.tasks
SET slack_task_created_notified = true
WHERE slack_task_created_notified = false
  AND created_at < now() - interval '5 minutes';

-- Shared Slack sender for a task row (used by task-insert and assignee-insert paths).
CREATE OR REPLACE FUNCTION public.notify_slack_task_created_by_id(p_task_id uuid)
RETURNS void AS $$
DECLARE
  v_task public.tasks%ROWTYPE;
  v_tz text;
  v_config record;
  v_channel text;
  v_project_name text;
  v_task_url text;
  v_title_escaped text;
  v_desc_escaped text;
  v_desc_plain text;
  v_created_by_name text;
  v_assignees text;
  v_footer_ts text;
  v_body jsonb;
  v_due_date text;
BEGIN
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT o.timezone INTO v_tz FROM public.organizations o WHERE o.id = v_task.org_id;
  v_tz := COALESCE(NULLIF(trim(v_tz), ''), 'America/New_York');

  SELECT * INTO v_config FROM public.slack_configs
  WHERE org_id = v_task.org_id AND is_active = true AND notify_on_task_created = true AND bot_token IS NOT NULL
  LIMIT 1;
  IF v_config IS NULL THEN RETURN; END IF;

  SELECT spc.channel_id INTO v_channel
  FROM public.slack_project_channels spc WHERE spc.project_id = v_task.project_id LIMIT 1;
  IF v_channel IS NULL THEN
    v_channel := public.slack_channel_for_api(COALESCE(v_config.default_channel, v_config.inbox_channel));
  END IF;
  IF v_channel IS NULL THEN RETURN; END IF;

  SELECT name INTO v_project_name FROM public.projects WHERE id = v_task.project_id;
  v_task_url := 'https://app.gojolo.io/projects/' || v_task.project_id || '/tasks/' || v_task.id;
  v_title_escaped := public.slack_escape_mrkdwn(COALESCE(v_task.title, 'Untitled'));
  IF v_task.description IS NOT NULL AND trim(v_task.description) <> '' THEN
    v_desc_plain := public.slack_strip_html(trim(v_task.description));
    v_desc_escaped := left(public.slack_escape_mrkdwn(v_desc_plain), 500);
    IF length(v_desc_plain) > 500 THEN v_desc_escaped := v_desc_escaped || '...'; END IF;
  ELSE
    v_desc_escaped := '—';
  END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_created_by_name
  FROM public.profiles p WHERE p.id = v_task.created_by LIMIT 1;
  IF v_created_by_name IS NULL THEN v_created_by_name := '—'; END IF;
  v_created_by_name := public.slack_escape_mrkdwn(v_created_by_name);

  SELECT string_agg(public.slack_escape_mrkdwn(COALESCE(p.display_name, p.email, 'User')), ', ' ORDER BY p.display_name)
  INTO v_assignees
  FROM public.task_assignees ta
  JOIN public.profiles p ON p.id = ta.user_id
  WHERE ta.task_id = v_task.id;
  IF v_assignees IS NULL OR v_assignees = '' THEN v_assignees := 'Not set'; END IF;

  v_due_date := CASE WHEN v_task.due_date IS NOT NULL THEN to_char(v_task.due_date, 'Mon DD, YYYY') ELSE 'Not set' END;
  v_footer_ts := to_char(now() AT TIME ZONE v_tz, 'FMDD Mon') || ' at ' || to_char(now() AT TIME ZONE v_tz, 'HH12:MI AM');

  v_body := jsonb_build_object(
    'channel', v_channel,
    'text', 'New task created: ' || COALESCE(v_task.title, 'Untitled'),
    'unfurl_links', false,
    'attachments', jsonb_build_array(
      jsonb_build_object(
        'color', '#2EB886',
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '*New task created:* <' || v_task_url || '|' || v_title_escaped || '>'
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object('type', 'mrkdwn', 'text', v_desc_escaped)
          ),
          jsonb_build_object(
            'type', 'section',
            'fields', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', '*Created By*' || E'\n' || v_created_by_name),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Assigned To*' || E'\n' || v_assignees),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Priority*' || E'\n' || public.slack_escape_mrkdwn(COALESCE(v_task.priority, '—'))),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Due Date*' || E'\n' || v_due_date)
            )
          ),
          jsonb_build_object(
            'type', 'context',
            'elements', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', 'JoloCRM New Task ' || v_task_url || ' ' || v_footer_ts)
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Task insert: notify only for unassigned tasks (assignee path handles the rest once).
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_created()
RETURNS trigger AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.slack_task_created_notified THEN
    RETURN NEW;
  END IF;

  PERFORM public.notify_slack_task_created_by_id(NEW.id);
  UPDATE public.tasks SET slack_task_created_notified = true WHERE id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- After assignees are inserted (batch), send one task-created Slack for new tasks.
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_assignees_inserted()
RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT i.task_id
    FROM inserted i
    JOIN public.tasks t ON t.id = i.task_id
    WHERE NOT t.slack_task_created_notified
      AND t.created_at > now() - interval '1 hour'
  LOOP
    PERFORM public.notify_slack_task_created_by_id(r.task_id);
    UPDATE public.tasks SET slack_task_created_notified = true WHERE id = r.task_id;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS slack_notify_task_created_from_assignees ON public.task_assignees;
CREATE TRIGGER slack_notify_task_created_from_assignees
  AFTER INSERT ON public.task_assignees
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.notify_slack_on_task_assignees_inserted();

-- Mirror tasks.assigned_to from task_assignees (primary = earliest row, else null).
CREATE OR REPLACE FUNCTION public.sync_task_assigned_to_from_assignees()
RETURNS trigger AS $$
DECLARE
  v_task_id uuid;
  v_primary uuid;
BEGIN
  v_task_id := COALESCE(NEW.task_id, OLD.task_id);

  SELECT ta.user_id INTO v_primary
  FROM public.task_assignees ta
  WHERE ta.task_id = v_task_id
  ORDER BY ta.created_at ASC, ta.user_id ASC
  LIMIT 1;

  UPDATE public.tasks
  SET assigned_to = v_primary,
      updated_at = now()
  WHERE id = v_task_id
    AND assigned_to IS DISTINCT FROM v_primary;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS sync_task_assigned_to_from_assignees_ins ON public.task_assignees;
CREATE TRIGGER sync_task_assigned_to_from_assignees_ins
  AFTER INSERT ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_assigned_to_from_assignees();

DROP TRIGGER IF EXISTS sync_task_assigned_to_from_assignees_del ON public.task_assignees;
CREATE TRIGGER sync_task_assigned_to_from_assignees_del
  AFTER DELETE ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_assigned_to_from_assignees();

-- Legacy insert hook is superseded by explicit assignee writes + mirror trigger.
DROP TRIGGER IF EXISTS aa_sync_task_assignee_on_task_insert ON public.tasks;
DROP FUNCTION IF EXISTS public.sync_task_assigned_to_on_insert();

-- Backfill primary assignee for rows that only have join-table data.
UPDATE public.tasks t
SET assigned_to = sub.user_id
FROM (
  SELECT DISTINCT ON (ta.task_id) ta.task_id, ta.user_id
  FROM public.task_assignees ta
  ORDER BY ta.task_id, ta.created_at ASC, ta.user_id ASC
) sub
WHERE t.id = sub.task_id
  AND t.assigned_to IS DISTINCT FROM sub.user_id;
