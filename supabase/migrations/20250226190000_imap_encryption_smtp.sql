-- IMAP encryption: 'none' | 'tls' (STARTTLS) | 'ssl' (implicit TLS, e.g. port 993)
ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS imap_encryption text DEFAULT 'ssl' CHECK (imap_encryption IN ('none', 'tls', 'ssl'));

-- SMTP settings (for sending replies; credentials stored server-side only)
ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS smtp_host text,
  ADD COLUMN IF NOT EXISTS smtp_port int,
  ADD COLUMN IF NOT EXISTS smtp_use_tls boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS smtp_username text,
  ADD COLUMN IF NOT EXISTS smtp_credentials_encrypted text;

COMMENT ON COLUMN public.imap_accounts.smtp_credentials_encrypted IS 'Encrypted SMTP password; set only by Edge Function. Never expose to client.';
