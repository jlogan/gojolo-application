-- Route thread assignment Slack alerts to project-specific channel when the thread is linked to a project (same logic as new email).

CREATE OR REPLACE FUNCTION public.notify_slack_on_assignment()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_config record;
  v_subject text;
  v_assignee_name text;
  v_channel text;
  v_project_channel text;
BEGIN
  SELECT t.org_id, COALESCE(t.subject, '(No subject)')
  INTO v_org_id, v_subject
  FROM inbox_threads t WHERE t.id = NEW.thread_id;

  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = v_org_id AND is_active = true AND notify_on_assignment = true LIMIT 1;

  IF v_config IS NULL OR (v_config.bot_token IS NULL AND v_config.webhook_url IS NULL) THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, email, 'Someone') INTO v_assignee_name FROM profiles WHERE id = NEW.user_id;

  -- Prefer project-specific channel when thread has contacts linked to a project with a Slack channel
  SELECT spc.channel_id INTO v_project_channel
  FROM inbox_thread_contacts itc
  JOIN project_contacts pc ON pc.contact_id = itc.contact_id
  JOIN slack_project_channels spc ON spc.project_id = pc.project_id
  WHERE itc.thread_id = NEW.thread_id
  LIMIT 1;

  v_channel := COALESCE(v_project_channel, public.slack_channel_for_api(v_config.inbox_channel), public.slack_channel_for_api(v_config.default_channel));
  IF v_channel IS NULL THEN RETURN NEW; END IF;

  IF v_config.bot_token IS NOT NULL THEN
    PERFORM net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_config.bot_token),
      body := jsonb_build_object(
        'channel', v_channel,
        'text', '👤 *' || v_assignee_name || '* was assigned to thread: ' || v_subject || ' — <https://app.gojolo.io/inbox/' || NEW.thread_id || '|View>',
        'unfurl_links', false
      )
    );
  ELSIF v_config.webhook_url IS NOT NULL THEN
    PERFORM net.http_post(
      url := v_config.webhook_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('text', '👤 *' || v_assignee_name || '* was assigned to: ' || v_subject)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
