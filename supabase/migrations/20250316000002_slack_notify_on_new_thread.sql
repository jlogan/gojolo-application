-- Slack notification on new thread (INSERT inbox_threads) instead of per-message.
-- Fires as soon as imap-sync creates a thread (headers only); one notification per new conversation.

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
  IF NEW.channel <> 'email' THEN RETURN NEW; END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = NEW.org_id AND is_active = true AND notify_on_new_email = true LIMIT 1;

  IF v_config IS NULL THEN RETURN NEW; END IF;
  IF v_config.bot_token IS NULL AND v_config.webhook_url IS NULL THEN RETURN NEW; END IF;

  v_subject := COALESCE(NEW.subject, '(No subject)');
  v_from := COALESCE(NEW.from_address, '');
  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.id;
  v_channel := COALESCE(v_config.inbox_channel, v_config.default_channel);

  IF v_channel IS NULL THEN RETURN NEW; END IF;

  IF v_config.bot_token IS NOT NULL THEN
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
  ELSIF v_config.webhook_url IS NOT NULL THEN
    PERFORM net.http_post(
      url := v_config.webhook_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'channel', v_channel,
        'text', '📧 New thread: *' || v_subject || '* from ' || v_from || ' — <' || v_thread_url || '|View in jolo>',
        'unfurl_links', false
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS slack_notify_new_message ON public.inbox_messages;
DROP TRIGGER IF EXISTS slack_notify_new_thread ON public.inbox_threads;
CREATE TRIGGER slack_notify_new_thread
  AFTER INSERT ON public.inbox_threads
  FOR EACH ROW EXECUTE FUNCTION public.notify_slack_on_new_thread();
