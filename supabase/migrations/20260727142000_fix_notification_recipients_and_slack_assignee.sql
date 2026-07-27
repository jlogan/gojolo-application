-- Fix task-created Slack firing before assignees exist (shows "Assigned To: Not set")
-- and harden assignment/mention notification recipient checks.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS slack_task_created_notified_at timestamptz;

-- Task insert: only Slack immediately for truly unassigned tasks (no assignees coming on same row).
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_created()
RETURNS trigger AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.slack_task_created_notified THEN
    RETURN NEW;
  END IF;

  PERFORM public.notify_slack_task_created_by_id(NEW.id);
  UPDATE public.tasks
  SET slack_task_created_notified = true,
      slack_task_created_notified_at = now()
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- After assignees are inserted: send initial alert, or re-send if Slack went out before assignees existed.
CREATE OR REPLACE FUNCTION public.notify_slack_on_task_assignees_inserted()
RETURNS trigger AS $$
DECLARE
  r record;
  v_first_assignee_at timestamptz;
BEGIN
  FOR r IN
    SELECT DISTINCT i.task_id
    FROM inserted i
    JOIN public.tasks t ON t.id = i.task_id
    WHERE t.created_at > now() - interval '1 hour'
  LOOP
    SELECT min(ta.created_at) INTO v_first_assignee_at
    FROM public.task_assignees ta
    WHERE ta.task_id = r.task_id;

    IF v_first_assignee_at IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT (SELECT slack_task_created_notified FROM public.tasks WHERE id = r.task_id) THEN
      PERFORM public.notify_slack_task_created_by_id(r.task_id);
      UPDATE public.tasks
      SET slack_task_created_notified = true,
          slack_task_created_notified_at = now()
      WHERE id = r.task_id;
    ELSIF (SELECT slack_task_created_notified_at FROM public.tasks WHERE id = r.task_id) < v_first_assignee_at THEN
      -- Slack was sent before assignee rows existed; send a corrected alert with assignee names.
      PERFORM public.notify_slack_task_created_by_id(r.task_id);
      UPDATE public.tasks
      SET slack_task_created_notified_at = now()
      WHERE id = r.task_id;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Atomic task create: insert task + all assignees in one transaction so Slack sees every assignee.
CREATE OR REPLACE FUNCTION public.create_task_with_assignees(
  p_project_id uuid,
  p_org_id uuid,
  p_title text,
  p_description text,
  p_status text,
  p_priority text,
  p_due_date date,
  p_assignee_ids uuid[],
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid;
  v_primary uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.org_id = p_org_id AND ou.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Project not found in organization';
  END IF;

  SELECT uid INTO v_primary
  FROM unnest(COALESCE(p_assignee_ids, ARRAY[]::uuid[])) AS uid
  WHERE EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.org_id = p_org_id AND ou.user_id = uid
  )
  LIMIT 1;

  INSERT INTO public.tasks (
    project_id, org_id, title, description, status, priority, due_date, assigned_to, created_by
  )
  VALUES (
    p_project_id, p_org_id, p_title, p_description, p_status, p_priority, p_due_date, v_primary, p_created_by
  )
  RETURNING id INTO v_task_id;

  IF p_assignee_ids IS NOT NULL AND array_length(p_assignee_ids, 1) > 0 THEN
    INSERT INTO public.task_assignees (task_id, user_id)
    SELECT v_task_id, uid
    FROM (
      SELECT DISTINCT uid
      FROM unnest(p_assignee_ids) AS uid
      WHERE EXISTS (
        SELECT 1 FROM public.organization_users ou
        WHERE ou.org_id = p_org_id AND ou.user_id = uid
      )
    ) valid_assignees;
  END IF;

  RETURN v_task_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_task_with_assignees(uuid, uuid, text, text, text, text, date, uuid[], uuid) TO authenticated;

-- Task assignment notifications: only enqueue/notify actual org members (never broadcast).
CREATE OR REPLACE FUNCTION public.enqueue_task_assigned_notification()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_project_id uuid;
  v_task_title text;
  v_assigner_name text;
BEGIN
  IF NEW.user_id = auth.uid() THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.org_id = (
      SELECT t.org_id FROM public.tasks t WHERE t.id = NEW.task_id
    )
    AND ou.user_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT t.org_id, t.project_id, t.title INTO v_org_id, v_project_id, v_task_title
  FROM public.tasks t WHERE t.id = NEW.task_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(p.display_name, p.email, 'Someone') INTO v_assigner_name
  FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1;

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

  INSERT INTO public.notifications (org_id, user_id, type, title, body, link)
  VALUES (
    v_org_id,
    NEW.user_id,
    'assignment',
    COALESCE(v_assigner_name, 'Someone') || ' assigned you a task',
    COALESCE(v_task_title, 'Task'),
    '/projects/' || v_project_id || '/tasks/' || NEW.task_id
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Thread assignment notifications: only notify the assigned org member (never project managers/watchers broadly).
CREATE OR REPLACE FUNCTION public.enqueue_thread_assigned_notification()
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

-- External inbox mention queue: dedupe IDs, skip self, and require same-org membership.
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
  FROM public.inbox_threads WHERE id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, email, 'Someone') INTO v_commenter_name FROM public.profiles WHERE id = NEW.user_id;
  v_content_preview := left(NEW.content, 200);
  IF length(NEW.content) > 200 THEN v_content_preview := v_content_preview || '...'; END IF;

  FOR v_mentioned_id IN SELECT DISTINCT unnest(NEW.mentions) LOOP
    IF v_mentioned_id <> NEW.user_id
       AND EXISTS (
         SELECT 1 FROM public.organization_users ou
         WHERE ou.org_id = v_org_id AND ou.user_id = v_mentioned_id
       ) THEN
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

-- Task comment mentions: dedupe IDs and skip self; only notify org members.
CREATE OR REPLACE FUNCTION public.notify_on_task_comment_mention()
RETURNS trigger AS $$
DECLARE
  v_mentioned_id uuid;
  v_task_title text;
  v_project_id uuid;
  v_org_id uuid;
  v_commenter_name text;
BEGIN
  IF NEW.mentions IS NULL OR array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.title, t.project_id, t.org_id
  INTO v_task_title, v_project_id, v_org_id
  FROM public.tasks t WHERE t.id = NEW.task_id;

  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, email, 'Someone') INTO v_commenter_name FROM public.profiles WHERE id = NEW.user_id;

  FOR v_mentioned_id IN SELECT DISTINCT unnest(NEW.mentions) LOOP
    IF v_mentioned_id <> NEW.user_id
       AND EXISTS (
         SELECT 1 FROM public.organization_users ou
         WHERE ou.org_id = v_org_id AND ou.user_id = v_mentioned_id
       ) THEN
      INSERT INTO public.notifications (org_id, user_id, type, title, body, link)
      VALUES (
        v_org_id,
        v_mentioned_id,
        'mention',
        COALESCE(v_commenter_name, 'Someone') || ' mentioned you',
        'In task: ' || COALESCE(v_task_title, 'Task'),
        '/projects/' || v_project_id || '/tasks/' || NEW.task_id
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Inbox comment mentions: only notify org members (defense-in-depth with client-side parsing fix).
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

  SELECT org_id INTO v_org_id FROM public.inbox_threads WHERE id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(subject, '(No subject)') INTO v_thread_subject FROM public.inbox_threads WHERE id = NEW.thread_id;
  SELECT display_name INTO v_commenter_name FROM public.profiles WHERE id = NEW.user_id;

  FOR v_mentioned_id IN SELECT DISTINCT unnest(NEW.mentions) LOOP
    IF v_mentioned_id <> NEW.user_id
       AND EXISTS (
         SELECT 1 FROM public.organization_users ou
         WHERE ou.org_id = v_org_id AND ou.user_id = v_mentioned_id
       ) THEN
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
