-- Add sender name and email date/time (EST) to Slack notifications for new thread and new message.
-- Name: from contact lookup or parsed from "Name <email>" format; date uses received_at in EST.
CREATE OR REPLACE FUNCTION public.notify_slack_on_new_message()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_config record;
  v_project_channel text;
  v_channel text;
  v_body jsonb;
  v_thread_url text;
  v_subject text;
  v_from text;
  v_email text;
  v_name text;
  v_sender_line text;
  v_email_date text;
  v_tz text;
  v_first_message boolean;
BEGIN
  IF NEW.channel <> 'email' THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (channel=%)', NEW.id, NEW.channel;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    SELECT NEW.thread_id, t.org_id, 'skipped', 'not_email', t.subject, NEW.from_identifier, 'message'
    FROM inbox_threads t WHERE t.id = NEW.thread_id LIMIT 1;
    RETURN NEW;
  END IF;

  -- Only send when the email is from a contact (inbound), not when we sent it (outbound).
  IF NEW.direction <> 'inbound' THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (outbound, not from contact)', NEW.id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    SELECT NEW.thread_id, t.org_id, 'skipped', 'outbound', t.subject, NEW.from_identifier, 'message'
    FROM inbox_threads t WHERE t.id = NEW.thread_id LIMIT 1;
    RETURN NEW;
  END IF;

  SELECT t.org_id INTO v_org_id FROM inbox_threads t WHERE t.id = NEW.thread_id;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (no thread %)', NEW.id, NEW.thread_id;
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

  -- Project channel when thread has contacts linked to a project with Slack channel (SlackChannelPicker).
  SELECT spc.channel_id INTO v_project_channel
  FROM inbox_thread_contacts itc
  JOIN project_contacts pc ON pc.contact_id = itc.contact_id
  JOIN slack_project_channels spc ON spc.project_id = pc.project_id
  WHERE itc.thread_id = NEW.thread_id
  LIMIT 1;

  v_channel := COALESCE(v_project_channel, public.slack_channel_for_api(v_config.inbox_channel), public.slack_channel_for_api(v_config.default_channel));

  IF v_channel IS NULL THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (no channel for org %)', NEW.id, v_org_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'skipped', 'no_channel', (SELECT subject FROM inbox_threads WHERE id = NEW.thread_id LIMIT 1), NEW.from_identifier, 'message');
    RETURN NEW;
  END IF;

  SELECT COALESCE(t.subject, '(No subject)') INTO v_subject FROM inbox_threads t WHERE t.id = NEW.thread_id;
  v_from := COALESCE(NEW.from_identifier, '');

  -- Extract email from "Name <email>" or use whole string
  v_email := COALESCE((regexp_match(v_from, '<([^>]+)>'))[1], v_from);

  -- Resolve display name: contact name, or parsed from "Name <email>", or email
  SELECT c.name INTO v_name FROM contacts c WHERE c.org_id = v_org_id AND LOWER(trim(c.email)) = LOWER(trim(v_email)) LIMIT 1;
  IF v_name IS NULL THEN
    SELECT c.name INTO v_name FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id WHERE c.org_id = v_org_id AND LOWER(trim(ce.email)) = LOWER(trim(v_email)) LIMIT 1;
  END IF;
  IF v_name IS NULL AND v_from ~ '<[^>]+>' THEN
    v_name := trim(regexp_replace(v_from, '\s*<[^>]+>\s*$', ''));
  END IF;
  -- Fallback: derive name from domain when only email is available (e.g. noreply@emails.brogrammersagency.com -> Brogrammersagency)
  IF v_name IS NULL OR trim(v_name) = '' OR v_name = v_email THEN
    v_name := initcap(regexp_replace(
      coalesce(regexp_replace(coalesce((regexp_match(v_email, '@([^@]+)$'))[1], ''), '^(emails?|mail|smtp)\.', '', 'i'), ''),
      '\.[a-z]{2,}$', '', 'i'
    ));
  END IF;
  v_name := COALESCE(NULLIF(trim(v_name), ''), v_email);

  -- Sender line: only show when name differs from email
  v_sender_line := CASE WHEN v_name <> v_email AND trim(v_name) <> '' THEN E'\n' || '*Sender:* ' || public.slack_escape_mrkdwn(v_name) ELSE '' END;

  -- Email date in EST (America/New_York); use received_at, not server time
  v_tz := 'America/New_York';
  v_email_date := to_char((COALESCE(NEW.received_at, now())) AT TIME ZONE v_tz, 'Mon DD, YYYY') || ' at ' || to_char((COALESCE(NEW.received_at, now())) AT TIME ZONE v_tz, 'HH12:MI AM');

  v_thread_url := 'https://app.gojolo.io/inbox/' || NEW.thread_id;
  v_first_message := (SELECT COUNT(*) FROM inbox_messages WHERE thread_id = NEW.thread_id) <= 1;

  -- Idempotency: only one "New email thread" per thread (avoids duplicate if thread trigger also sent or message inserted twice).
  IF v_first_message AND EXISTS (SELECT 1 FROM public.slack_notification_log WHERE thread_id = NEW.thread_id AND outcome = 'sent' LIMIT 1) THEN
    RAISE NOTICE 'slack_notify_new_message: msg % skipped (already sent for thread %, avoiding duplicate)', NEW.id, NEW.thread_id;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, skip_reason, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'skipped', 'already_sent_for_thread', v_subject, v_from, 'message');
    RETURN NEW;
  END IF;

  IF v_config.bot_token IS NOT NULL THEN
    IF v_first_message THEN
      RAISE NOTICE 'slack_notify_new_message: msg % sending New email thread via bot to channel %', NEW.id, v_channel;
      v_body := jsonb_build_object(
        'channel', v_channel,
        'text', '📧 New thread: ' || v_subject || ' from ' || v_name,
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '📧 *New email thread*' || E'\n' || '*Thread:* ' || public.slack_escape_mrkdwn(v_subject) || E'\n' || '*From:* ' || public.slack_escape_mrkdwn(v_email) || v_sender_line || E'\n' || '*Date:* ' || v_email_date
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
    ELSE
      RAISE NOTICE 'slack_notify_new_message: msg % sending New email message via bot to channel %', NEW.id, v_channel;
      v_body := jsonb_build_object(
        'channel', v_channel,
        'text', '📧 New message: ' || v_subject || ' from ' || v_name,
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'section',
            'text', jsonb_build_object(
              'type', 'mrkdwn',
              'text', '📧 *New email message*' || E'\n' || '*Thread:* ' || public.slack_escape_mrkdwn(v_subject) || E'\n' || '*From:* ' || public.slack_escape_mrkdwn(v_email) || v_sender_line || E'\n' || '*Date:* ' || v_email_date
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
    END IF;
    PERFORM net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_config.bot_token),
      body := v_body
    );
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, channel, method, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'sent', v_channel, 'bot', v_subject, v_from, 'message');
  ELSIF v_config.webhook_url IS NOT NULL THEN
    IF v_first_message THEN
      RAISE NOTICE 'slack_notify_new_message: msg % sending New email thread via webhook to channel %', NEW.id, v_channel;
      PERFORM net.http_post(
        url := v_config.webhook_url,
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object(
          'channel', v_channel,
          'text', '📧 New thread: *' || v_subject || '* from ' || v_name || ' (' || v_email_date || ') — <' || v_thread_url || '|View in jolo>',
          'unfurl_links', false
        )
      );
    ELSE
      RAISE NOTICE 'slack_notify_new_message: msg % sending New email message via webhook to channel %', NEW.id, v_channel;
      PERFORM net.http_post(
        url := v_config.webhook_url,
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object(
          'channel', v_channel,
          'text', '📧 New message: *' || v_subject || '* from ' || v_name || ' (' || v_email_date || ') — <' || v_thread_url || '|View in jolo>',
          'unfurl_links', false
        )
      );
    END IF;
    INSERT INTO public.slack_notification_log (thread_id, org_id, outcome, channel, method, subject, from_address, trigger_type)
    VALUES (NEW.thread_id, v_org_id, 'sent', v_channel, 'webhook', v_subject, v_from, 'message');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
