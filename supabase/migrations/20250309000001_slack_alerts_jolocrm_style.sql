-- Slack alerts: JoloCRM-style colors and layout (green task, red email, blue status/comment)

-- New email: RED bar, "New email from X", subject as link, From + Time, footer "JoloCRM Email"
CREATE OR REPLACE FUNCTION public.notify_slack_on_new_message()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_config record;
  v_subject text;
  v_channel text;
  v_project_channel text;
  v_thread_url text;
  v_body jsonb;
  v_footer_ts text;
  v_from_escaped text;
  v_time_ts text;
BEGIN
  IF NEW.direction <> 'inbound' THEN RETURN NEW; END IF;

  SELECT org_id INTO v_org_id FROM inbox_threads WHERE id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = v_org_id AND is_active = true AND notify_on_new_email = true LIMIT 1;

  IF v_config IS NULL THEN RETURN NEW; END IF;
  IF v_config.bot_token IS NULL AND v_config.webhook_url IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(subject, '(No subject)') INTO v_subject FROM inbox_threads WHERE id = NEW.thread_id;
  v_subject := public.slack_escape_mrkdwn(v_subject);
  v_from_escaped := public.slack_escape_mrkdwn(NEW.from_identifier);
  v_time_ts := to_char(COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC', 'Mon DD, YYYY HH12:MI AM');

  SELECT spc.channel_id INTO v_project_channel
  FROM inbox_thread_contacts itc
  JOIN project_contacts pc ON pc.contact_id = itc.contact_id
  JOIN slack_project_channels spc ON spc.project_id = pc.project_id
  WHERE itc.thread_id = NEW.thread_id LIMIT 1;

  v_channel := COALESCE(v_project_channel, public.slack_channel_for_api(v_config.inbox_channel), public.slack_channel_for_api(v_config.default_channel));
  IF v_channel IS NULL THEN RETURN NEW; END IF;

  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.thread_id;
  v_footer_ts := to_char(now() AT TIME ZONE 'UTC', 'FMDD Mon') || ' at ' || to_char(now() AT TIME ZONE 'UTC', 'HH12:MI AM');

  IF v_config.bot_token IS NOT NULL THEN
    v_body := jsonb_build_object(
      'channel', v_channel,
      'text', 'New email from ' || NEW.from_identifier || ': ' || v_subject,
      'unfurl_links', false,
      'attachments', jsonb_build_array(
        jsonb_build_object(
          'color', '#E01E5A',
          'blocks', jsonb_build_array(
            jsonb_build_object(
              'type', 'section',
              'text', jsonb_build_object(
                'type', 'mrkdwn',
                'text', '*New email from ' || v_from_escaped || '*'
              )
            ),
            jsonb_build_object(
              'type', 'section',
              'text', jsonb_build_object(
                'type', 'mrkdwn',
                'text', '<' || v_thread_url || '|' || v_subject || '>'
              )
            ),
            jsonb_build_object(
              'type', 'section',
              'fields', jsonb_build_array(
                jsonb_build_object('type', 'mrkdwn', 'text', '*From*' || E'\n' || v_from_escaped),
                jsonb_build_object('type', 'mrkdwn', 'text', '*Time*' || E'\n' || v_time_ts)
              )
            ),
            jsonb_build_object(
              'type', 'context',
              'elements', jsonb_build_array(
                jsonb_build_object('type', 'mrkdwn', 'text', 'JoloCRM Email ' || v_footer_ts)
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
  ELSIF v_config.webhook_url IS NOT NULL THEN
    PERFORM net.http_post(
      url := v_config.webhook_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'channel', v_channel,
        'text', '📧 New email from ' || NEW.from_identifier || ': *' || v_subject || '* — <' || v_thread_url || '|View in jolo>',
        'unfurl_links', false
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Task created: GREEN bar, "New task created:" + title link, description snippet, Created By, Assigned To, Priority, Due Date, "JoloCRM New Task"
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_created()
RETURNS trigger AS $$
DECLARE
  v_config record;
  v_channel text;
  v_project_name text;
  v_task_url text;
  v_title_escaped text;
  v_desc_escaped text;
  v_created_by_name text;
  v_assignees text;
  v_footer_ts text;
  v_body jsonb;
  v_due_date text;
BEGIN
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
    v_desc_escaped := public.slack_escape_mrkdwn(left(trim(NEW.description), 500));
    IF length(trim(NEW.description)) > 500 THEN v_desc_escaped := v_desc_escaped || '...'; END IF;
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
  v_footer_ts := to_char(now() AT TIME ZONE 'UTC', 'FMDD Mon') || ' at ' || to_char(now() AT TIME ZONE 'UTC', 'HH12:MI AM');

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

-- Task status change: blue bar, footer "JoloCRM Task Status Change"
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_status_change()
RETURNS trigger AS $$
DECLARE
  v_config record;
  v_channel text;
  v_task_url text;
  v_title_escaped text;
  v_status_display text;
  v_priority_display text;
  v_changed_by_name text;
  v_footer_ts text;
  v_body jsonb;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = NEW.org_id AND is_active = true AND notify_on_task_status_change = true AND bot_token IS NOT NULL LIMIT 1;
  IF v_config IS NULL THEN RETURN NEW; END IF;

  SELECT spc.channel_id INTO v_channel
  FROM slack_project_channels spc WHERE spc.project_id = NEW.project_id LIMIT 1;
  IF v_channel IS NULL THEN
    v_channel := public.slack_channel_for_api(COALESCE(v_config.default_channel, v_config.inbox_channel));
  END IF;
  IF v_channel IS NULL THEN RETURN NEW; END IF;

  v_task_url := 'https://app.gojolo.io/projects/' || NEW.project_id || '/tasks/' || NEW.id;
  v_title_escaped := public.slack_escape_mrkdwn(COALESCE(NEW.title, 'Untitled'));
  v_status_display := public.slack_escape_mrkdwn(COALESCE(NEW.status, ''));
  v_priority_display := public.slack_escape_mrkdwn(COALESCE(NEW.priority, ''));

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_changed_by_name
  FROM profiles p WHERE p.id = NEW.status_changed_by LIMIT 1;
  IF v_changed_by_name IS NULL THEN v_changed_by_name := 'Someone'; END IF;
  v_changed_by_name := public.slack_escape_mrkdwn(v_changed_by_name);

  v_footer_ts := to_char(now() AT TIME ZONE 'UTC', 'FMDD Mon') || ' at ' || to_char(now() AT TIME ZONE 'UTC', 'HH12:MI AM');

  v_body := jsonb_build_object(
    'channel', v_channel,
    'text', 'Task status changed: ' || COALESCE(NEW.title, 'Untitled'),
    'unfurl_links', false,
    'attachments', jsonb_build_array(
      jsonb_build_object(
        'color', '#4A90D9',
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '*Task status changed:* <' || v_task_url || '|' || v_title_escaped || '>'
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'fields', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', '*Status*' || E'\n' || v_status_display),
              jsonb_build_object('type', 'mrkdwn', 'text', '*Priority*' || E'\n' || v_priority_display)
            )
          ),
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '*Changed By*' || E'\n' || v_changed_by_name
            )
          ),
          jsonb_build_object(
            'type', 'context',
            'elements', jsonb_build_array(
              jsonb_build_object('type', 'mrkdwn', 'text', 'JoloCRM Task Status Change ' || v_footer_ts)
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
