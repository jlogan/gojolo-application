-- Document thread archive audit rows and speed up lookups by tag.
COMMENT ON TABLE public.inbox_debug_log IS
  'Inbox debug: optional client logs when ?debug=1; plus thread_archived rows whenever a thread is trashed (status archived) from UI, imap-sync, or ai-chat.';

CREATE INDEX IF NOT EXISTS idx_inbox_debug_log_thread_archived
  ON public.inbox_debug_log (created_at DESC)
  WHERE tag = 'thread_archived';
