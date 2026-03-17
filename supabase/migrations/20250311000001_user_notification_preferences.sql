-- Per-user, per-org notification delivery preferences (Slack, Email, Both)

CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('slack', 'email', 'both')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, org_id, notification_type)
);

CREATE INDEX idx_user_notification_preferences_user_org ON public.user_notification_preferences(user_id, org_id);

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;

-- Users can read/update only their own preferences for orgs they belong to
CREATE POLICY "unp_select_own" ON public.user_notification_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

CREATE POLICY "unp_insert_own" ON public.user_notification_preferences FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

CREATE POLICY "unp_update_own" ON public.user_notification_preferences FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "unp_delete_own" ON public.user_notification_preferences FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.user_notification_preferences IS 'User choices for how to receive each notification type: slack, email, or both. Scoped per org.';
