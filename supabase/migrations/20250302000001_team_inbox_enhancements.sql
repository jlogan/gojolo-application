-- ============================================================
-- Team Inbox: enhanced messages, internal notes, contact matching,
-- compose/forward support, thread participants
-- ============================================================

-- 1. Enhance inbox_messages with email headers and HTML body
ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS cc text,
  ADD COLUMN IF NOT EXISTS bcc text,
  ADD COLUMN IF NOT EXISTS html_body text,
  ADD COLUMN IF NOT EXISTS message_id_header text,
  ADD COLUMN IF NOT EXISTS in_reply_to_header text,
  ADD COLUMN IF NOT EXISTS references_header text;

-- 2. Enhance inbox_threads with account reference and participants
ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS imap_account_id uuid REFERENCES public.imap_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS from_address text,
  ADD COLUMN IF NOT EXISTS to_addresses text[];

CREATE INDEX IF NOT EXISTS idx_inbox_threads_account ON public.inbox_threads(imap_account_id);

-- 3. Internal notes per thread (team collaboration)
CREATE TABLE IF NOT EXISTS public.inbox_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_inbox_notes_thread ON public.inbox_notes(thread_id);

ALTER TABLE public.inbox_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inbox_notes_select" ON public.inbox_notes FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_notes.thread_id
  ));
CREATE POLICY "inbox_notes_insert" ON public.inbox_notes FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_notes.thread_id
    )
  );
CREATE POLICY "inbox_notes_delete" ON public.inbox_notes FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- 4. Link inbox threads to contacts (auto-matched by email/phone)
CREATE TABLE IF NOT EXISTS public.inbox_thread_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(thread_id, contact_id)
);

CREATE INDEX idx_inbox_thread_contacts_thread ON public.inbox_thread_contacts(thread_id);
CREATE INDEX idx_inbox_thread_contacts_contact ON public.inbox_thread_contacts(contact_id);

ALTER TABLE public.inbox_thread_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "itc_select" ON public.inbox_thread_contacts FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_thread_contacts.thread_id
  ));
CREATE POLICY "itc_insert" ON public.inbox_thread_contacts FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_thread_contacts.thread_id
  ));
CREATE POLICY "itc_delete" ON public.inbox_thread_contacts FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_thread_contacts.thread_id
  ));

-- 5. Auto-match function: find contacts by email and link to thread
CREATE OR REPLACE FUNCTION public.match_thread_contacts(p_thread_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_matched int := 0;
  v_email text;
BEGIN
  SELECT org_id INTO v_org_id FROM inbox_threads WHERE id = p_thread_id;
  IF v_org_id IS NULL THEN RETURN 0; END IF;

  FOR v_email IN
    SELECT DISTINCT unnest(
      ARRAY[m.from_identifier, m.to_identifier] ||
      COALESCE(string_to_array(m.cc, ','), '{}')
    )
    FROM inbox_messages m WHERE m.thread_id = p_thread_id
  LOOP
    v_email := LOWER(TRIM(v_email));
    IF v_email IS NOT NULL AND v_email LIKE '%@%' THEN
      INSERT INTO inbox_thread_contacts (thread_id, contact_id)
      SELECT p_thread_id, c.id
      FROM contacts c
      WHERE c.org_id = v_org_id AND LOWER(TRIM(c.email)) = v_email
      ON CONFLICT (thread_id, contact_id) DO NOTHING;
      GET DIAGNOSTICS v_matched = ROW_COUNT;
    END IF;
  END LOOP;

  RETURN v_matched;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_thread_contacts(uuid) TO authenticated;

-- 6. Enable Realtime on inbox tables for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_threads;
ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_notes;

-- 7. Profiles: allow org members to read each other's profiles (for displaying names in inbox)
CREATE POLICY "profiles_select_org_member" ON public.profiles FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT ou2.user_id FROM public.organization_users ou1
      JOIN public.organization_users ou2 ON ou2.org_id = ou1.org_id
      WHERE ou1.user_id = auth.uid()
    )
  );
