-- Allow admins to check if the notification queue processor is configured (app_config has required keys).
-- Does not expose secret or URL; used by Admin UI to show "Configured" vs "Not configured — see SECRETS.md".
CREATE OR REPLACE FUNCTION public.get_notification_processor_configured()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT (
    EXISTS (SELECT 1 FROM app_config WHERE key = 'supabase_url' AND value IS NOT NULL AND trim(value) <> '')
    AND EXISTS (SELECT 1 FROM app_config WHERE key = 'notification_internal_secret' AND value IS NOT NULL AND trim(value) <> '')
  );
$$;

COMMENT ON FUNCTION public.get_notification_processor_configured() IS 'Returns true if app_config has supabase_url and notification_internal_secret set (for Profile → Notifications DM/email delivery). Does not expose values.';

GRANT EXECUTE ON FUNCTION public.get_notification_processor_configured() TO authenticated;
