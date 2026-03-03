-- Optional workspace domain for project Slack channel (e.g. from pasted URL)
-- so we can link the channel name to https://{workspace_domain}.slack.com/archives/{channel_id}
ALTER TABLE public.slack_project_channels
  ADD COLUMN IF NOT EXISTS workspace_domain text;
