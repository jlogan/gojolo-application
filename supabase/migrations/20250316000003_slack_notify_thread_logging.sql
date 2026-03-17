-- Log table for Slack thread notifications (debugging).
CREATE TABLE IF NOT EXISTS public.slack_notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  thread_id uuid REFERENCES public.inbox_threads(id) ON DELETE SET NULL,
  org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  outcome text NOT NULL,  -- 'sent' | 'skipped'
  skip_reason text,      -- when outcome = 'skipped': 'not_email' | 'no_config' | 'no_credentials' | 'no_channel'
  channel text,          -- Slack channel we sent to (or would have)
  method text,           -- 'bot' | 'webhook' when sent
  subject text,
  from_address text
);

CREATE INDEX IF NOT EXISTS idx_slack_notification_log_created_at ON public.slack_notification_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_notification_log_thread_id ON public.slack_notification_log(thread_id);

COMMENT ON TABLE public.slack_notification_log IS 'Debug log for notify_slack_on_new_thread; query in Studio to see why Slack was or was not notified.';

-- Update trigger function to log and RAISE NOTICE.
CREATE OR REPLACE FUNCTION public.notify_slack_on_new_thread()
RETURNS trigger AS $$
DECLARE
  v_config record;
  v_channel text;
  v_body jsonb;
  v_thread_url text;
  v_subject text;
  v_from text;
BEGIN
  IF NEW.channel <> 'email' THEN
    RAISE NOTICE 'slack_notify_new_thread: thread % skipped (channel=%)', NEW.id, NEW.channel;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address)
    VALUES (NEW.id, NEW.org_id, 'skipped', 'not_email', NEW.subject, NEW.from_address);
    RETURN NEW;
  END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = NEW.org_id AND is_active = true AND notify_on_new_email = true LIMIT 1;

  IF v_config IS NULL THEN
    RAISE NOTICE 'slack_notify_new_thread: thread % skipped (no active config with notify_on_new_email for org %)', NEW.id, NEW.org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address)
    VALUES (NEW.id, NEW.org_id, 'skipped', 'no_config', NEW.subject, NEW.from_address);
    RETURN NEW;
  END IF;

  IF v_config.bot_token IS NULL AND v_config.webhook_url IS NULL THEN
    RAISE NOTICE 'slack_notify_new_thread: thread % skipped (no bot_token or webhook_url for org %)', NEW.id, NEW.org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address)
    VALUES (NEW.id, NEW.org_id, 'skipped', 'no_credentials', NEW.subject, NEW.from_address);
    RETURN NEW;
  END IF;

  v_subject := COALESCE(NEW.subject, '(No subject)');
  v_from := COALESCE(NEW.from_address, '');
  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.id;
  v_channel := COALESCE(v_config.inbox_channel, v_config.default_channel);

  IF v_channel IS NULL THEN
    RAISE NOTICE 'slack_notify_new_thread: thread % skipped (no inbox_channel or default_channel for org %)', NEW.id, NEW.org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, channel, subject, from_address)
    VALUES (NEW.id, NEW.org_id, 'skipped', 'no_channel', NULL, NEW.subject, NEW.from_address);
    RETURN NEW;
  END IF;

  IF v_config.bot_token IS NOT NULL THEN
    RAISE NOTICE 'slack_notify_new_thread: thread % sending via bot to channel %', NEW.id, v_channel;
    v_body := jsonb_build_object(
      'channel', v_channel,
      'text', '📧 New thread: ' || v_subject || ' from ' || v_from,
      'blocks', jsonb_build_array(
        jsonb_build_object(
          'type', 'section',
          'text', jsonb_build_object(
            'type', 'mrkdwn',
            'text', '📧 *New email thread*' || E'\n' || '*From:* ' || v_from || E'\n' || '*Subject:* ' || v_subject
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
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, channel, method, subject, from_address)
    VALUES (NEW.id, NEW.org_id, 'sent', v_channel, 'bot', NEW.subject, NEW.from_address);
  ELSIF v_config.webhook_url IS NOT NULL THEN
    RAISE NOTICE 'slack_notify_new_thread: thread % sending via webhook to channel %', NEW.id, v_channel;
    PERFORM net.http_post(
      url := v_config.webhook_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'channel', v_channel,
        'text', '📧 New thread: *' || v_subject || '* from ' || v_from || ' — <' || v_thread_url || '|View in jolo>',
        'unfurl_links', false
      )
    );
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, channel, method, subject, from_address)
    VALUES (NEW.id, NEW.org_id, 'sent', v_channel, 'webhook', NEW.subject, NEW.from_address);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
