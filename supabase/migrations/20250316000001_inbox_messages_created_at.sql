-- Add created_at to inbox_messages (required by Supabase Realtime / replication)
-- Fixes: record "new" has no field "created_at" on insert
ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Backfill existing rows with received_at for accuracy
UPDATE public.inbox_messages
  SET created_at = COALESCE(received_at, created_at, now())
  WHERE received_at IS NOT NULL;
