-- Extend imap_accounts for connection and sync (credentials stored server-side only via Edge Function)
ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS imap_username text,
  ADD COLUMN IF NOT EXISTS credentials_encrypted text,
  ADD COLUMN IF NOT EXISTS last_fetch_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_fetched_uid bigint,
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON COLUMN public.imap_accounts.credentials_encrypted IS 'Encrypted IMAP password; set only by Edge Function. Never expose to client.';

-- Inbox threads (unified email + SMS)
CREATE TABLE IF NOT EXISTS public.inbox_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  subject text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_message_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbox_threads_org_id ON public.inbox_threads(org_id);
CREATE INDEX IF NOT EXISTS idx_inbox_threads_org_status ON public.inbox_threads(org_id, status);
CREATE INDEX IF NOT EXISTS idx_inbox_threads_last_message ON public.inbox_threads(org_id, last_message_at DESC);

ALTER TABLE public.inbox_threads ENABLE ROW LEVEL SECURITY;

-- Org members can manage their org's threads
CREATE POLICY "inbox_threads_select" ON public.inbox_threads FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.organization_users ou WHERE ou.org_id = inbox_threads.org_id AND ou.user_id = auth.uid())
  );
CREATE POLICY "inbox_threads_insert" ON public.inbox_threads FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.organization_users ou WHERE ou.org_id = inbox_threads.org_id AND ou.user_id = auth.uid())
  );
CREATE POLICY "inbox_threads_update" ON public.inbox_threads FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.organization_users ou WHERE ou.org_id = inbox_threads.org_id AND ou.user_id = auth.uid())
  );
CREATE POLICY "inbox_threads_delete" ON public.inbox_threads FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.organization_users ou WHERE ou.org_id = inbox_threads.org_id AND ou.user_id = auth.uid())
  );

-- Thread assignments (one assignee per thread for now)
CREATE TABLE IF NOT EXISTS public.inbox_thread_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_at timestamptz DEFAULT now(),
  UNIQUE(thread_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_thread_assignments_thread ON public.inbox_thread_assignments(thread_id);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_assignments_user ON public.inbox_thread_assignments(user_id);

ALTER TABLE public.inbox_thread_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inbox_assignments_select" ON public.inbox_thread_assignments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_thread_assignments.thread_id
    )
  );
CREATE POLICY "inbox_assignments_insert" ON public.inbox_thread_assignments FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_thread_assignments.thread_id
    )
  );
CREATE POLICY "inbox_assignments_update" ON public.inbox_thread_assignments FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_thread_assignments.thread_id
    )
  );
CREATE POLICY "inbox_assignments_delete" ON public.inbox_thread_assignments FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_thread_assignments.thread_id
    )
  );

-- Inbox messages (email or SMS within a thread)
CREATE TABLE IF NOT EXISTS public.inbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_identifier text NOT NULL,
  to_identifier text,
  body text,
  external_id text,
  external_uid bigint,
  imap_account_id uuid REFERENCES public.imap_accounts(id) ON DELETE SET NULL,
  phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  received_at timestamptz DEFAULT now(),
  meta jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread ON public.inbox_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_received ON public.inbox_messages(thread_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_messages_imap_dedup ON public.inbox_messages(imap_account_id, external_uid) WHERE imap_account_id IS NOT NULL AND external_uid IS NOT NULL;

ALTER TABLE public.inbox_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inbox_messages_select" ON public.inbox_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_messages.thread_id
    )
  );
CREATE POLICY "inbox_messages_insert" ON public.inbox_messages FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_messages.thread_id
    )
  );
CREATE POLICY "inbox_messages_update" ON public.inbox_messages FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_messages.thread_id
    )
  );
CREATE POLICY "inbox_messages_delete" ON public.inbox_messages FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_messages.thread_id
    )
  );
