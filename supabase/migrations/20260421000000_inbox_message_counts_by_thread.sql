-- One grouped query for message counts (replaces PostgREST embedded inbox_messages(count) per row, which is slow and can 504).

CREATE OR REPLACE FUNCTION public.inbox_message_counts_by_thread(p_thread_ids uuid[])
RETURNS TABLE(thread_id uuid, msg_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT m.thread_id, count(*)::bigint
  FROM public.inbox_messages m
  WHERE m.thread_id = ANY(p_thread_ids)
  GROUP BY m.thread_id;
$$;

REVOKE ALL ON FUNCTION public.inbox_message_counts_by_thread(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inbox_message_counts_by_thread(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_message_counts_by_thread(uuid[]) TO service_role;
