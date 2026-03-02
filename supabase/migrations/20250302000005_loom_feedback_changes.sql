-- ============================================================
-- Loom feedback: contacts overhaul, workspace creation,
-- thread read status, thread URLs, search
-- ============================================================

-- 1. Multiple emails per contact
CREATE TABLE IF NOT EXISTS public.contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  email text NOT NULL,
  label text,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_contact_emails_contact ON public.contact_emails(contact_id);
CREATE INDEX idx_contact_emails_email ON public.contact_emails(LOWER(email));
ALTER TABLE public.contact_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ce_select" ON public.contact_emails FOR SELECT TO authenticated
  USING (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ce_insert" ON public.contact_emails FOR INSERT TO authenticated
  WITH CHECK (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ce_update" ON public.contact_emails FOR UPDATE TO authenticated
  USING (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "ce_delete" ON public.contact_emails FOR DELETE TO authenticated
  USING (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 2. Multiple phones per contact
CREATE TABLE IF NOT EXISTS public.contact_phones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  phone text NOT NULL,
  label text,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_contact_phones_contact ON public.contact_phones(contact_id);
ALTER TABLE public.contact_phones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cp_select" ON public.contact_phones FOR SELECT TO authenticated
  USING (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "cp_insert" ON public.contact_phones FOR INSERT TO authenticated
  WITH CHECK (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "cp_update" ON public.contact_phones FOR UPDATE TO authenticated
  USING (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "cp_delete" ON public.contact_phones FOR DELETE TO authenticated
  USING (contact_id IN (SELECT id FROM contacts WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- 3. Thread read/unread tracking per user
CREATE TABLE IF NOT EXISTS public.inbox_thread_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz DEFAULT now(),
  UNIQUE(thread_id, user_id)
);
CREATE INDEX idx_thread_reads_user ON public.inbox_thread_reads(user_id);
ALTER TABLE public.inbox_thread_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tr_select" ON public.inbox_thread_reads FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "tr_upsert" ON public.inbox_thread_reads FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "tr_update" ON public.inbox_thread_reads FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- 4. Add Gravatar URL helper, notes field, and delete support to contacts
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS avatar_url text;

-- 5. Allow any authenticated user to create organizations (open workspace creation)
-- The existing policy already allows this: orgs_insert_authenticated WITH CHECK (true)
-- But create_organization RPC restricts to platform admins. Let's create an open version.
CREATE OR REPLACE FUNCTION public.create_workspace(ws_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid;
  new_org_id uuid;
  admin_role_id uuid;
  ws_slug text;
  new_org jsonb;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  ws_slug := LOWER(REGEXP_REPLACE(TRIM(ws_name), '[^a-zA-Z0-9]+', '-', 'g'));
  ws_slug := ws_slug || '-' || SUBSTRING(gen_random_uuid()::text FROM 1 FOR 8);

  INSERT INTO organizations (name, slug) VALUES (TRIM(ws_name), ws_slug) RETURNING id INTO new_org_id;
  SELECT id INTO admin_role_id FROM roles WHERE name = 'admin' LIMIT 1;
  INSERT INTO organization_users (org_id, user_id, role_id) VALUES (new_org_id, uid, admin_role_id);

  SELECT to_jsonb(o.*) INTO new_org FROM organizations o WHERE o.id = new_org_id;
  RETURN new_org;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_workspace(text) TO authenticated;

-- 6. Enhanced contact matching: match by any email in contact_emails table too
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
  v_rows int;
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
      -- Match by contacts.email
      INSERT INTO inbox_thread_contacts (thread_id, contact_id)
      SELECT p_thread_id, c.id FROM contacts c
      WHERE c.org_id = v_org_id AND LOWER(TRIM(c.email)) = v_email
      ON CONFLICT (thread_id, contact_id) DO NOTHING;
      -- Match by contact_emails
      INSERT INTO inbox_thread_contacts (thread_id, contact_id)
      SELECT p_thread_id, ce.contact_id FROM contact_emails ce
      JOIN contacts c ON c.id = ce.contact_id
      WHERE c.org_id = v_org_id AND LOWER(TRIM(ce.email)) = v_email
      ON CONFLICT (thread_id, contact_id) DO NOTHING;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_matched FROM inbox_thread_contacts WHERE thread_id = p_thread_id;
  RETURN v_matched;
END;
$$;

-- 7. Chat sessions table for persistent chat history per project
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_chat_sessions_org ON public.chat_sessions(org_id, user_id);
CREATE INDEX idx_chat_sessions_project ON public.chat_sessions(project_id);
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cs_select" ON public.chat_sessions FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "cs_insert" ON public.chat_sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Update chat_messages to reference sessions
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON public.chat_messages(session_id);

-- 8. Add full-text search index on inbox threads and messages
CREATE INDEX IF NOT EXISTS idx_inbox_threads_subject_search ON public.inbox_threads USING gin(to_tsvector('english', COALESCE(subject, '')));
CREATE INDEX IF NOT EXISTS idx_inbox_messages_body_search ON public.inbox_messages USING gin(to_tsvector('english', COALESCE(body, '')));
