-- Map contacts and companies to Slack channels
CREATE TABLE IF NOT EXISTS public.slack_contact_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  channel_name text,
  created_at timestamptz DEFAULT now(),
  CHECK (contact_id IS NOT NULL OR company_id IS NOT NULL)
);

CREATE INDEX idx_slack_contact_channels_org ON public.slack_contact_channels(org_id);
CREATE INDEX idx_slack_contact_channels_contact ON public.slack_contact_channels(contact_id);
CREATE INDEX idx_slack_contact_channels_company ON public.slack_contact_channels(company_id);

ALTER TABLE public.slack_contact_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scc_select" ON public.slack_contact_channels FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "scc_insert" ON public.slack_contact_channels FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "scc_update" ON public.slack_contact_channels FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "scc_delete" ON public.slack_contact_channels FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Trigger: send Slack notification when a new inbound inbox message arrives
CREATE OR REPLACE FUNCTION public.notify_slack_on_new_message()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_webhook text;
  v_subject text;
  v_channel text;
  v_project_channel text;
BEGIN
  IF NEW.direction <> 'inbound' THEN RETURN NEW; END IF;

  SELECT org_id INTO v_org_id FROM inbox_threads WHERE id = NEW.thread_id;
  IF v_org_id IS NULL THEN RETURN NEW; END IF;

  SELECT webhook_url, default_channel INTO v_webhook, v_channel
  FROM slack_configs WHERE org_id = v_org_id AND is_active = true LIMIT 1;

  IF v_webhook IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(subject, '(No subject)') INTO v_subject FROM inbox_threads WHERE id = NEW.thread_id;

  -- Check if thread is linked to a project with a Slack channel
  SELECT spc.channel_name INTO v_project_channel
  FROM inbox_thread_contacts itc
  JOIN project_contacts pc ON pc.contact_id = itc.contact_id
  JOIN slack_project_channels spc ON spc.project_id = pc.project_id
  WHERE itc.thread_id = NEW.thread_id
  LIMIT 1;

  -- Use project channel if available, otherwise default
  PERFORM net.http_post(
    url := v_webhook,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'channel', COALESCE(v_project_channel, v_channel),
      'text', '📧 New email from ' || NEW.from_identifier || ': *' || v_subject || '*',
      'unfurl_links', false
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS slack_notify_new_message ON public.inbox_messages;
CREATE TRIGGER slack_notify_new_message
  AFTER INSERT ON public.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_slack_on_new_message();
