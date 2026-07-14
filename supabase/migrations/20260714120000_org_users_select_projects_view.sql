-- Allow users with projects.view to list org members (project team management, profile name resolution).
-- Complements org_users_select_org_admin; profiles_select_org_member needs both ou1 and ou2 visible.
CREATE POLICY "org_users_select_projects_view"
  ON public.organization_users FOR SELECT TO authenticated
  USING (public.user_has_permission(org_id, 'projects.view'));
