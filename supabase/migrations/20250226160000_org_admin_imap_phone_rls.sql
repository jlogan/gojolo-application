-- Helper: is the current user an organization admin for the given org? (has role 'admin' in that org)
CREATE OR REPLACE FUNCTION public.is_org_admin(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_users ou
    JOIN public.roles r ON r.id = ou.role_id
    WHERE ou.org_id = p_org_id AND ou.user_id = auth.uid() AND r.name = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_admin(uuid) TO authenticated;

-- Allow platform admins to read/write any org's companies and contacts (for "switch to any org" management)
CREATE POLICY "companies_select_platform_admin" ON public.companies FOR SELECT TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "companies_insert_platform_admin" ON public.companies FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());
CREATE POLICY "companies_update_platform_admin" ON public.companies FOR UPDATE TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "companies_delete_platform_admin" ON public.companies FOR DELETE TO authenticated
  USING (public.is_platform_admin());

CREATE POLICY "contacts_select_platform_admin" ON public.contacts FOR SELECT TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "contacts_insert_platform_admin" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());
CREATE POLICY "contacts_update_platform_admin" ON public.contacts FOR UPDATE TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "contacts_delete_platform_admin" ON public.contacts FOR DELETE TO authenticated
  USING (public.is_platform_admin());

-- IMAP accounts per organization (org admin or platform admin can manage)
CREATE TABLE IF NOT EXISTS public.imap_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  label text,
  email text NOT NULL,
  host text,
  port int DEFAULT 993,
  use_tls boolean DEFAULT true,
  -- credentials stored server-side only (e.g. via Edge Function / vault); we just track which account
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imap_accounts_org_id ON public.imap_accounts(org_id);

ALTER TABLE public.imap_accounts ENABLE ROW LEVEL SECURITY;

-- Org admin of that org or platform admin can do everything
CREATE POLICY "imap_select" ON public.imap_accounts FOR SELECT TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());
CREATE POLICY "imap_insert" ON public.imap_accounts FOR INSERT TO authenticated
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());
CREATE POLICY "imap_update" ON public.imap_accounts FOR UPDATE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());
CREATE POLICY "imap_delete" ON public.imap_accounts FOR DELETE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

-- Phone numbers (Twilio): super admin purchases and assigns to org; org admin can only toggle is_active for their org
CREATE TABLE IF NOT EXISTS public.phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  twilio_sid text,
  phone_number text NOT NULL,
  friendly_name text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_org_id ON public.phone_numbers(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_number ON public.phone_numbers(phone_number);

ALTER TABLE public.phone_numbers ENABLE ROW LEVEL SECURITY;

-- Platform admin: full CRUD (purchase/assign/unassign, update)
CREATE POLICY "phone_select_platform_admin" ON public.phone_numbers FOR SELECT TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "phone_insert_platform_admin" ON public.phone_numbers FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());
CREATE POLICY "phone_update_platform_admin" ON public.phone_numbers FOR UPDATE TO authenticated
  USING (public.is_platform_admin());
CREATE POLICY "phone_delete_platform_admin" ON public.phone_numbers FOR DELETE TO authenticated
  USING (public.is_platform_admin());

-- Org admin: select and update only rows for their org (e.g. toggle is_active)
CREATE POLICY "phone_select_org_admin" ON public.phone_numbers FOR SELECT TO authenticated
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "phone_update_org_admin" ON public.phone_numbers FOR UPDATE TO authenticated
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
