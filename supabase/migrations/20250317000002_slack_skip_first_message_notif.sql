-- Skip Slack notification for the first message in a thread; the new-thread trigger already sent "New email thread".
CREATE OR REPLACE FUNCTION public.notify_slack_on_new_message()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_config record;
  v_channel text;
  v_body jsonb;
  v_thread_url text;
  v_subject text;
  v_from text;
BEGIN
  IF NEW.channel <> 'email' THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (channel=%)', NEW.id, NEW.channel;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    SELECT NEW.thread_id, t.org_id, 'skipped', 'not_email', t.subject, NEW.from_identifier, 'message'
    FROM inbox_threads t WHERE t.id = NEW.thread_id LIMIT 1;
    RETURN NEW;
  END IF;

  SELECT t.org_id INTO v_org_id FROM inbox_threads t WHERE t.id = NEW.thread_id;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (no thread %)', NEW.id, NEW.thread_id;
    RETURN NEW;
  END IF;

  -- First message in thread: thread trigger already sent "New email thread"; skip duplicate.
  IF (SELECT COUNT(*) FROM inbox_messages WHERE thread_id = NEW.thread_id) <= 1 THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (first message in thread, thread already notified)', NEW.id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    SELECT NEW.thread_id, v_org_id, 'skipped', 'first_message_in_thread', t.subject, NEW.from_identifier, 'message'
    FROM inbox_threads t WHERE t.id = NEW.thread_id LIMIT 1;
    RETURN NEW;
  END IF;

  SELECT * INTO v_config FROM slack_configs
  WHERE org_id = v_org_id AND is_active = true AND notify_on_new_email = true LIMIT 1;

  IF v_config IS NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (no active config for org %)', NEW.id, v_org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    SELECT NEW.thread_id, v_org_id, 'skipped', 'no_config', t.subject, NEW.from_identifier, 'message'
    FROM inbox_threads t WHERE t.id = NEW.thread_id LIMIT 1;
    RETURN NEW;
  END IF;

  IF v_config.bot_token IS NULL AND v_config.webhook_url IS NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (no bot_token or webhook_url for org %)', NEW.id, v_org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    SELECT NEW.thread_id, v_org_id, 'skipped', 'no_credentials', t.subject, NEW.from_identifier, 'message'
    FROM inbox_threads t WHERE t.id = NEW.thread_id LIMIT 1;
    RETURN NEW;
  END IF;

  SELECT COALESCE(t.subject, '(No subject)') INTO v_subject FROM inbox_threads t WHERE t.id = NEW.thread_id;
  v_from := COALESCE(NEW.from_identifier, '');
  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.thread_id;
  v_channel := COALESCE(v_config.inbox_channel, v_config.default_channel);

  IF v_channel IS NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (no channel for org %)', NEW.id, v_org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'skipped', 'no_channel', v_subject, v_from, 'message');
    RETURN NEW;
  END IF;

  IF v_config.bot_token IS NOT NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % sending via bot to channel %', NEW.id, v_channel;
    v_body := jsonb_build_object(
      'channel', v_channel,
      'text', '📧 New message: ' || v_subject || ' from ' || v_from,
      'blocks', jsonb_build_array(
        jsonb_build_object(
          'type', 'section',
          'text', jsonb_build_object(
            'type', 'mrkdwn',
            'text', '📧 *New email message*' || E'\n' || '*From:* ' || v_from || E'\n' || '*Thread:* ' || v_subject
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
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, channel, method, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'sent', v_channel, 'bot', v_subject, v_from, 'message');
  ELSIF v_config.webhook_url IS NOT NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % sending via webhook to channel %', NEW.id, v_channel;
    PERFORM net.http_post(
      url := v_config.webhook_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'channel', v_channel,
        'text', '📧 New message: *' || v_subject || '* from ' || v_from || ' — <' || v_thread_url || '|View in jolo>',
        'unfurl_links', false
      )
    );
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, channel, method, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'sent', v_channel, 'webhook', v_subject, v_from, 'message');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
