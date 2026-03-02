-- In-app notifications
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_notifications_user ON public.notifications(user_id, read_at);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_select" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "notif_update" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "notif_insert" ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Enable realtime on notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- Slack integration config per org (future)
CREATE TABLE IF NOT EXISTS public.slack_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE UNIQUE,
  webhook_url text,
  bot_token text,
  default_channel text,
  is_active boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.slack_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "slack_select" ON public.slack_configs FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "slack_insert" ON public.slack_configs FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR public.is_org_admin(org_id));
CREATE POLICY "slack_update" ON public.slack_configs FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR public.is_org_admin(org_id));

-- Slack channel mapping to projects
CREATE TABLE IF NOT EXISTS public.slack_project_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  channel_name text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, channel_id)
);

ALTER TABLE public.slack_project_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spc_select" ON public.slack_project_channels FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "spc_insert" ON public.slack_project_channels FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "spc_delete" ON public.slack_project_channels FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM projects WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- Function to create notification when someone is mentioned in a comment
CREATE OR REPLACE FUNCTION public.notify_on_mention()
RETURNS trigger AS $$
DECLARE
  v_mentioned_id uuid;
  v_thread_subject text;
  v_commenter_name text;
  v_org_id uuid;
BEGIN
  IF NEW.mentions IS NULL OR array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT org_id INTO v_org_id FROM inbox_threads WHERE id = NEW.thread_id;
  SELECT COALESCE(subject, '(No subject)') INTO v_thread_subject FROM inbox_threads WHERE id = NEW.thread_id;
  SELECT display_name INTO v_commenter_name FROM profiles WHERE id = NEW.user_id;

  FOREACH v_mentioned_id IN ARRAY NEW.mentions LOOP
    INSERT INTO notifications (org_id, user_id, type, title, body, link)
    VALUES (
      v_org_id,
      v_mentioned_id,
      'mention',
      COALESCE(v_commenter_name, 'Someone') || ' mentioned you',
      'In thread: ' || v_thread_subject,
      '/inbox/' || NEW.thread_id
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER notify_on_comment_mention
  AFTER INSERT ON public.inbox_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_mention();
