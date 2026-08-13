-- OAuth tokens for calendar connections: service role only (never exposed via RLS to clients).

ALTER TABLE public.calendar_connections
  ADD COLUMN IF NOT EXISTS primary_calendar_id text DEFAULT 'primary';

COMMENT ON COLUMN public.calendar_connections.primary_calendar_id IS 'Provider calendar id (Google: usually primary).';

CREATE TABLE IF NOT EXISTS public.calendar_connection_tokens (
  connection_id uuid PRIMARY KEY REFERENCES public.calendar_connections(id) ON DELETE CASCADE,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text,
  oauth_state text,
  oauth_state_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.calendar_connection_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.calendar_connection_tokens IS 'Encrypted OAuth tokens for calendar sync. No RLS policies — only service role may read/write.';
COMMENT ON COLUMN public.calendar_connection_tokens.access_token_encrypted IS 'AES-GCM encrypted access token; set only by calendar-sync Edge Function.';
COMMENT ON COLUMN public.calendar_connection_tokens.refresh_token_encrypted IS 'AES-GCM encrypted refresh token; set only by calendar-sync Edge Function.';
COMMENT ON COLUMN public.calendar_connection_tokens.oauth_state IS 'Temporary CSRF nonce during OAuth connect; cleared after callback.';
