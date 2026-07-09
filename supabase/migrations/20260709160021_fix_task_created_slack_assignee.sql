-- Ensure task-created Slack notifications can see the selected assignee.
-- The app inserts tasks first, then writes task_assignees. The Slack task-created
-- trigger also runs after task insert, so keep the join table in sync before
-- slack_notify_task_created executes.

CREATE OR REPLACE FUNCTION public.sync_task_assigned_to_on_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    INSERT INTO public.task_assignees (task_id, user_id)
    VALUES (NEW.id, NEW.assigned_to)
    ON CONFLICT (task_id, user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS aa_sync_task_assignee_on_task_insert ON public.tasks;
CREATE TRIGGER aa_sync_task_assignee_on_task_insert
  AFTER INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_assigned_to_on_insert();

-- Backfill any older tasks where the legacy single-assignee column was populated
-- but the multi-assignee join row is missing.
INSERT INTO public.task_assignees (task_id, user_id)
SELECT t.id, t.assigned_to
FROM public.tasks t
WHERE t.assigned_to IS NOT NULL
ON CONFLICT (task_id, user_id) DO NOTHING;
