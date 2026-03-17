-- 1. Task notification flags on slack_configs
ALTER TABLE public.slack_configs
  ADD COLUMN IF NOT EXISTS notify_on_task_created boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_task_status_change boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_task_comment boolean DEFAULT true;

-- 2. Helper: strip leading # from channel name for Slack API (chat.postMessage expects name without #)
CREATE OR REPLACE FUNCTION public.slack_channel_for_api(p_channel text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_channel IS NULL OR trim(p_channel) = '' THEN NULL
    WHEN left(ltrim(p_channel), 1) = '#' THEN ltrim(substring(ltrim(p_channel) from 2))
    ELSE trim(p_channel)
  END;
$$;

-- 3. Fix new-email notification: use channel name without # so Slack API accepts it
CREATE OR REPLACE FUNCTION public.notify_slack_on_new_message()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_config record;
  v_subject text;
  v_channel text;
  v_project_channel text;
  v_body jsonb;
  v_thread_url text;
BEGIN
  IF NEW.direction <> 'inbound' THEN RETURN NEW; END IF;

  SELECT org_id INTO v_org_id FROM inbox_threads WHERE id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = v_org_id AND is_active = true AND notify_on_new_email = true LIMIT 1;

  IF v_config IS NULL THEN RETURN NEW; END IF;
  IF v_config.bot_token IS NULL AND v_config.webhook_url IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(subject, '(No subject)') INTO v_subject FROM inbox_threads WHERE id = NEW.thread_id;

  -- Project-specific channel (ID) or inbox/default (may be name with #)
  SELECT spc.channel_id INTO v_project_channel
  FROM inbox_thread_contacts itc
  JOIN project_contacts pc ON pc.contact_id = itc.contact_id
  JOIN slack_project_channels spc ON spc.project_id = pc.project_id
  WHERE itc.thread_id = NEW.thread_id LIMIT 1;

  v_channel := COALESCE(v_project_channel, public.slack_channel_for_api(v_config.inbox_channel), public.slack_channel_for_api(v_config.default_channel));
  IF v_channel IS NULL THEN RETURN NEW; END IF;

  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.thread_id;

  IF v_config.bot_token IS NOT NULL THEN
    v_body := jsonb_build_object(
      'channel', v_channel,
      'text', '📧 New email from ' || NEW.from_identifier || ': ' || v_subject,
      'blocks', jsonb_build_array(
        jsonb_build_object(
          'type', 'section',
          'text', jsonb_build_object(
            'type', 'mrkdwn',
            'text', '📧 *New email*' || E'\n' || '*From:* ' || NEW.from_identifier || E'\n' || '*Subject:* ' || v_subject
          )
        ),
        jsonb_build_object(
          'type', 'actions',
          'elements', jsonb_build_array(
            jsonb_build_object(
              'type', 'button',
              'text', jsonb_build_object('type', 'plain_text', 'text', 'View in jolo'),
              'url', v_thread_url,
              'style', 'primary'
            )
          )
        )
      ),
      'unfurl_links', false
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

-- 4. Assignment notification: strip # from channel
CREATE OR REPLACE FUNCTION public.notify_slack_on_assignment()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_config record;
  v_subject text;
  v_assignee_name text;
  v_channel text;
BEGIN
  SELECT t.org_id, COALESCE(t.subject, '(No subject)')
  INTO v_org_id, v_subject
  FROM inbox_threads t WHERE t.id = NEW.thread_id;

  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = v_org_id AND is_active = true AND notify_on_assignment = true LIMIT 1;

  IF v_config IS NULL OR (v_config.bot_token IS NULL AND v_config.webhook_url IS NULL) THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, email, 'Someone') INTO v_assignee_name FROM profiles WHERE id = NEW.user_id;
  v_channel := public.slack_channel_for_api(COALESCE(v_config.inbox_channel, v_config.default_channel));
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

-- 5. Notify Slack when a task is created
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_created()
RETURNS trigger AS $$
DECLARE
  v_config record;
  v_channel text;
  v_project_name text;
  v_task_url text;
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

  PERFORM net.http_post(
    url := 'https://slack.com/api/chat.postMessage',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_config.bot_token),
    body := jsonb_build_object(
      'channel', v_channel,
      'text', '✅ New task *' || replace(replace(COALESCE(NEW.title, 'Untitled'), '*', ''), '`', '') || '* in _' || COALESCE(v_project_name, 'Project') || '_ — <' || v_task_url || '|Open in jolo>',
      'unfurl_links', false
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. Notify Slack when a task's status changes
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_status_change()
RETURNS trigger AS $$
DECLARE
  v_config record;
  v_channel text;
  v_project_name text;
  v_task_url text;
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

  SELECT name INTO v_project_name FROM projects WHERE id = NEW.project_id;
  v_task_url := 'https://app.gojolo.io/projects/' || NEW.project_id || '/tasks/' || NEW.id;

  PERFORM net.http_post(
    url := 'https://slack.com/api/chat.postMessage',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_config.bot_token),
    body := jsonb_build_object(
      'channel', v_channel,
      'text', '🔄 Task *' || replace(replace(COALESCE(NEW.title, 'Untitled'), '*', ''), '`', '') || '* → _' || COALESCE(NEW.status, '') || '_ — <' || v_task_url || '|Open in jolo>',
      'unfurl_links', false
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. Triggers on tasks
DROP TRIGGER IF EXISTS slack_notify_task_created ON public.tasks;
CREATE TRIGGER slack_notify_task_created
  AFTER INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.notify_slack_on_task_created();

DROP TRIGGER IF EXISTS slack_notify_task_status ON public.tasks;
CREATE TRIGGER slack_notify_task_status
  AFTER UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.notify_slack_on_task_status_change();
