-- Allow org admins and platform admins to update organization_users (e.g. change role) and remove users.
CREATE POLICY "org_users_update_org_admin"
  ON public.organization_users FOR UPDATE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

CREATE POLICY "org_users_delete_org_admin"
  ON public.organization_users FOR DELETE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());
