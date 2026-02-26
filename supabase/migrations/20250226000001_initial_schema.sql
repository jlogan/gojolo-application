-- Roles (reference table)
CREATE TABLE IF NOT EXISTS public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  permissions jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Organizations
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Organization membership (user_id references auth.users)
CREATE TABLE IF NOT EXISTS public.organization_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id uuid REFERENCES public.roles(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, user_id)
);

-- Profiles (extends auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  avatar_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Companies
CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  industry text,
  meta jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Contacts
CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'primary',
  name text NOT NULL,
  email text,
  phone text,
  meta jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_organization_users_user_id ON public.organization_users(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_users_org_id ON public.organization_users(org_id);
CREATE INDEX IF NOT EXISTS idx_companies_org_id ON public.companies(org_id);
CREATE INDEX IF NOT EXISTS idx_contacts_org_id ON public.contacts(org_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON public.contacts(company_id);

-- RLS
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- Roles: readable by authenticated users (for dropdowns)
CREATE POLICY "roles_select" ON public.roles FOR SELECT TO authenticated USING (true);

-- Organizations: only members can read
CREATE POLICY "orgs_select_member" ON public.organizations FOR SELECT TO authenticated
  USING (id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Organization_users: users can read their own memberships
CREATE POLICY "org_users_select_own" ON public.organization_users FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Organization_users: allow insert for org creation flow (e.g. first user creates org + membership)
CREATE POLICY "org_users_insert_own" ON public.organization_users FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Profiles: users can read/update own profile
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- Companies: org members can CRUD
CREATE POLICY "companies_select_org" ON public.companies FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "companies_insert_org" ON public.companies FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "companies_update_org" ON public.companies FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "companies_delete_org" ON public.companies FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Contacts: org members can CRUD
CREATE POLICY "contacts_select_org" ON public.contacts FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "contacts_insert_org" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "contacts_update_org" ON public.contacts FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "contacts_delete_org" ON public.contacts FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Organizations: allow insert so first user can create org (e.g. from app or trigger)
CREATE POLICY "orgs_insert_authenticated" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (true);

-- Trigger: create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Seed default roles
INSERT INTO public.roles (name, permissions) VALUES
  ('admin', '{"admin": true}'::jsonb),
  ('member', '{"member": true}'::jsonb)
ON CONFLICT (name) DO NOTHING;
