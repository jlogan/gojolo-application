-- User notification delivery: queue + triggers. Processed by Edge Function (Slack + Resend email).

-- Queue table: one row per notification to send
CREATE TABLE IF NOT EXISTS public.notification_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('task_assigned', 'thread_assigned', 'mentioned_in_thread')),
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX idx_notification_queue_sent ON public.notification_queue(sent_at) WHERE sent_at IS NULL;
CREATE INDEX idx_notification_queue_created ON public.notification_queue(created_at);

ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;

-- Service role (Edge Function) can select and update for processing
CREATE POLICY "nq_select_service" ON public.notification_queue FOR SELECT TO service_role USING (true);
CREATE POLICY "nq_update_service" ON public.notification_queue FOR UPDATE TO service_role USING (true) WITH CHECK (true);

-- Triggers run as the user who performed the action; allow insert when that user is in the same org as the notification's org
CREATE POLICY "nq_insert_org_member" ON public.notification_queue FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Config for invoking Edge Function from triggers (set via Dashboard or SQL)
CREATE TABLE IF NOT EXISTS public.app_config (
  key text PRIMARY KEY,
  value text
);

COMMENT ON TABLE public.app_config IS 'Key-value config. Keys: supabase_url (e.g. https://xxx.supabase.co), notification_internal_secret (must match NOTIFICATION_INTERNAL_SECRET in Supabase secrets).';

-- Enqueue when a task is assigned to a user
CREATE OR REPLACE FUNCTION public.enqueue_task_assigned_notification()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_project_id uuid;
  v_task_title text;
  v_assigner_name text;
BEGIN
  SELECT t.org_id, t.project_id, t.title INTO v_org_id, v_project_id, v_task_title
  FROM tasks t WHERE t.id = NEW.task_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_assigner_name
  FROM profiles p WHERE p.id = auth.uid() LIMIT 1;

  INSERT INTO public.notification_queue (user_id, org_id, event_type, payload)
  VALUES (
    NEW.user_id,
    v_org_id,
    'task_assigned',
    jsonb_build_object(
      'task_id', NEW.task_id,
      'project_id', v_project_id,
      'task_title', v_task_title,
      'assigner_name', v_assigner_name
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS enqueue_task_assigned ON public.task_assignees;
CREATE TRIGGER enqueue_task_assigned
  AFTER INSERT ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_task_assigned_notification();

-- Enqueue when a thread is assigned to a user
CREATE OR REPLACE FUNCTION public.enqueue_thread_assigned_notification()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_subject text;
  v_assigner_name text;
BEGIN
  SELECT t.org_id, COALESCE(t.subject, '(No subject)') INTO v_org_id, v_subject
  FROM inbox_threads t WHERE t.id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_assigner_name
  FROM profiles p WHERE p.id = auth.uid() LIMIT 1;

  INSERT INTO public.notification_queue (user_id, org_id, event_type, payload)
  VALUES (
    NEW.user_id,
    v_org_id,
    'thread_assigned',
    jsonb_build_object(
      'thread_id', NEW.thread_id,
      'subject', v_subject,
      'assigner_name', v_assigner_name
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS enqueue_thread_assigned ON public.inbox_thread_assignments;
CREATE TRIGGER enqueue_thread_assigned
  AFTER INSERT ON public.inbox_thread_assignments
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_thread_assigned_notification();

-- Enqueue when a user is @mentioned in an inbox comment
CREATE OR REPLACE FUNCTION public.enqueue_mentioned_in_thread_notification()
RETURNS trigger AS $$
DECLARE
  v_mentioned_id uuid;
  v_org_id uuid;
  v_subject text;
  v_commenter_name text;
  v_content_preview text;
BEGIN
  IF NEW.mentions IS NULL OR array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT org_id, COALESCE(subject, '(No subject)') INTO v_org_id, v_subject
  FROM inbox_threads WHERE id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, email, 'Someone') INTO v_commenter_name FROM profiles WHERE id = NEW.user_id;
  v_content_preview := left(NEW.content, 200);
  IF length(NEW.content) > 200 THEN v_content_preview := v_content_preview || '...'; END IF;

  FOREACH v_mentioned_id IN ARRAY NEW.mentions LOOP
    IF v_mentioned_id <> NEW.user_id THEN
      INSERT INTO public.notification_queue (user_id, org_id, event_type, payload)
      VALUES (
        v_mentioned_id,
        v_org_id,
        'mentioned_in_thread',
        jsonb_build_object(
          'thread_id', NEW.thread_id,
          'subject', v_subject,
          'commenter_name', v_commenter_name,
          'content_preview', v_content_preview
        )
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS enqueue_mentioned_in_thread ON public.inbox_comments;
CREATE TRIGGER enqueue_mentioned_in_thread
  AFTER INSERT ON public.inbox_comments
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_mentioned_in_thread_notification();

-- Invoke Edge Function when a row is added to the queue (requires app_config.supabase_url and app_config.notification_internal_secret)
CREATE OR REPLACE FUNCTION public.notification_queue_invoke_processor()
RETURNS trigger AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT value INTO v_url FROM public.app_config WHERE key = 'supabase_url' LIMIT 1;
  SELECT value INTO v_secret FROM public.app_config WHERE key = 'notification_internal_secret' LIMIT 1;
  IF v_url IS NULL OR trim(v_url) = '' OR v_secret IS NULL OR trim(v_secret) = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := trim(trailing '/' from v_url) || '/functions/v1/process-user-notification',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object('queue_id', NEW.id)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS notification_queue_invoke ON public.notification_queue;
CREATE TRIGGER notification_queue_invoke
  AFTER INSERT ON public.notification_queue
  FOR EACH ROW EXECUTE FUNCTION public.notification_queue_invoke_processor();
