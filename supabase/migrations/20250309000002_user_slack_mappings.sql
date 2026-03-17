-- Map jolo org users to Slack user IDs so we can @mention or DM them in notifications

CREATE TABLE IF NOT EXISTS public.user_slack_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, user_id)
);

CREATE INDEX idx_user_slack_mappings_org ON public.user_slack_mappings(org_id);
CREATE INDEX idx_user_slack_mappings_user ON public.user_slack_mappings(user_id);

ALTER TABLE public.user_slack_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usm_select" ON public.user_slack_mappings FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

CREATE POLICY "usm_insert" ON public.user_slack_mappings FOR INSERT TO authenticated
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());

CREATE POLICY "usm_update" ON public.user_slack_mappings FOR UPDATE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin())
  WITH CHECK (public.is_org_admin(org_id) OR public.is_platform_admin());

CREATE POLICY "usm_delete" ON public.user_slack_mappings FOR DELETE TO authenticated
  USING (public.is_org_admin(org_id) OR public.is_platform_admin());

COMMENT ON TABLE public.user_slack_mappings IS 'Maps jolo users to Slack member IDs (U...) for @mentions and DMs. Admin configures in Admin > Slack > User mapping.';
