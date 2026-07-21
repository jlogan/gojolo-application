-- Skip self-mentions and dedupe mention IDs in inbox comment in-app notifications.
CREATE OR REPLACE FUNCTION public.notify_on_mention()
RETURNS trigger AS $$
DECLARE
  v_mentioned_id uuid;
  v_thread_subject text;
  v_commenter_name text;
  v_org_id uuid;
BEGIN
  IF NEW.mentions IS NULL OR array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT org_id INTO v_org_id FROM inbox_threads WHERE id = NEW.thread_id;
  SELECT COALESCE(subject, '(No subject)') INTO v_thread_subject FROM inbox_threads WHERE id = NEW.thread_id;
  SELECT display_name INTO v_commenter_name FROM profiles WHERE id = NEW.user_id;

  FOR v_mentioned_id IN SELECT DISTINCT unnest(NEW.mentions) LOOP
    IF v_mentioned_id <> NEW.user_id THEN
      INSERT INTO notifications (org_id, user_id, type, title, body, link)
      VALUES (
        v_org_id,
        v_mentioned_id,
        'mention',
        COALESCE(v_commenter_name, 'Someone') || ' mentioned you',
        'In thread: ' || v_thread_subject,
        '/inbox/' || NEW.thread_id
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
