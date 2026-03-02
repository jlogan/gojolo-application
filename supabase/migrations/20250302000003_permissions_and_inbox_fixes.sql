-- ============================================================
-- Granular permissions system + inbox fixes
-- ============================================================

-- 1. Granular permissions table
-- Each permission is: module + action (e.g. 'inbox.view', 'projects.create')
CREATE TABLE IF NOT EXISTS public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(role_id, permission)
);

CREATE INDEX idx_role_permissions_role ON public.role_permissions(role_id);
CREATE INDEX idx_role_permissions_perm ON public.role_permissions(permission);

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rp_select" ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "rp_insert_admin" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());
CREATE POLICY "rp_delete_admin" ON public.role_permissions FOR DELETE TO authenticated
  USING (public.is_platform_admin());

-- 2. Seed permissions for existing roles
-- Module permissions: module.action
-- Modules: projects, contacts, companies, inbox
-- Actions: view, create, update, delete
-- Special: inbox.message (can send), inbox.delete (can trash)

-- Admin role: all permissions
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('projects.view'), ('projects.create'), ('projects.update'), ('projects.delete'),
  ('contacts.view'), ('contacts.create'), ('contacts.update'), ('contacts.delete'),
  ('companies.view'), ('companies.create'), ('companies.update'), ('companies.delete'),
  ('inbox.view'), ('inbox.message'), ('inbox.delete')
) AS p(perm)
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Member role: view + create + update for all modules, inbox view + message
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('projects.view'), ('projects.create'), ('projects.update'),
  ('contacts.view'), ('contacts.create'), ('contacts.update'),
  ('companies.view'), ('companies.create'), ('companies.update'),
  ('inbox.view'), ('inbox.message')
) AS p(perm)
WHERE r.name = 'member'
ON CONFLICT (role_id, permission) DO NOTHING;

-- 3. Helper function: check if current user has a specific permission in an org
CREATE OR REPLACE FUNCTION public.user_has_permission(p_org_id uuid, p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_users ou
    JOIN role_permissions rp ON rp.role_id = ou.role_id
    WHERE ou.org_id = p_org_id
      AND ou.user_id = auth.uid()
      AND rp.permission = p_permission
  ) OR public.is_platform_admin();
$$;

GRANT EXECUTE ON FUNCTION public.user_has_permission(uuid, text) TO authenticated;

-- 4. Helper: get all users in an org who have a specific permission
CREATE OR REPLACE FUNCTION public.org_users_with_permission(p_org_id uuid, p_permission text)
RETURNS TABLE(user_id uuid, display_name text, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ou.user_id, pr.display_name, pr.email
  FROM organization_users ou
  JOIN role_permissions rp ON rp.role_id = ou.role_id
  JOIN profiles pr ON pr.id = ou.user_id
  WHERE ou.org_id = p_org_id AND rp.permission = p_permission
  UNION
  SELECT pa.user_id, pr.display_name, pr.email
  FROM platform_admins pa
  JOIN profiles pr ON pr.id = pa.user_id
  JOIN organization_users ou ON ou.user_id = pa.user_id AND ou.org_id = p_org_id;
$$;

GRANT EXECUTE ON FUNCTION public.org_users_with_permission(uuid, text) TO authenticated;

-- 5. Rename inbox_notes to inbox_comments (branding)
ALTER TABLE public.inbox_notes RENAME TO inbox_comments;
ALTER INDEX idx_inbox_notes_thread RENAME TO idx_inbox_comments_thread;

-- Add mentions support
ALTER TABLE public.inbox_comments
  ADD COLUMN IF NOT EXISTS mentions uuid[] DEFAULT '{}';

-- Update RLS policies for renamed table
DROP POLICY IF EXISTS "inbox_notes_select" ON public.inbox_comments;
DROP POLICY IF EXISTS "inbox_notes_insert" ON public.inbox_comments;
DROP POLICY IF EXISTS "inbox_notes_delete" ON public.inbox_comments;

CREATE POLICY "inbox_comments_select" ON public.inbox_comments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_comments.thread_id
  ));
CREATE POLICY "inbox_comments_insert" ON public.inbox_comments FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
      WHERE t.id = inbox_comments.thread_id
    )
  );
CREATE POLICY "inbox_comments_delete" ON public.inbox_comments FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Update realtime publication (inbox_comments was previously inbox_notes)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.inbox_notes;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_comments;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. Create "Account Manager" and "Vendor" roles with permissions
INSERT INTO public.roles (name, permissions)
VALUES ('account_manager', '{"account_manager": true}'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.roles (name, permissions)
VALUES ('vendor', '{"vendor": true}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Account Manager: all permissions (same as admin for now)
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('projects.view'), ('projects.create'), ('projects.update'), ('projects.delete'),
  ('contacts.view'), ('contacts.create'), ('contacts.update'), ('contacts.delete'),
  ('companies.view'), ('companies.create'), ('companies.update'), ('companies.delete'),
  ('inbox.view'), ('inbox.message'), ('inbox.delete')
) AS p(perm)
WHERE r.name = 'account_manager'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Vendor: projects only
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('projects.view'), ('projects.create'), ('projects.update')
) AS p(perm)
WHERE r.name = 'vendor'
ON CONFLICT (role_id, permission) DO NOTHING;

-- 7. Assign Account Manager role to Brogrammers Agency (if exists)
-- This is idempotent: only inserts if the org and role exist
DO $$
DECLARE
  v_org_id uuid;
  v_role_id uuid;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations WHERE slug = 'brogrammers-agency';
  SELECT id INTO v_role_id FROM public.roles WHERE name = 'account_manager';
  -- Role exists for use; no auto-assignment needed (admin assigns via UI)
END;
$$;
