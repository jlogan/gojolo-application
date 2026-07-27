-- Server-side recipient checks for inbox thread email/Slack notifications.
-- DB triggers (1594cd3) hardened queue inserts; external delivery uses process-user-notification
-- which must enforce the same rules before Resend/Slack fan-out.

CREATE OR REPLACE FUNCTION public.validate_inbox_notification_recipient(
  p_user_id uuid,
  p_org_id uuid,
  p_event_type text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id uuid;
  v_comment_id uuid;
BEGIN
  IF p_event_type NOT IN ('thread_assigned', 'mentioned_in_thread') THEN
    RETURN true;
  END IF;

  IF p_user_id IS NULL OR p_org_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.org_id = p_org_id AND ou.user_id = p_user_id
  ) THEN
    RETURN false;
  END IF;

  v_thread_id := NULLIF(trim(p_payload->>'thread_id'), '')::uuid;
  IF v_thread_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inbox_threads t
    WHERE t.id = v_thread_id AND t.org_id = p_org_id
  ) THEN
    RETURN false;
  END IF;

  IF p_event_type = 'thread_assigned' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.inbox_thread_assignments a
      WHERE a.thread_id = v_thread_id AND a.user_id = p_user_id
    );
  END IF;

  -- mentioned_in_thread: recipient must appear in mentions on the cited comment, or on a recent comment.
  v_comment_id := NULLIF(trim(p_payload->>'comment_id'), '')::uuid;
  IF v_comment_id IS NOT NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.inbox_comments c
      WHERE c.id = v_comment_id
        AND c.thread_id = v_thread_id
        AND p_user_id = ANY(c.mentions)
        AND c.user_id <> p_user_id
    );
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.inbox_comments c
    WHERE c.thread_id = v_thread_id
      AND p_user_id = ANY(c.mentions)
      AND c.user_id <> p_user_id
      AND c.created_at > now() - interval '30 minutes'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.validate_inbox_notification_recipient(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_inbox_notification_recipient(uuid, uuid, text, jsonb) TO service_role;

-- In-app thread assignment only (Slack/email via client -> process-user-notification).
CREATE OR REPLACE FUNCTION public.notify_in_app_thread_assigned()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_subject text;
  v_assigner_name text;
BEGIN
  IF NEW.user_id = auth.uid() THEN
    RETURN NEW;
  END IF;

  SELECT t.org_id, COALESCE(t.subject, '(No subject)') INTO v_org_id, v_subject
  FROM public.inbox_threads t WHERE t.id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.org_id = v_org_id AND ou.user_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_assigner_name
  FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1;

  INSERT INTO public.notifications (org_id, user_id, type, title, body, link)
  VALUES (
    v_org_id,
    NEW.user_id,
    'assignment',
    COALESCE(v_assigner_name, 'Someone') || ' assigned you a thread',
    v_subject,
    '/inbox/' || NEW.thread_id
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS enqueue_thread_assigned ON public.inbox_thread_assignments;
DROP TRIGGER IF EXISTS notify_in_app_thread_assigned ON public.inbox_thread_assignments;
CREATE TRIGGER notify_in_app_thread_assigned
  AFTER INSERT ON public.inbox_thread_assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_in_app_thread_assigned();

-- Ensure stale queue triggers stay disabled for inbox events (external delivery is client-direct).
DROP TRIGGER IF EXISTS enqueue_mentioned_in_thread ON public.inbox_comments;
