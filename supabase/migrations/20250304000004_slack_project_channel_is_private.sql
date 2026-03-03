ALTER TABLE public.slack_project_channels
  ADD COLUMN IF NOT EXISTS is_private boolean DEFAULT false;
