-- Add rate capture and timer fields to time_logs
-- Note: 'comment' column already exists (added in 20250305000001_task_overhaul_vault.sql)
ALTER TABLE public.time_logs
  ADD COLUMN IF NOT EXISTS hourly_rate decimal(15,2),
  ADD COLUMN IF NOT EXISTS timer_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS timer_stopped_at timestamptz;

-- Active timers view (for showing running timers in header/sidebar)
CREATE OR REPLACE VIEW public.active_timers AS
SELECT tl.id, tl.task_id, tl.project_id, tl.user_id, tl.timer_started_at,
       t.title as task_title, p.name as project_name
FROM public.time_logs tl
JOIN public.tasks t ON t.id = tl.task_id
JOIN public.projects p ON p.id = tl.project_id
WHERE tl.timer_started_at IS NOT NULL
  AND tl.timer_stopped_at IS NULL
  AND tl.hours = 0 AND tl.minutes = 0;
