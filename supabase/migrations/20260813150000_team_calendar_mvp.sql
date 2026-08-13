-- Team Calendar MVP: connections, events, permissions, and RLS

CREATE TABLE IF NOT EXISTS public.calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_account_id text,
  email text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  sync_error text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_org ON public.calendar_connections(org_id);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_user ON public.calendar_connections(user_id);

CREATE TABLE IF NOT EXISTS public.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.calendar_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text,
  description text,
  location text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'default'
    CHECK (visibility IN ('default', 'public', 'private', 'busy_only')),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_org_starts ON public.calendar_events(org_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_starts ON public.calendar_events(user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_connection ON public.calendar_events(connection_id);

ALTER TABLE public.calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

-- Connections: team can see status; users manage their own when allowed to connect
DROP POLICY IF EXISTS "cc_select" ON public.calendar_connections;
CREATE POLICY "cc_select" ON public.calendar_connections FOR SELECT TO authenticated
  USING (public.user_has_permission(org_id, 'calendar.view'));

DROP POLICY IF EXISTS "cc_insert" ON public.calendar_connections;
CREATE POLICY "cc_insert" ON public.calendar_connections FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.user_has_permission(org_id, 'calendar.connect')
  );

DROP POLICY IF EXISTS "cc_update" ON public.calendar_connections;
CREATE POLICY "cc_update" ON public.calendar_connections FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    AND public.user_has_permission(org_id, 'calendar.connect')
  )
  WITH CHECK (
    user_id = auth.uid()
    AND public.user_has_permission(org_id, 'calendar.connect')
  );

DROP POLICY IF EXISTS "cc_delete" ON public.calendar_connections;
CREATE POLICY "cc_delete" ON public.calendar_connections FOR DELETE TO authenticated
  USING (
    (user_id = auth.uid() AND public.user_has_permission(org_id, 'calendar.connect'))
    OR public.is_org_admin(org_id)
    OR public.is_platform_admin()
  );

-- Events: read-only for viewers; writes happen via service role (sync Edge Function)
DROP POLICY IF EXISTS "ce_select" ON public.calendar_events;
CREATE POLICY "ce_select" ON public.calendar_events FOR SELECT TO authenticated
  USING (public.user_has_permission(org_id, 'calendar.view'));

-- Permissions: view for core team roles; connect for admins and account managers
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('calendar.view'), ('calendar.connect')) AS p(perm)
WHERE r.name IN ('admin', 'account_manager')
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, 'calendar.view'
FROM public.roles r
WHERE r.name = 'member'
ON CONFLICT (role_id, permission) DO NOTHING;
