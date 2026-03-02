-- Map email accounts to projects
CREATE TABLE IF NOT EXISTS public.project_email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  imap_account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, imap_account_id)
);

ALTER TABLE public.project_email_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pea_select" ON public.project_email_accounts FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pea_insert" ON public.project_email_accounts FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pea_delete" ON public.project_email_accounts FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- Contact merge support: soft-link merged contacts
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.contacts(id) ON DELETE SET NULL;
