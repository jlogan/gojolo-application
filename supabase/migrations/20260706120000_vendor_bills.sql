-- Vendor bills / accounts payable MVP
-- Uses invoices.direction='inbound' as the bill record while keeping /bills separate in the UI.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS billing_period_start date,
  ADD COLUMN IF NOT EXISTS billing_period_end date,
  ADD COLUMN IF NOT EXISTS billing_source text NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_invoices_billing_period
  ON public.invoices(org_id, direction, billing_period_start, billing_period_end);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inbound_vendor_project_period
  ON public.invoices (org_id, vendor_user_id, project_id, billing_period_start, billing_period_end)
  WHERE direction = 'inbound' AND status <> 'cancelled'
    AND vendor_user_id IS NOT NULL AND project_id IS NOT NULL
    AND billing_period_start IS NOT NULL AND billing_period_end IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.vendor_billing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  default_billing_type text NOT NULL CHECK (default_billing_type IN ('hourly', 'fixed')),
  default_hourly_rate decimal(15,2),
  default_fixed_amount decimal(15,2),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (
    (default_billing_type = 'hourly' AND default_hourly_rate IS NOT NULL AND default_hourly_rate >= 0)
    OR
    (default_billing_type = 'fixed' AND default_fixed_amount IS NOT NULL AND default_fixed_amount >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_vendor_billing_profiles_org_vendor
  ON public.vendor_billing_profiles(org_id, vendor_user_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS public.vendor_project_billing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  billing_type text NOT NULL CHECK (billing_type IN ('hourly', 'fixed')),
  hourly_rate decimal(15,2),
  fixed_amount decimal(15,2),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (
    (billing_type = 'hourly' AND hourly_rate IS NOT NULL AND hourly_rate >= 0)
    OR
    (billing_type = 'fixed' AND fixed_amount IS NOT NULL AND fixed_amount >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_vendor_project_billing_profiles_lookup
  ON public.vendor_project_billing_profiles(org_id, vendor_user_id, project_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS public.bill_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  billing_period_start date NOT NULL,
  billing_period_end date NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped')),
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  bills_created integer NOT NULL DEFAULT 0,
  bills_skipped integer NOT NULL DEFAULT 0,
  summary jsonb,
  error_message text,
  UNIQUE (org_id, billing_period_start, billing_period_end)
);

ALTER TABLE public.vendor_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_project_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_generation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vendor_billing_profiles_select" ON public.vendor_billing_profiles;
CREATE POLICY "vendor_billing_profiles_select" ON public.vendor_billing_profiles FOR SELECT TO authenticated
  USING (
    vendor_user_id = auth.uid()
    OR org_id IN (
      SELECT ou.org_id FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid() AND r.name <> 'vendor'
    )
  );

DROP POLICY IF EXISTS "vendor_billing_profiles_manage_admin" ON public.vendor_billing_profiles;
CREATE POLICY "vendor_billing_profiles_manage_admin" ON public.vendor_billing_profiles FOR ALL TO authenticated
  USING (
    org_id IN (
      SELECT ou.org_id FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid() AND r.name IN ('admin', 'account_manager')
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT ou.org_id FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid() AND r.name IN ('admin', 'account_manager')
    )
  );

DROP POLICY IF EXISTS "vendor_project_billing_profiles_select" ON public.vendor_project_billing_profiles;
CREATE POLICY "vendor_project_billing_profiles_select" ON public.vendor_project_billing_profiles FOR SELECT TO authenticated
  USING (
    vendor_user_id = auth.uid()
    OR org_id IN (
      SELECT ou.org_id FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid() AND r.name <> 'vendor'
    )
  );

DROP POLICY IF EXISTS "vendor_project_billing_profiles_manage_admin" ON public.vendor_project_billing_profiles;
CREATE POLICY "vendor_project_billing_profiles_manage_admin" ON public.vendor_project_billing_profiles FOR ALL TO authenticated
  USING (
    org_id IN (
      SELECT ou.org_id FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid() AND r.name IN ('admin', 'account_manager')
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT ou.org_id FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid() AND r.name IN ('admin', 'account_manager')
    )
  );

DROP POLICY IF EXISTS "bill_generation_runs_select" ON public.bill_generation_runs;
CREATE POLICY "bill_generation_runs_select" ON public.bill_generation_runs FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('bills.view'), ('bills.create'), ('bills.update'), ('bills.delete'), ('vendor_billing.manage')
) AS p(perm)
WHERE r.name IN ('admin', 'account_manager')
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, 'bills.view'
FROM public.roles r
WHERE r.name IN ('vendor', 'member')
ON CONFLICT (role_id, permission) DO NOTHING;
