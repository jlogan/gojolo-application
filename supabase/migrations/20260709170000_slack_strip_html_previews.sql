-- Strip HTML tags from task comment and task-created Slack previews before escaping.

CREATE OR REPLACE FUNCTION public.slack_strip_html(p_text text)
RETURNS text AS $$
DECLARE
  v_text text;
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;

  v_text := p_text;

  -- Handle both real HTML tags and entity-escaped tags that may already have
  -- passed through a rich text or Slack escaping path.
  v_text := regexp_replace(v_text, '(&lt;|<)br\s*/?(&gt;|>)', E'\n', 'gi');
  v_text := regexp_replace(v_text, '(&lt;|<)/p(&gt;|>)', E'\n', 'gi');
  v_text := regexp_replace(v_text, '(&lt;|<)p[^&>]*(&gt;|>)', '', 'gi');
  v_text := regexp_replace(v_text, '<[^>]+>', '', 'g');
  v_text := regexp_replace(v_text, '&lt;[^&]*&gt;', '', 'gi');

  v_text := replace(v_text, '&nbsp;', ' ');
  v_text := replace(v_text, '&amp;', '&');
  v_text := replace(v_text, '&quot;', '"');
  v_text := replace(v_text, '&#39;', '''');
  v_text := replace(v_text, '&apos;', '''');
  v_text := replace(v_text, '&lt;', '<');
  v_text := replace(v_text, '&gt;', '>');

  RETURN trim(v_text);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.notify_slack_on_task_comment()
RETURNS trigger AS $$
DECLARE
  v_task record;
  v_config record;
  v_channel text;
  v_tz text;
  v_task_url text;
  v_title_escaped text;
  v_preview text;
  v_preview_plain text;
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

  SELECT o.timezone INTO v_tz FROM organizations o WHERE o.id = v_task.org_id;
  v_tz := COALESCE(NULLIF(trim(v_tz), ''), 'America/New_York');

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
  v_preview_plain := public.slack_strip_html(
    regexp_replace(NEW.content, '\[[^\]]*\]\([^)]+\)', '[attachment]', 'g')
  );
  v_preview := left(public.slack_escape_mrkdwn(v_preview_plain), 300);
  IF length(v_preview_plain) > 300 THEN v_preview := v_preview || '...'; END IF;
  IF v_preview IS NULL OR trim(v_preview) = '' THEN v_preview := '(no text)'; END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_author FROM profiles p WHERE p.id = NEW.user_id LIMIT 1;
  IF v_author IS NULL THEN v_author := 'Someone'; END IF;
  v_author := public.slack_escape_mrkdwn(v_author);

  v_priority := public.slack_escape_mrkdwn(COALESCE(v_task.priority, '—'));
  v_status := public.slack_escape_mrkdwn(COALESCE(v_task.status, '—'));
  v_footer_ts := to_char((COALESCE(NEW.created_at, now())) AT TIME ZONE v_tz, 'FMDD Mon') || ' at ' || to_char((COALESCE(NEW.created_at, now())) AT TIME ZONE v_tz, 'HH12:MI AM');

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

CREATE OR REPLACE FUNCTION public.notify_slack_on_task_created()
RETURNS trigger AS $$
DECLARE
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
  SELECT o.timezone INTO v_tz FROM organizations o WHERE o.id = NEW.org_id;
  v_tz := COALESCE(NULLIF(trim(v_tz), ''), 'America/New_York');

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = NEW.org_id AND is_active = true AND notify_on_task_created = true AND bot_token IS NOT NULL LIMIT 1;
  IF v_config IS NULL THEN RETURN NEW; END IF;

  SELECT spc.channel_id INTO v_channel
  FROM slack_project_channels spc WHERE spc.project_id = NEW.project_id LIMIT 1;
  IF v_channel IS NULL THEN
    v_channel := public.slack_channel_for_api(COALESCE(v_config.default_channel, v_config.inbox_channel));
  END IF;
  IF v_channel IS NULL THEN RETURN NEW; END IF;

  SELECT name INTO v_project_name FROM projects WHERE id = NEW.project_id;
  v_task_url := 'https://app.gojolo.io/projects/' || NEW.project_id || '/tasks/' || NEW.id;
  v_title_escaped := public.slack_escape_mrkdwn(COALESCE(NEW.title, 'Untitled'));
  IF NEW.description IS NOT NULL AND trim(NEW.description) <> '' THEN
    v_desc_plain := public.slack_strip_html(trim(NEW.description));
    v_desc_escaped := left(public.slack_escape_mrkdwn(v_desc_plain), 500);
    IF length(v_desc_plain) > 500 THEN v_desc_escaped := v_desc_escaped || '...'; END IF;
  ELSE
    v_desc_escaped := '—';
  END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_created_by_name
  FROM profiles p WHERE p.id = NEW.created_by LIMIT 1;
  IF v_created_by_name IS NULL THEN v_created_by_name := '—'; END IF;
  v_created_by_name := public.slack_escape_mrkdwn(v_created_by_name);

  SELECT string_agg(public.slack_escape_mrkdwn(COALESCE(p.display_name, p.email, 'User')), ', ' ORDER BY p.display_name)
  INTO v_assignees
  FROM task_assignees ta
  JOIN profiles p ON p.id = ta.user_id
  WHERE ta.task_id = NEW.id;
  IF v_assignees IS NULL OR v_assignees = '' THEN v_assignees := 'Not set'; END IF;

  v_due_date := CASE WHEN NEW.due_date IS NOT NULL THEN to_char(NEW.due_date, 'Mon DD, YYYY') ELSE 'Not set' END;
  v_footer_ts := to_char(now() AT TIME ZONE v_tz, 'FMDD Mon') || ' at ' || to_char(now() AT TIME ZONE v_tz, 'HH12:MI AM');

  v_body := jsonb_build_object(
    'channel', v_channel,
    'text', 'New task created: ' || COALESCE(NEW.title, 'Untitled'),
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
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', v_desc_escaped
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'fields', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', '*Created By*' || E'\n' || v_created_by_name),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Assigned To*' || E'\n' || v_assignees),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Priority*' || E'\n' || public.slack_escape_mrkdwn(COALESCE(NEW.priority, '—'))),
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
