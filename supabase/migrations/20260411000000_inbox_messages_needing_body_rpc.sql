-- Used by backfill-empty-bodies Edge Function (service role): find messages with no usable body yet.
-- Includes messages with imap_account_id = p_account_id OR null (orphans on org threads).
CREATE OR REPLACE FUNCTION public.inbox_messages_needing_body_for_account(
  p_account_id uuid,
  p_org_id uuid,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  thread_id uuid,
  external_uid bigint,
  body text,
  html_body text,
  direction text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.thread_id, m.external_uid, m.body, m.html_body, m.direction
  FROM public.inbox_messages m
  INNER JOIN public.inbox_threads t ON t.id = m.thread_id
  WHERE (m.imap_account_id = p_account_id OR m.imap_account_id IS NULL)
    AND t.org_id = p_org_id
    AND m.channel = 'email'
    AND m.external_uid IS NOT NULL
    AND (coalesce(trim(m.body), '') = '' AND coalesce(trim(m.html_body), '') = '')
  ORDER BY m.received_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 50);
$$;

REVOKE ALL ON FUNCTION public.inbox_messages_needing_body_for_account(uuid, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inbox_messages_needing_body_for_account(uuid, uuid, int) TO service_role;
