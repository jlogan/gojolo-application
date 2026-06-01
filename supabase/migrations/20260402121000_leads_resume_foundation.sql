-- Leads + Attempts + Resume Templates foundation

-- 1) Leads (parent record)
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  title text NOT NULL,
  source text NOT NULL DEFAULT 'indeed',
  status text NOT NULL DEFAULT 'new',
  job_url text,
  job_type text,
  work_mode text,
  compensation_type text,
  compensation_value text,
  location text,
  job_description text,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  next_follow_up_at timestamptz,
  last_activity_at timestamptz DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_status_check CHECK (status IN ('new', 'researching', 'applying', 'applied', 'follow_up', 'interview', 'closed_won', 'closed_lost')),
  CONSTRAINT leads_source_check CHECK (source IN ('indeed', 'linkedin', 'upwork', 'referral', 'outbound', 'other')),
  CONSTRAINT leads_compensation_type_check CHECK (compensation_type IS NULL OR compensation_type IN ('salary', 'hourly', 'fixed', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_leads_org_status ON public.leads(org_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org_company ON public.leads(org_id, company_id);
CREATE INDEX IF NOT EXISTS idx_leads_org_next_follow_up ON public.leads(org_id, next_follow_up_at);

-- 2) Lead contacts (potential outreach contacts)
CREATE TABLE IF NOT EXISTS public.lead_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'target',
  is_primary boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead ON public.lead_contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_contact ON public.lead_contacts(contact_id);

-- 3) Lead attempts (every action taken against a lead)
CREATE TABLE IF NOT EXISTS public.lead_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  attempt_type text NOT NULL,
  channel text,
  status text NOT NULL DEFAULT 'completed',
  subject text,
  content text,
  external_url text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  next_follow_up_at timestamptz,
  outcome text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_attempts_type_check CHECK (attempt_type IN ('application', 'email_outreach', 'linkedin_message', 'upwork_proposal', 'follow_up', 'call', 'meeting', 'other')),
  CONSTRAINT lead_attempts_status_check CHECK (status IN ('pending', 'completed', 'replied', 'interview', 'rejected', 'won', 'lost'))
);

CREATE INDEX IF NOT EXISTS idx_lead_attempts_lead ON public.lead_attempts(lead_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_attempts_org ON public.lead_attempts(org_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_attempts_org_next_follow_up ON public.lead_attempts(org_id, next_follow_up_at);

-- 4) Resume templates (per tenant)
CREATE TABLE IF NOT EXISTS public.resume_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  candidate_name text NOT NULL,
  headline text,
  summary text,
  email text,
  phone text,
  website text,
  location text,
  linkedin_url text,
  github_url text,
  profile_photo_url text,
  is_default boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_resume_templates_org ON public.resume_templates(org_id, created_at DESC);

-- 5) Resume template experiences
CREATE TABLE IF NOT EXISTS public.resume_template_experiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.resume_templates(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  company_name text NOT NULL,
  role_title text NOT NULL,
  start_year integer NOT NULL,
  end_year integer,
  is_current boolean NOT NULL DEFAULT false,
  description text,
  bullets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resume_template_experience_template ON public.resume_template_experiences(template_id, sort_order, created_at);

-- 6) Resume documents (generated outputs)
CREATE TABLE IF NOT EXISTS public.resume_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  attempt_id uuid REFERENCES public.lead_attempts(id) ON DELETE SET NULL,
  template_id uuid REFERENCES public.resume_templates(id) ON DELETE SET NULL,
  candidate_name text NOT NULL,
  company_name text,
  role_title text,
  job_description text,
  render_format text NOT NULL DEFAULT 'pdf',
  file_path text,
  file_url text,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resume_documents_render_format_check CHECK (render_format IN ('pdf', 'json', 'html'))
);

CREATE INDEX IF NOT EXISTS idx_resume_documents_org ON public.resume_documents(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resume_documents_lead ON public.resume_documents(lead_id, created_at DESC);

-- RLS enable
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_template_experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_documents ENABLE ROW LEVEL SECURITY;

-- Leads policies
CREATE POLICY "leads_select_org" ON public.leads FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "leads_insert_org" ON public.leads FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "leads_update_org" ON public.leads FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "leads_delete_org" ON public.leads FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Lead contacts policies
CREATE POLICY "lead_contacts_select_org" ON public.lead_contacts FOR SELECT TO authenticated
  USING (
    lead_id IN (
      SELECT l.id FROM public.leads l
      WHERE l.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );
CREATE POLICY "lead_contacts_insert_org" ON public.lead_contacts FOR INSERT TO authenticated
  WITH CHECK (
    lead_id IN (
      SELECT l.id FROM public.leads l
      WHERE l.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );
CREATE POLICY "lead_contacts_update_org" ON public.lead_contacts FOR UPDATE TO authenticated
  USING (
    lead_id IN (
      SELECT l.id FROM public.leads l
      WHERE l.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );
CREATE POLICY "lead_contacts_delete_org" ON public.lead_contacts FOR DELETE TO authenticated
  USING (
    lead_id IN (
      SELECT l.id FROM public.leads l
      WHERE l.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );

-- Lead attempts policies
CREATE POLICY "lead_attempts_select_org" ON public.lead_attempts FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "lead_attempts_insert_org" ON public.lead_attempts FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "lead_attempts_update_org" ON public.lead_attempts FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "lead_attempts_delete_org" ON public.lead_attempts FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Resume template policies
CREATE POLICY "resume_templates_select_org" ON public.resume_templates FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "resume_templates_insert_org" ON public.resume_templates FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "resume_templates_update_org" ON public.resume_templates FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "resume_templates_delete_org" ON public.resume_templates FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Resume experiences policies
CREATE POLICY "resume_template_experiences_select_org" ON public.resume_template_experiences FOR SELECT TO authenticated
  USING (
    template_id IN (
      SELECT rt.id FROM public.resume_templates rt
      WHERE rt.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );
CREATE POLICY "resume_template_experiences_insert_org" ON public.resume_template_experiences FOR INSERT TO authenticated
  WITH CHECK (
    template_id IN (
      SELECT rt.id FROM public.resume_templates rt
      WHERE rt.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );
CREATE POLICY "resume_template_experiences_update_org" ON public.resume_template_experiences FOR UPDATE TO authenticated
  USING (
    template_id IN (
      SELECT rt.id FROM public.resume_templates rt
      WHERE rt.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );
CREATE POLICY "resume_template_experiences_delete_org" ON public.resume_template_experiences FOR DELETE TO authenticated
  USING (
    template_id IN (
      SELECT rt.id FROM public.resume_templates rt
      WHERE rt.org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())
    )
  );

-- Resume docs policies
CREATE POLICY "resume_documents_select_org" ON public.resume_documents FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "resume_documents_insert_org" ON public.resume_documents FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "resume_documents_update_org" ON public.resume_documents FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "resume_documents_delete_org" ON public.resume_documents FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
