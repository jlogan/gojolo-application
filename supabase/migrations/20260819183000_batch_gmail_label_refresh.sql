-- Batch-refresh Gmail label state for existing synced messages by IMAP UID.

CREATE OR REPLACE FUNCTION public.refresh_inbox_message_gmail_label_states(
  p_imap_account_id uuid,
  p_states jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_states IS NULL OR jsonb_typeof(p_states) <> 'array' THEN
    RETURN 0;
  END IF;

  WITH parsed AS (
    SELECT
      (item->>'uid')::bigint AS uid,
      NULLIF(item->>'in_gmail_inbox', '')::boolean AS in_gmail_inbox,
      ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(item->'gmail_labels', '[]'::jsonb))
        ORDER BY 1
      )::text[] AS gmail_labels
    FROM jsonb_array_elements(p_states) AS item
    WHERE item ? 'uid'
      AND item->>'uid' ~ '^[0-9]+$'
  ),
  updated AS (
    UPDATE public.inbox_messages m
    SET
      gmail_labels = CASE
        WHEN array_length(p.gmail_labels, 1) IS NULL THEN NULL
        ELSE p.gmail_labels
      END,
      in_gmail_inbox = COALESCE(p.in_gmail_inbox, true)
    FROM parsed p
    WHERE m.imap_account_id = p_imap_account_id
      AND m.external_uid = p.uid
    RETURNING m.thread_id
  ),
  synced AS (
    SELECT public.sync_inbox_thread_gmail_labels(thread_id)
    FROM (SELECT DISTINCT thread_id FROM updated WHERE thread_id IS NOT NULL) d
  )
  SELECT count(*) INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_inbox_message_gmail_label_states(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_inbox_message_gmail_label_states(uuid, jsonb) TO service_role;
