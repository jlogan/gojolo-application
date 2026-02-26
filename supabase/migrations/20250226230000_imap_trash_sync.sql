-- Track last synced UID per account for Trash folder (for live-ish Trash view).
ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS last_fetched_uid_trash bigint;
