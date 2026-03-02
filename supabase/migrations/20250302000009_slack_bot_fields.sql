-- Add all required fields for a custom Slack bot with full functionality

ALTER TABLE public.slack_configs
  ADD COLUMN IF NOT EXISTS app_id text,
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS client_secret text,
  ADD COLUMN IF NOT EXISTS signing_secret text,
  ADD COLUMN IF NOT EXISTS bot_user_id text,
  ADD COLUMN IF NOT EXISTS team_id text,
  ADD COLUMN IF NOT EXISTS team_name text,
  ADD COLUMN IF NOT EXISTS scopes text,
  ADD COLUMN IF NOT EXISTS inbox_channel text,
  ADD COLUMN IF NOT EXISTS notify_on_new_email boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_assignment boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_mention boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_thread_close boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

COMMENT ON COLUMN public.slack_configs.bot_token IS 'Bot User OAuth Token (xoxb-...). Required for chat.postMessage, channels.list, users.list, files.upload, reactions.add.';
COMMENT ON COLUMN public.slack_configs.signing_secret IS 'Used to verify incoming requests from Slack (Events API, slash commands, interactivity).';
COMMENT ON COLUMN public.slack_configs.app_id IS 'Slack App ID from api.slack.com/apps.';
COMMENT ON COLUMN public.slack_configs.client_id IS 'OAuth Client ID for the Slack app.';
COMMENT ON COLUMN public.slack_configs.client_secret IS 'OAuth Client Secret for the Slack app.';
COMMENT ON COLUMN public.slack_configs.bot_user_id IS 'Bot user ID in Slack (e.g. U0XXXXXXX). Used to identify bot messages.';
COMMENT ON COLUMN public.slack_configs.team_id IS 'Slack workspace Team ID.';
COMMENT ON COLUMN public.slack_configs.scopes IS 'Comma-separated list of granted OAuth scopes.';
COMMENT ON COLUMN public.slack_configs.inbox_channel IS 'Dedicated channel for all inbox notifications (overrides default_channel for inbox events).';

-- Update the Slack notification trigger to use Bot API (chat.postMessage) when bot_token is available,
-- falling back to webhook. Also adds richer message formatting with Slack Blocks.
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

  -- Determine channel: project-specific > inbox-specific > default
  SELECT spc.channel_id INTO v_project_channel
  FROM inbox_thread_contacts itc
  JOIN project_contacts pc ON pc.contact_id = itc.contact_id
  JOIN slack_project_channels spc ON spc.project_id = pc.project_id
  WHERE itc.thread_id = NEW.thread_id LIMIT 1;

  v_channel := COALESCE(v_project_channel, v_config.inbox_channel, v_config.default_channel);
  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.thread_id;

  IF v_config.bot_token IS NOT NULL THEN
    -- Use Bot API with rich Blocks formatting
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
    -- Fallback to webhook
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

-- Also create triggers for assignment and mention notifications to Slack
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
  v_channel := COALESCE(v_config.inbox_channel, v_config.default_channel);

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

DROP TRIGGER IF EXISTS slack_notify_assignment ON public.inbox_thread_assignments;
CREATE TRIGGER slack_notify_assignment
  AFTER INSERT OR UPDATE ON public.inbox_thread_assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_slack_on_assignment();
