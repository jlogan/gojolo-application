-- Outbound mail (CoachO reply / IMAP sent copy) closes threads; inbound re-opens closed. Trash unchanged.
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
      WHEN p_is_inbound THEN 'open'
      ELSE 'closed'
    END
  WHERE id = p_thread_id;
$$;

COMMENT ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz, boolean) IS
  'Updates last_message_at on new mail. Inbound re-opens closed threads; outbound closes; archived (trash) unchanged.';

REVOKE ALL ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_inbox_thread_on_new_message(uuid, timestamptz, boolean) TO service_role;
