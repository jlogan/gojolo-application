-- Allow vendors/project members to view and reveal credentials scoped to their projects.
-- Management still requires org-level vault.create/update/delete permissions.

CREATE OR REPLACE FUNCTION public.user_is_project_member(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_members pm
    JOIN public.projects p ON p.id = pm.project_id
    JOIN public.organization_users ou ON ou.org_id = p.org_id AND ou.user_id = auth.uid()
    WHERE pm.project_id = p_project_id
      AND pm.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_is_project_member(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.user_can_view_vault_scope(
  p_org_id uuid,
  p_project_id uuid,
  p_company_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.user_has_permission(p_org_id, 'vault.view')
  OR (
    p_project_id IS NOT NULL
    AND public.user_is_project_member(p_project_id)
  )
  OR (
    p_company_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.project_companies pc
      JOIN public.project_members pm ON pm.project_id = pc.project_id
      JOIN public.projects p ON p.id = pc.project_id
      JOIN public.organization_users ou ON ou.org_id = p.org_id AND ou.user_id = auth.uid()
      WHERE pc.company_id = p_company_id
        AND pm.user_id = auth.uid()
        AND p.org_id = p_org_id
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_can_view_vault_scope(uuid, uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "vc_select" ON public.vault_credentials;
CREATE POLICY "vc_select" ON public.vault_credentials FOR SELECT TO authenticated
  USING (
    public.user_has_permission(org_id, 'vault.view')
    OR (project_id IS NOT NULL AND public.user_is_project_member(project_id))
    OR (
      company_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.project_companies pc
        JOIN public.project_members pm ON pm.project_id = pc.project_id
        JOIN public.projects p ON p.id = pc.project_id
        JOIN public.organization_users ou ON ou.org_id = p.org_id AND ou.user_id = auth.uid()
        WHERE pc.company_id = vault_credentials.company_id
          AND pm.user_id = auth.uid()
          AND p.org_id = vault_credentials.org_id
      )
    )
  );
