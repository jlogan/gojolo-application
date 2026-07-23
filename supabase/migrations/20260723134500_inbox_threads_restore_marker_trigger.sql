-- Keep restore marker correct no matter whether status is changed by the UI,
-- Myra/AI tools, or another backend path.
CREATE OR REPLACE FUNCTION public.set_inbox_thread_restore_marker()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'archived' THEN
    NEW.user_restored_at := NULL;
  ELSIF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    NEW.user_restored_at := COALESCE(NEW.user_restored_at, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_inbox_thread_restore_marker_on_status
  ON public.inbox_threads;

CREATE TRIGGER set_inbox_thread_restore_marker_on_status
  BEFORE UPDATE OF status ON public.inbox_threads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_inbox_thread_restore_marker();
