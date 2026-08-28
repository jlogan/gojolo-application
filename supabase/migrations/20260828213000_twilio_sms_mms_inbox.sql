-- Twilio SMS/MMS inbox foundation.
-- Adds per-org Twilio account credentials, richer phone-number metadata,
-- channel support for SMS/MMS in the unified inbox, delivery tracking, and
-- opt-out tracking for compliance.

CREATE TABLE IF NOT EXISTS public.twilio_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_sid text NOT NULL,
  auth_token_encrypted text,
  label text,
  is_active boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_sid)
);

CREATE INDEX IF NOT EXISTS idx_twilio_accounts_org_id ON public.twilio_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_twilio_accounts_active ON public.twilio_accounts(org_id, is_active);

ALTER TABLE public.twilio_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "twilio_accounts_select" ON public.twilio_accounts;
CREATE POLICY "twilio_accounts_select" ON public.twilio_accounts FOR SELECT TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "twilio_accounts_insert" ON public.twilio_accounts;
CREATE POLICY "twilio_accounts_insert" ON public.twilio_accounts FOR INSERT TO authenticated
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "twilio_accounts_update" ON public.twilio_accounts;
CREATE POLICY "twilio_accounts_update" ON public.twilio_accounts FOR UPDATE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin())
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "twilio_accounts_delete" ON public.twilio_accounts;
CREATE POLICY "twilio_accounts_delete" ON public.twilio_accounts FOR DELETE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS twilio_account_id uuid REFERENCES public.twilio_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sms_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mms_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inbound_webhook_url text,
  ADD COLUMN IF NOT EXISTS status_callback_url text;

CREATE INDEX IF NOT EXISTS idx_phone_numbers_twilio_account_id ON public.phone_numbers(twilio_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_twilio_sid ON public.phone_numbers(twilio_sid) WHERE twilio_sid IS NOT NULL;

-- Expand inbox channel checks from email/sms to email/sms/mms without assuming
-- old constraint names from prior migrations.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.inbox_threads'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%channel%'
  LOOP
    EXECUTE format('ALTER TABLE public.inbox_threads DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.inbox_threads
  ADD CONSTRAINT inbox_threads_channel_check CHECK (channel IN ('email', 'sms', 'mms'));

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS external_thread_key text,
  ADD COLUMN IF NOT EXISTS phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_threads_external_thread_key ON public.inbox_threads(org_id, channel, external_thread_key) WHERE external_thread_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_threads_phone_number_id ON public.inbox_threads(phone_number_id);

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.inbox_messages'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%channel%'
  LOOP
    EXECUTE format('ALTER TABLE public.inbox_messages DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.inbox_messages
  ADD CONSTRAINT inbox_messages_channel_check CHECK (channel IN ('email', 'sms', 'mms'));

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS twilio_message_sid text,
  ADD COLUMN IF NOT EXISTS twilio_status text,
  ADD COLUMN IF NOT EXISTS media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS error_message text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_messages_twilio_sid ON public.inbox_messages(twilio_message_sid) WHERE twilio_message_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_messages_phone_number_id ON public.inbox_messages(phone_number_id) WHERE phone_number_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sms_opt_outs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  opted_out boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'twilio',
  last_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_org_phone ON public.sms_opt_outs(org_id, phone_number);

ALTER TABLE public.sms_opt_outs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_opt_outs_select" ON public.sms_opt_outs;
CREATE POLICY "sms_opt_outs_select" ON public.sms_opt_outs FOR SELECT TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "sms_opt_outs_insert" ON public.sms_opt_outs;
CREATE POLICY "sms_opt_outs_insert" ON public.sms_opt_outs FOR INSERT TO authenticated
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "sms_opt_outs_update" ON public.sms_opt_outs;
CREATE POLICY "sms_opt_outs_update" ON public.sms_opt_outs FOR UPDATE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin())
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "sms_opt_outs_delete" ON public.sms_opt_outs;
CREATE POLICY "sms_opt_outs_delete" ON public.sms_opt_outs FOR DELETE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());
