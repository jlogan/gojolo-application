-- RPC: return thread IDs assigned to the current user (auth.uid()) in the given org.
-- Ensures "Mine" tab shows only the logged-in user's assigned threads.
CREATE OR REPLACE FUNCTION public.get_my_assigned_inbox_thread_ids(p_org_id uuid)
RETURNS setof uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ita.thread_id
  FROM inbox_thread_assignments ita
  JOIN inbox_threads t ON t.id = ita.thread_id
  WHERE ita.user_id = auth.uid()
    AND t.org_id = p_org_id
    AND EXISTS (SELECT 1 FROM organization_users ou WHERE ou.org_id = p_org_id AND ou.user_id = auth.uid());
$$;

-- Allow authenticated org members to call it (they only get their own IDs)
GRANT EXECUTE ON FUNCTION public.get_my_assigned_inbox_thread_ids(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_my_assigned_inbox_thread_ids(uuid) IS 'Returns inbox thread IDs assigned to the current user in the given org; used for Mine tab.';
