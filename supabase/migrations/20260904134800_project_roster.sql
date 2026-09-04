-- Project-scoped roster members (Bill Haynes CSV import/export) + t-shirt size reference data

-- 1) T-shirt size codes (Bill Haynes roster format)
CREATE TABLE IF NOT EXISTS public.t_shirt_sizes (
  code text PRIMARY KEY,
  label text NOT NULL,
  sequence integer NOT NULL,
  category text NOT NULL CHECK (category IN ('youth', 'adult', 'none'))
);

INSERT INTO public.t_shirt_sizes (code, label, sequence, category) VALUES
  ('YXS', 'Youth X-Small', 1, 'youth'),
  ('YS',  'Youth Small', 2, 'youth'),
  ('YM',  'Youth Medium', 3, 'youth'),
  ('YL',  'Youth Large', 4, 'youth'),
  ('YXL', 'Youth X-Large', 5, 'youth'),
  ('AXS', 'Adult X-Small', 6, 'adult'),
  ('AS',  'Adult Small', 7, 'adult'),
  ('AM',  'Adult Medium', 8, 'adult'),
  ('AL',  'Adult Large', 9, 'adult'),
  ('AXL', 'Adult X-Large', 10, 'adult'),
  ('A2X', 'Adult 2X-Large', 11, 'adult'),
  ('A3X', 'Adult 3X-Large', 12, 'adult'),
  ('A4X', 'Adult 4X-Large', 13, 'adult'),
  ('NS',  'No Shirt', 0, 'none')
ON CONFLICT (code) DO NOTHING;

-- 2) Project roster members
CREATE TABLE IF NOT EXISTS public.project_roster_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  gender text NOT NULL CHECK (gender IN ('M', 'F')),
  first_name text NOT NULL,
  last_name text NOT NULL,
  middle_initial text,
  date_of_birth date NOT NULL,
  school_year integer,
  street text,
  city text,
  state text,
  zip text,
  home_phone text,
  work_phone text,
  email text,
  t_shirt_size_code text REFERENCES public.t_shirt_sizes(code) ON DELETE SET NULL,
  match_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, match_key)
);

CREATE INDEX IF NOT EXISTS idx_project_roster_members_project
  ON public.project_roster_members (project_id);

CREATE INDEX IF NOT EXISTS idx_project_roster_members_match_key
  ON public.project_roster_members (project_id, match_key);

-- 3) RLS
ALTER TABLE public.t_shirt_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_roster_members ENABLE ROW LEVEL SECURITY;

-- Reference data readable by any authenticated user
CREATE POLICY "t_shirt_sizes_select_authenticated" ON public.t_shirt_sizes
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "proster_select_org" ON public.project_roster_members
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.org_id IN (
        SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "proster_insert_org" ON public.project_roster_members
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.org_id IN (
        SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "proster_update_org" ON public.project_roster_members
  FOR UPDATE TO authenticated
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.org_id IN (
        SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "proster_delete_org" ON public.project_roster_members
  FOR DELETE TO authenticated
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.org_id IN (
        SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()
      )
    )
  );
