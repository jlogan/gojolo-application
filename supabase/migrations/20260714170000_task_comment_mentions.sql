-- Task comment @mentions: store mentioned user IDs and create in-app notifications on insert.
-- Slack/email delivery is handled client-direct via process-user-notification (same as inbox mentions).

ALTER TABLE public.task_comments
  ADD COLUMN IF NOT EXISTS mentions uuid[];

COMMENT ON COLUMN public.task_comments.mentions IS 'User IDs @mentioned in this comment. Populated by client on insert.';

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
  FROM tasks t WHERE t.id = NEW.task_id;

  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, email, 'Someone') INTO v_commenter_name FROM profiles WHERE id = NEW.user_id;

  FOREACH v_mentioned_id IN ARRAY NEW.mentions LOOP
    IF v_mentioned_id <> NEW.user_id THEN
      INSERT INTO notifications (org_id, user_id, type, title, body, link)
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

DROP TRIGGER IF EXISTS notify_on_task_comment_mention ON public.task_comments;
CREATE TRIGGER notify_on_task_comment_mention
  AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_task_comment_mention();
