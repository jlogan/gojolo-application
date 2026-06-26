-- Add is_draft flag to inbox_messages
-- Allows marking messages as Gmail/IMAP drafts that slipped through sync
-- or messages composed but not yet sent via GoJolo.

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS is_draft boolean NOT NULL DEFAULT false;

-- Index for fast draft lookups per thread
CREATE INDEX IF NOT EXISTS idx_inbox_messages_is_draft
  ON public.inbox_messages (thread_id, is_draft)
  WHERE is_draft = true;

-- Backfill: mark the known leaked draft in the 40 Acres thread
UPDATE public.inbox_messages
  SET is_draft = true
  WHERE id = 'b5750b09-1bae-4e98-9962-876310213e12';
