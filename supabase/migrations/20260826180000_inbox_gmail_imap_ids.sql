-- Gmail IMAP thread/message IDs (X-GM-THRID / X-GM-MSGID via ImapFlow threadId + emailId)
-- for building Gmail web direct links without the Gmail API.

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS gmail_thread_id text,
  ADD COLUMN IF NOT EXISTS gmail_message_id text;

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS gmail_thread_id text;

COMMENT ON COLUMN public.inbox_messages.gmail_thread_id IS 'Gmail X-GM-THRID from IMAP (ImapFlow threadId); decimal string for #inbox/{id} links.';
COMMENT ON COLUMN public.inbox_messages.gmail_message_id IS 'Gmail X-GM-MSGID from IMAP (ImapFlow emailId); for per-message Gmail links.';
COMMENT ON COLUMN public.inbox_threads.gmail_thread_id IS 'Derived from latest non-draft message gmail_thread_id in the thread.';

CREATE INDEX IF NOT EXISTS idx_inbox_messages_gmail_message_id
  ON public.inbox_messages (imap_account_id, gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_threads_gmail_thread_id
  ON public.inbox_threads (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_inbox_thread_gmail_ids(p_thread_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.inbox_threads t
  SET
    gmail_thread_id = sub.gmail_thread_id,
    updated_at = now()
  FROM (
    SELECT m.gmail_thread_id
    FROM public.inbox_messages m
    WHERE m.thread_id = p_thread_id
      AND m.gmail_thread_id IS NOT NULL
      AND btrim(m.gmail_thread_id) <> ''
    ORDER BY
      CASE WHEN COALESCE(m.is_draft, false) = false THEN 0 ELSE 1 END,
      m.received_at DESC,
      m.id DESC
    LIMIT 1
  ) sub
  WHERE t.id = p_thread_id;
$$;

GRANT EXECUTE ON FUNCTION public.sync_inbox_thread_gmail_ids(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_inbox_thread_gmail_ids(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_inbox_message_gmail_id_states(
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
      NULLIF(btrim(item->>'gmail_thread_id'), '') AS gmail_thread_id,
      NULLIF(btrim(item->>'gmail_message_id'), '') AS gmail_message_id
    FROM jsonb_array_elements(p_states) AS item
    WHERE item ? 'uid'
      AND item->>'uid' ~ '^[0-9]+$'
  ),
  updated AS (
    UPDATE public.inbox_messages m
    SET
      gmail_thread_id = COALESCE(p.gmail_thread_id, m.gmail_thread_id),
      gmail_message_id = COALESCE(p.gmail_message_id, m.gmail_message_id)
    FROM parsed p
    WHERE m.imap_account_id = p_imap_account_id
      AND m.external_uid = p.uid
      AND (
        (p.gmail_thread_id IS NOT NULL AND p.gmail_thread_id IS DISTINCT FROM m.gmail_thread_id)
        OR (p.gmail_message_id IS NOT NULL AND p.gmail_message_id IS DISTINCT FROM m.gmail_message_id)
      )
    RETURNING m.thread_id
  ),
  synced AS (
    SELECT public.sync_inbox_thread_gmail_ids(thread_id)
    FROM (SELECT DISTINCT thread_id FROM updated WHERE thread_id IS NOT NULL) d
  )
  SELECT count(*) INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_inbox_message_gmail_id_states(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_inbox_message_gmail_id_states(uuid, jsonb) TO service_role;
