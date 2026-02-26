-- Create organization + membership in one RPC so RLS doesn't block (function runs with definer rights).
-- Only the authenticated user can create an org for themselves (auth.uid() enforced inside).

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

-- Allow authenticated users to call this RPC
GRANT EXECUTE ON FUNCTION public.create_organization(text, text) TO authenticated;
