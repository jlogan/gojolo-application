-- Inbound IMAP/app mail on a closed thread should re-open it (same as UI "Re-open").
-- Trash (archived) stays archived. Outbound-only touches keep closed threads closed.
DROP FUNCTION IF EXISTS public.touch_inbox_thread_on_new_message(uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.touch_inbox_thread_on_new_message(
  p_thread_id uuid,
  p_last_message_at timestamptz,
  p_is_inbound boolean DEFAULT true
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
      WHEN status = 'archived' THEN status
      WHEN status = 'closed' AND NOT p_is_inbound THEN status
      ELSE 'open'
    END
  WHERE id = p_thread_id;
$$;

COMMENT ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz, boolean) IS
  'Called when new mail is attached to a thread: updates last_message_at. Re-opens closed threads on inbound activity only; preserves archived (trash) and closed+outbound.';

REVOKE ALL ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz, boolean) TO service_role;
