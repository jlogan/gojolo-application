-- Allow multiple Google calendar connections per user (Jay/Chris multi-account support).

-- Drop legacy one-connection-per-user constraint.
ALTER TABLE public.calendar_connections
  DROP CONSTRAINT IF EXISTS calendar_connections_org_id_user_id_provider_key;

-- Human-readable label to distinguish accounts in the UI (defaults from OAuth email).
ALTER TABLE public.calendar_connections
  ADD COLUMN IF NOT EXISTS account_label text;

COMMENT ON COLUMN public.calendar_connections.account_label IS
  'Display label for this connected calendar account; usually the Google account email.';

-- Backfill labels for existing connected rows.
UPDATE public.calendar_connections
SET account_label = email
WHERE account_label IS NULL AND email IS NOT NULL;

-- One row per Google account once provider_account_id is known (pending rows may duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_connections_provider_account
  ON public.calendar_connections (org_id, user_id, provider, provider_account_id)
  WHERE provider_account_id IS NOT NULL;
