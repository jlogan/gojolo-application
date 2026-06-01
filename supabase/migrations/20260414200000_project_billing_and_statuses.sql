-- Add billing fields to projects
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS project_cost decimal(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_rate decimal(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_hours decimal(15,2);

-- Note: status column already exists as text DEFAULT 'active'
-- Valid statuses: 'not_started', 'in_progress', 'on_hold', 'finished', 'cancelled'
-- Update any existing 'active' rows to 'in_progress'
UPDATE public.projects SET status = 'in_progress' WHERE status = 'active';

COMMENT ON COLUMN public.projects.billing_type IS 'fixed = fixed project cost, project_hours = project hourly rate, task_hours = per-task hourly rate';
