-- Clean up orphan email threads (threads with no inbox_messages rows).
-- These are created by imap-sync when batch message insert fails after thread insert succeeds.
-- Safe to delete: they have no messages, attachments, comments, or assignments.
-- Returns count of deleted threads.
CREATE OR REPLACE FUNCTION public.cleanup_orphan_email_threads(
  p_org_id uuid,
  p_older_than_minutes int DEFAULT 5,
  p_limit int DEFAULT 500
)
RETURNS TABLE (deleted_count int, thread_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff timestamptz;
  v_ids uuid[];
BEGIN
  v_cutoff := now() - (p_older_than_minutes || ' minutes')::interval;

  -- Find orphan threads: email channel, no messages, older than cutoff
  SELECT array_agg(t.id)
  INTO v_ids
  FROM public.inbox_threads t
  WHERE t.org_id = p_org_id
    AND t.channel = 'email'
    AND t.created_at < v_cutoff
    AND NOT EXISTS (
      SELECT 1 FROM public.inbox_messages m WHERE m.thread_id = t.id
    )
  LIMIT p_limit;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 0, '{}'::uuid[];
    RETURN;
  END IF;

  -- Delete orphans (slack_notification_log rows will have thread_id set to NULL via ON DELETE SET NULL)
  DELETE FROM public.inbox_threads WHERE id = ANY(v_ids);

  RETURN QUERY SELECT array_length(v_ids, 1), v_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_orphan_email_threads(uuid, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_email_threads(uuid, int, int) TO service_role;

COMMENT ON FUNCTION public.cleanup_orphan_email_threads IS
  'Delete email threads with zero inbox_messages older than p_older_than_minutes minutes. '
  'Created to recover from imap-sync partial failures that leave threads without messages.';
