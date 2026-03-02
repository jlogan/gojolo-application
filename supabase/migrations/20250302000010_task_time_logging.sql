-- Task enhancements and time logging

-- Task comments (threaded discussion per task)
CREATE TABLE IF NOT EXISTS public.task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_task_comments_task ON public.task_comments(task_id);
ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tc_select" ON public.task_comments FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tc_insert" ON public.task_comments FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- Multiple assignees per task
CREATE TABLE IF NOT EXISTS public.task_assignees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(task_id, user_id)
);
CREATE INDEX idx_task_assignees_task ON public.task_assignees(task_id);
CREATE INDEX idx_task_assignees_user ON public.task_assignees(user_id);
ALTER TABLE public.task_assignees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ta2_select" ON public.task_assignees FOR SELECT TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ta2_insert" ON public.task_assignees FOR INSERT TO authenticated
  WITH CHECK (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ta2_delete" ON public.task_assignees FOR DELETE TO authenticated
  USING (task_id IN (SELECT id FROM tasks WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- Time logs per task
CREATE TABLE IF NOT EXISTS public.time_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hours numeric(6,2) NOT NULL DEFAULT 0,
  minutes integer NOT NULL DEFAULT 0,
  work_date date NOT NULL DEFAULT CURRENT_DATE,
  description text,
  billed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_time_logs_task ON public.time_logs(task_id);
CREATE INDEX idx_time_logs_project ON public.time_logs(project_id);
CREATE INDEX idx_time_logs_user ON public.time_logs(user_id);
CREATE INDEX idx_time_logs_date ON public.time_logs(work_date);
ALTER TABLE public.time_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tl_select" ON public.time_logs FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tl_insert" ON public.time_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "tl_update" ON public.time_logs FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "tl_delete" ON public.time_logs FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- User hourly rate (in profiles)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS hourly_rate numeric(8,2);

-- Store avatar from Google in profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS google_avatar_url text;

-- Update handle_new_user to capture Google avatar
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, email, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE SET
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    email = COALESCE(EXCLUDED.email, profiles.email);
  PERFORM public.consume_invitations_for_new_user(NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Update existing profiles with Google avatar if available
UPDATE public.profiles p
SET avatar_url = u.raw_user_meta_data->>'avatar_url'
FROM auth.users u
WHERE p.id = u.id
  AND p.avatar_url IS NULL
  AND u.raw_user_meta_data->>'avatar_url' IS NOT NULL;
