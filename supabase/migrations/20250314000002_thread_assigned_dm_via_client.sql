-- Thread assignment and @mention DM/email are now sent by the client (Inbox) calling process-user-notification
-- with JWT right after insert, so we no longer enqueue these. No app_config required.
DROP TRIGGER IF EXISTS enqueue_thread_assigned ON public.inbox_thread_assignments;
DROP TRIGGER IF EXISTS enqueue_mentioned_in_thread ON public.inbox_comments;
