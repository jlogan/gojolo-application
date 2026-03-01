-- ============================================================
-- Projects & Tasks: schema, RLS, storage, chat history
-- ============================================================

-- Projects
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  due_date date,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_projects_org_id ON public.projects(org_id);
CREATE INDEX idx_projects_status ON public.projects(status);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- Project members (which org users can access a project)
CREATE TABLE IF NOT EXISTS public.project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, user_id)
);

CREATE INDEX idx_project_members_user ON public.project_members(user_id);
CREATE INDEX idx_project_members_project ON public.project_members(project_id);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- Link projects to companies
CREATE TABLE IF NOT EXISTS public.project_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, company_id)
);

CREATE INDEX idx_project_companies_project ON public.project_companies(project_id);

ALTER TABLE public.project_companies ENABLE ROW LEVEL SECURITY;

-- Link projects to individual contacts
CREATE TABLE IF NOT EXISTS public.project_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, contact_id)
);

CREATE INDEX idx_project_contacts_project ON public.project_contacts(project_id);

ALTER TABLE public.project_contacts ENABLE ROW LEVEL SECURITY;

-- Tasks
CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'todo',
  priority text NOT NULL DEFAULT 'medium',
  due_date date,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_tasks_project ON public.tasks(project_id);
CREATE INDEX idx_tasks_org ON public.tasks(org_id);
CREATE INDEX idx_tasks_assigned ON public.tasks(assigned_to);
CREATE INDEX idx_tasks_status ON public.tasks(status);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Task attachments (references Supabase Storage)
CREATE TABLE IF NOT EXISTS public.task_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_path text NOT NULL,
  file_size bigint,
  content_type text,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_task_attachments_task ON public.task_attachments(task_id);

ALTER TABLE public.task_attachments ENABLE ROW LEVEL SECURITY;

-- Chat messages (conversation history for AI chat)
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user',
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_chat_messages_org_user ON public.chat_messages(org_id, user_id);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS Policies
-- ============================================================

-- Helper: is user an org member?
-- (reuses the pattern from initial schema)

-- Projects: org members can read all projects in their org;
-- project members can see their assigned projects.
-- Admins/platform admins see everything via org membership.
CREATE POLICY "projects_select_org" ON public.projects FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "projects_insert_org" ON public.projects FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "projects_update_org" ON public.projects FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "projects_delete_org" ON public.projects FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Project members
CREATE POLICY "pm_select_org" ON public.project_members FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pm_insert_org" ON public.project_members FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pm_delete_org" ON public.project_members FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));

-- Project companies
CREATE POLICY "pc_select_org" ON public.project_companies FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pc_insert_org" ON public.project_companies FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pc_delete_org" ON public.project_companies FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));

-- Project contacts
CREATE POLICY "pcon_select_org" ON public.project_contacts FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pcon_insert_org" ON public.project_contacts FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "pcon_delete_org" ON public.project_contacts FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));

-- Tasks: org members full CRUD
CREATE POLICY "tasks_select_org" ON public.tasks FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "tasks_insert_org" ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "tasks_update_org" ON public.tasks FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "tasks_delete_org" ON public.tasks FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- Task attachments
CREATE POLICY "ta_select_org" ON public.task_attachments FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM public.tasks WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ta_insert_org" ON public.task_attachments FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM public.tasks WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ta_delete_org" ON public.task_attachments FOR DELETE TO authenticated
  USING (task_id IN (SELECT id FROM public.tasks WHERE org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid())));

-- Chat messages: users can read/write their own messages in their org
CREATE POLICY "chat_select_own" ON public.chat_messages FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "chat_insert_own" ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- ============================================================
-- Storage bucket for task attachments
-- ============================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('task-attachments', 'task-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "ta_storage_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'task-attachments');
CREATE POLICY "ta_storage_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'task-attachments');
CREATE POLICY "ta_storage_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'task-attachments');
