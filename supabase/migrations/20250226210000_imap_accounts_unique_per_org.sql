-- One IMAP account per (org, primary email) to prevent duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_imap_accounts_org_email
  ON public.imap_accounts (org_id, LOWER(TRIM(email)));
