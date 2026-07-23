-- Track user-initiated restore from trash so imap-sync does not re-archive the thread
-- while IMAP flags/folders are still catching up.
ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS user_restored_at timestamptz;

COMMENT ON COLUMN public.inbox_threads.user_restored_at IS
  'Set when the user restores/unarchives from trash; cleared when trashed again.';
