-- In-app notifications for task and thread assignments (Slack/email still via notification_queue only).

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

  INSERT INTO notifications (org_id, user_id, type, title, body, link)
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

  INSERT INTO notifications (org_id, user_id, type, title, body, link)
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
