-- Inbox debug log: persists client-side debug output when ?debug=1 in Inbox URL.
-- Query in Supabase Studio: SELECT * FROM inbox_debug_log ORDER BY created_at DESC;
CREATE TABLE IF NOT EXISTS public.inbox_debug_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES public.inbox_threads(id) ON DELETE SET NULL,
  tag text NOT NULL,
  payload jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_inbox_debug_log_created_at ON public.inbox_debug_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_debug_log_thread_id ON public.inbox_debug_log(thread_id);
CREATE INDEX IF NOT EXISTS idx_inbox_debug_log_org_id ON public.inbox_debug_log(org_id);

COMMENT ON TABLE public.inbox_debug_log IS 'Client Inbox debug logs when ?debug=1; helps debug thread visibility and empty message bodies.';

ALTER TABLE public.inbox_debug_log ENABLE ROW LEVEL SECURITY;

-- Users can insert their own debug logs (org must match their membership)
DROP POLICY IF EXISTS "inbox_debug_log_insert" ON public.inbox_debug_log;
CREATE POLICY "inbox_debug_log_insert" ON public.inbox_debug_log FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (org_id IS NULL OR EXISTS (
      SELECT 1 FROM public.organization_users ou
      WHERE ou.org_id = inbox_debug_log.org_id AND ou.user_id = auth.uid()
    ))
  );

-- Users can read their own org's logs (for debugging)
DROP POLICY IF EXISTS "inbox_debug_log_select" ON public.inbox_debug_log;
CREATE POLICY "inbox_debug_log_select" ON public.inbox_debug_log FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (org_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.organization_users ou
      WHERE ou.org_id = inbox_debug_log.org_id AND ou.user_id = auth.uid()
    ))
  );
