-- Platform admins: only these users can create orgs and access admin UI.
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Users can only see if they themselves are a platform admin.
CREATE POLICY "platform_admins_select_own"
  ON public.platform_admins FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Only existing platform admins can insert (add other admins). We enforce this in a SECURITY DEFINER function.
CREATE POLICY "platform_admins_insert_service"
  ON public.platform_admins FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid()));

-- First user to sign up becomes platform admin.
CREATE OR REPLACE FUNCTION public.bootstrap_platform_admin()
RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM public.platform_admins) = 0 THEN
    INSERT INTO public.platform_admins (user_id) VALUES (NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS bootstrap_platform_admin_trigger ON auth.users;
CREATE TRIGGER bootstrap_platform_admin_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.bootstrap_platform_admin();

-- RPC: is the current user a platform admin?
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;

-- Org invitations: placeholder users by email; consumed when they sign in.
CREATE TABLE IF NOT EXISTS public.org_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role_id uuid REFERENCES public.roles(id),
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  used_at timestamptz
);

-- One pending invite per (org, email); used invites can be re-invited.
CREATE UNIQUE INDEX idx_org_invitations_org_email_pending
  ON public.org_invitations (org_id, lower(email)) WHERE (used_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON public.org_invitations(email);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org_id ON public.org_invitations(org_id);

ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;

-- Only platform admins can manage invitations (insert, select, update used_at).
CREATE POLICY "org_invitations_select_admin"
  ON public.org_invitations FOR SELECT TO authenticated
  USING (public.is_platform_admin());

CREATE POLICY "org_invitations_insert_admin"
  ON public.org_invitations FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());

CREATE POLICY "org_invitations_update_admin"
  ON public.org_invitations FOR UPDATE TO authenticated
  USING (public.is_platform_admin());

-- Add email to profiles for invite consumption (existing users).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email text;

-- Consume invitations for a newly signed-up user (called from trigger).
CREATE OR REPLACE FUNCTION public.consume_invitations_for_new_user(p_user_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, org_id, role_id FROM public.org_invitations
    WHERE lower(email) = lower(p_email) AND used_at IS NULL
  LOOP
    INSERT INTO public.organization_users (org_id, user_id, role_id)
    VALUES (r.org_id, p_user_id, r.role_id)
    ON CONFLICT (org_id, user_id) DO NOTHING;
    UPDATE public.org_invitations SET used_at = now() WHERE id = r.id;
  END LOOP;
END;
$$;

-- Update handle_new_user: set profile email and consume invitations.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.email);
  PERFORM public.consume_invitations_for_new_user(NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- For existing users: consume invitations on next load (email from profiles).
CREATE OR REPLACE FUNCTION public.consume_my_invitations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p_email text;
  consumed int := 0;
  r record;
BEGIN
  SELECT email INTO p_email FROM public.profiles WHERE id = auth.uid();
  IF p_email IS NULL THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT id, org_id, role_id FROM public.org_invitations
    WHERE lower(email) = lower(p_email) AND used_at IS NULL
  LOOP
    INSERT INTO public.organization_users (org_id, user_id, role_id)
    VALUES (r.org_id, auth.uid(), r.role_id)
    ON CONFLICT (org_id, user_id) DO NOTHING;
    UPDATE public.org_invitations SET used_at = now() WHERE id = r.id;
    consumed := consumed + 1;
  END LOOP;
  RETURN consumed;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_my_invitations() TO authenticated;

-- Restrict create_organization to platform admins only.
CREATE OR REPLACE FUNCTION public.create_organization(org_name text, org_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid;
  new_org_id uuid;
  admin_role_id uuid;
  new_org jsonb;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can create organizations';
  END IF;

  INSERT INTO public.organizations (name, slug)
  VALUES (org_name, org_slug)
  RETURNING id INTO new_org_id;

  SELECT id INTO admin_role_id FROM public.roles WHERE name = 'admin' LIMIT 1;

  INSERT INTO public.organization_users (org_id, user_id, role_id)
  VALUES (new_org_id, uid, admin_role_id);

  SELECT to_jsonb(o.*) INTO new_org
  FROM public.organizations o
  WHERE o.id = new_org_id;

  RETURN new_org;
END;
$$;

-- Platform admins: invite a user by email to an org with a role (placeholder until they sign in).
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
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can invite users';
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

GRANT EXECUTE ON FUNCTION public.invite_user_to_org(uuid, text, uuid) TO authenticated;

-- Platform admins can list all organizations (for admin UI).
CREATE POLICY "orgs_select_platform_admin"
  ON public.organizations FOR SELECT TO authenticated
  USING (public.is_platform_admin());
