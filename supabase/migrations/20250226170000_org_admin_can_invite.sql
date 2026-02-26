-- Allow organization admins to invite users to their own org (not only platform admins).
CREATE OR REPLACE FUNCTION public.invite_user_to_org(p_org_id uuid, p_email text, p_role_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv_id uuid;
  existing_id uuid;
BEGIN
  IF NOT public.is_platform_admin() AND NOT public.is_org_admin(p_org_id) THEN
    RAISE EXCEPTION 'Only platform admins or organization admins can invite users';
  END IF;
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;
  SELECT id INTO existing_id FROM public.org_invitations
  WHERE org_id = p_org_id AND lower(email) = lower(trim(p_email)) AND used_at IS NULL
  LIMIT 1;
  IF existing_id IS NOT NULL THEN
    UPDATE public.org_invitations SET role_id = p_role_id, invited_by = auth.uid() WHERE id = existing_id;
    RETURN existing_id;
  END IF;
  INSERT INTO public.org_invitations (org_id, email, role_id, invited_by)
  VALUES (p_org_id, trim(p_email), p_role_id, auth.uid())
  RETURNING id INTO inv_id;
  RETURN inv_id;
END;
$$;

-- Allow org admins to read/update invitations for their org (so they can see pending invites in Admin).
CREATE POLICY "org_invitations_select_org_admin"
  ON public.org_invitations FOR SELECT TO authenticated
  USING (public.is_org_admin(org_id));

CREATE POLICY "org_invitations_update_org_admin"
  ON public.org_invitations FOR UPDATE TO authenticated
  USING (public.is_org_admin(org_id));

-- Allow org admins and platform admins to list members (organization_users for their org).
CREATE POLICY "org_users_select_org_admin"
  ON public.organization_users FOR SELECT TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

-- Allow org admins and platform admins to read profiles of users in orgs they admin (for member list).
CREATE POLICY "profiles_select_org_admin"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM public.organization_users ou
      WHERE ou.user_id = profiles.id AND public.is_org_admin(ou.org_id)
    )
  );
