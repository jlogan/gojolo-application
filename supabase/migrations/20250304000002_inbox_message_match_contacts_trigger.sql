-- Run contact matching when a new inbox message is inserted so that
-- notify_slack_on_new_message can route to project Slack channels (based on
-- inbox_thread_contacts -> project_contacts -> slack_project_channels).
-- Trigger name sorts before 'slack_notify_new_message' so this runs first.
CREATE OR REPLACE FUNCTION public.trigger_match_thread_contacts_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM match_thread_contacts(NEW.thread_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inbox_message_match_contacts ON public.inbox_messages;
CREATE TRIGGER inbox_message_match_contacts
  AFTER INSERT ON public.inbox_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_match_thread_contacts_on_message();
