-- IMAP/sync: new mail must not reopen threads the user closed or moved to trash.
CREATE OR REPLACE FUNCTION public.touch_inbox_thread_on_new_message(
  p_thread_id uuid,
  p_last_message_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.inbox_threads
  SET
    last_message_at = p_last_message_at,
    updated_at = p_last_message_at,
    status = CASE
      WHEN status IN ('closed', 'archived') THEN status
      ELSE 'open'
    END
  WHERE id = p_thread_id;
$$;

COMMENT ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz) IS
  'Called from Edge IMAP sync when attaching a new message to an existing thread; preserves closed/archived status.';

REVOKE ALL ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz) TO service_role;
