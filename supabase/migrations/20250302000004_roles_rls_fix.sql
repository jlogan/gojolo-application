-- Allow platform admins and org admins to manage roles
DROP POLICY IF EXISTS "roles_insert_admin" ON public.roles;
DROP POLICY IF EXISTS "roles_update_admin" ON public.roles;
DROP POLICY IF EXISTS "roles_delete_admin" ON public.roles;
CREATE POLICY "roles_insert_admin" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());
CREATE POLICY "roles_update_admin" ON public.roles FOR UPDATE TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "roles_delete_admin" ON public.roles FOR DELETE TO authenticated
  USING (public.is_platform_admin());

-- Also allow org admins to manage role_permissions
DROP POLICY IF EXISTS "rp_insert_admin" ON public.role_permissions;
DROP POLICY IF EXISTS "rp_delete_admin" ON public.role_permissions;
CREATE POLICY "rp_insert_admin" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.organization_users ou
    JOIN public.roles r ON r.id = ou.role_id
    WHERE ou.user_id = auth.uid() AND r.name = 'admin'
  ));
CREATE POLICY "rp_delete_admin" ON public.role_permissions FOR DELETE TO authenticated
  USING (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.organization_users ou
    JOIN public.roles r ON r.id = ou.role_id
    WHERE ou.user_id = auth.uid() AND r.name = 'admin'
  ));
