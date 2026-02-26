-- All addresses this account can send from and receive mail to (primary + aliases).
-- Used for matching incoming mail and for choosing "From" when replying.
ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS addresses text[] DEFAULT '{}';

COMMENT ON COLUMN public.imap_accounts.addresses IS 'All email addresses for this account: primary (email) plus aliases. Used for send-as and matching incoming mail.';
