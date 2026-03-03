-- Draft messages per thread
CREATE TABLE IF NOT EXISTS public.inbox_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_address text,
  cc text,
  bcc text,
  subject text,
  html_body text,
  account_id uuid REFERENCES public.imap_accounts(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_inbox_drafts_thread ON public.inbox_drafts(thread_id);
CREATE INDEX idx_inbox_drafts_user ON public.inbox_drafts(user_id, org_id);
ALTER TABLE public.inbox_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "draft_select" ON public.inbox_drafts FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "draft_insert" ON public.inbox_drafts FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "draft_update" ON public.inbox_drafts FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "draft_delete" ON public.inbox_drafts FOR DELETE TO authenticated
  USING (user_id = auth.uid());
