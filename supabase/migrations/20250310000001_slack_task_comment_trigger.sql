-- Send Slack notification when a task comment is inserted (server-side, no client dependency)

CREATE OR REPLACE FUNCTION public.notify_slack_on_task_comment()
RETURNS trigger AS $$
DECLARE
  v_task record;
  v_config record;
  v_channel text;
  v_task_url text;
  v_title_escaped text;
  v_preview text;
  v_author text;
  v_footer_ts text;
  v_body jsonb;
  v_priority text;
  v_status text;
BEGIN
  SELECT t.id, t.project_id, t.org_id, t.title, t.status, t.priority
  INTO v_task
  FROM tasks t WHERE t.id = NEW.task_id;

  IF v_task.id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = v_task.org_id AND is_active = true AND notify_on_task_comment = true AND bot_token IS NOT NULL LIMIT 1;

  IF v_config IS NULL THEN RETURN NEW; END IF;

  SELECT spc.channel_id INTO v_channel
  FROM slack_project_channels spc WHERE spc.project_id = v_task.project_id LIMIT 1;

  IF v_channel IS NULL THEN
    v_channel := public.slack_channel_for_api(COALESCE(v_config.default_channel, v_config.inbox_channel));
  END IF;

  IF v_channel IS NULL THEN RETURN NEW; END IF;

  v_task_url := 'https://app.gojolo.io/projects/' || v_task.project_id || '/tasks/' || v_task.id;
  v_title_escaped := public.slack_escape_mrkdwn(COALESCE(v_task.title, 'Untitled'));
  v_preview := regexp_replace(NEW.content, '\[[^\]]*\]\([^)]+\)', '[attachment]', 'g');
  v_preview := left(public.slack_escape_mrkdwn(v_preview), 300);
  IF length(v_preview) = 300 THEN v_preview := v_preview || '...'; END IF;
  IF v_preview IS NULL OR trim(v_preview) = '' THEN v_preview := '(no text)'; END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_author FROM profiles p WHERE p.id = NEW.user_id LIMIT 1;
  IF v_author IS NULL THEN v_author := 'Someone'; END IF;
  v_author := public.slack_escape_mrkdwn(v_author);

  v_priority := public.slack_escape_mrkdwn(COALESCE(v_task.priority, '—'));
  v_status := public.slack_escape_mrkdwn(COALESCE(v_task.status, '—'));
  v_footer_ts := to_char(COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC', 'FMDD Mon') || ' at ' || to_char(COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC', 'HH12:MI AM');

  v_body := jsonb_build_object(
    'channel', v_channel,
    'text', 'New comment on task: ' || COALESCE(v_task.title, 'Task'),
    'unfurl_links', false,
    'attachments', jsonb_build_array(
      jsonb_build_object(
        'color', '#4A90D9',
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '*New comment on task:* <' || v_task_url || '|' || v_title_escaped || '>'
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', v_preview
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'fields', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', '*Commented By*' || E'\n' || v_author),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Priority*' || E'\n' || v_priority),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Time*' || E'\n' || v_footer_ts),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Status*' || E'\n' || v_status)
            )
          ),
          jsonb_build_object(
            'type', 'context',
            'elements', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', 'JoloCRM Task Comment ' || v_footer_ts)
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS slack_notify_task_comment ON public.task_comments;
CREATE TRIGGER slack_notify_task_comment
  AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_slack_on_task_comment();
