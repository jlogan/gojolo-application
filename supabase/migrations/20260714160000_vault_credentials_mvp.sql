-- Vault credentials MVP: project/company access, permissions, and reveal audit

ALTER TABLE public.vault_credentials
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vault_credentials_project ON public.vault_credentials(project_id);
CREATE INDEX IF NOT EXISTS idx_vault_credentials_org_company_project ON public.vault_credentials(org_id, company_id, project_id);

CREATE TABLE IF NOT EXISTS public.vault_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES public.vault_credentials(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('reveal', 'copy', 'create', 'update', 'delete')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_access_log_org ON public.vault_access_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_access_log_credential ON public.vault_access_log(credential_id, created_at DESC);

ALTER TABLE public.vault_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "val_select" ON public.vault_access_log;
CREATE POLICY "val_select" ON public.vault_access_log FOR SELECT TO authenticated
  USING (public.user_has_permission(org_id, 'vault.view'));

-- Direct client access remains scoped, but all password reveal/save flows should use Edge Functions.
DROP POLICY IF EXISTS "vc_select" ON public.vault_credentials;
DROP POLICY IF EXISTS "vc_insert" ON public.vault_credentials;
DROP POLICY IF EXISTS "vc_update" ON public.vault_credentials;
DROP POLICY IF EXISTS "vc_delete" ON public.vault_credentials;

CREATE POLICY "vc_select" ON public.vault_credentials FOR SELECT TO authenticated
  USING (public.user_has_permission(org_id, 'vault.view'));
CREATE POLICY "vc_insert" ON public.vault_credentials FOR INSERT TO authenticated
  WITH CHECK (public.user_has_permission(org_id, 'vault.create'));
CREATE POLICY "vc_update" ON public.vault_credentials FOR UPDATE TO authenticated
  USING (public.user_has_permission(org_id, 'vault.update'))
  WITH CHECK (public.user_has_permission(org_id, 'vault.update'));
CREATE POLICY "vc_delete" ON public.vault_credentials FOR DELETE TO authenticated
  USING (public.user_has_permission(org_id, 'vault.delete'));

-- Admin/account manager/member can manage the vault by default. Vendors get no vault access unless explicitly granted.
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('vault.view'), ('vault.create'), ('vault.update'), ('vault.delete'), ('vault.reveal')
) AS p(perm)
WHERE r.name IN ('admin', 'account_manager', 'member')
ON CONFLICT (role_id, permission) DO NOTHING;
