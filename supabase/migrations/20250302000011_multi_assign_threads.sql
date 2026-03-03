-- Allow multiple assignees per thread (was unique on thread_id, now unique on thread_id+user_id)
ALTER TABLE public.inbox_thread_assignments DROP CONSTRAINT IF EXISTS inbox_thread_assignments_thread_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_thread_assignments_unique ON public.inbox_thread_assignments(thread_id, user_id);
