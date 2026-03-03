-- ============================================================
-- Task system overhaul + Vault module
-- ============================================================

-- 1. Update task status options and add fields
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Task status history (track every status change)
CREATE TABLE IF NOT EXISTS public.task_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  comment text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_task_status_history_task ON public.task_status_history(task_id);
ALTER TABLE public.task_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tsh_select" ON public.task_status_history FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tsh_insert" ON public.task_status_history FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 2. Task artifacts (links, files, screenshots, loom videos, etc.)
CREATE TABLE IF NOT EXISTS public.task_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'link',
  label text,
  url text,
  file_path text,
  file_name text,
  content_type text,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_task_artifacts_task ON public.task_artifacts(task_id);
ALTER TABLE public.task_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tart_select" ON public.task_artifacts FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tart_insert" ON public.task_artifacts FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tart_delete" ON public.task_artifacts FOR DELETE TO authenticated
  USING (uploaded_by = auth.uid() OR task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 3. Task-email thread links
CREATE TABLE IF NOT EXISTS public.task_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(task_id, thread_id)
);
CREATE INDEX idx_task_threads_task ON public.task_threads(task_id);
ALTER TABLE public.task_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tt_select" ON public.task_threads FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tt_insert" ON public.task_threads FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tt_delete" ON public.task_threads FOR DELETE TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 4. Slack thread messages linked to tasks
CREATE TABLE IF NOT EXISTS public.task_slack_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  slack_thread_ts text NOT NULL,
  slack_message_ts text NOT NULL,
  user_name text,
  user_avatar text,
  content text NOT NULL,
  received_at timestamptz DEFAULT now()
);
CREATE INDEX idx_task_slack_messages_task ON public.task_slack_messages(task_id);
ALTER TABLE public.task_slack_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tsm_select" ON public.task_slack_messages FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tsm_insert" ON public.task_slack_messages FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 5. Update time_logs: add billable flag comment, better structure
ALTER TABLE public.time_logs
  ADD COLUMN IF NOT EXISTS comment text;

-- 6. Vault: credentials per company/project
CREATE TABLE IF NOT EXISTS public.vault_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  label text NOT NULL,
  credential_type text NOT NULL DEFAULT 'login',
  username text,
  password_encrypted text,
  url text,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_vault_credentials_org ON public.vault_credentials(org_id);
CREATE INDEX idx_vault_credentials_company ON public.vault_credentials(company_id);
ALTER TABLE public.vault_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vc_select" ON public.vault_credentials FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "vc_insert" ON public.vault_credentials FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "vc_update" ON public.vault_credentials FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "vc_delete" ON public.vault_credentials FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Link vault credentials to tasks
CREATE TABLE IF NOT EXISTS public.task_vault_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES public.vault_credentials(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(task_id, credential_id)
);
ALTER TABLE public.task_vault_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tvc_select" ON public.task_vault_credentials FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tvc_insert" ON public.task_vault_credentials FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tvc_delete" ON public.task_vault_credentials FOR DELETE TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 7. Storage bucket for task artifacts
INSERT INTO storage.buckets (id, name, public) VALUES ('task-artifacts', 'task-artifacts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "ta_art_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'task-artifacts');
CREATE POLICY "ta_art_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'task-artifacts');
CREATE POLICY "ta_art_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'task-artifacts');

-- 8. Auto-record status changes
CREATE OR REPLACE FUNCTION public.track_task_status_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.task_status_history (task_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
    NEW.status_changed_at = now();
    NEW.status_changed_by = auth.uid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS track_task_status ON public.tasks;
CREATE TRIGGER track_task_status
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.track_task_status_change();
