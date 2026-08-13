-- Allow org admins / calendar.manage to rename any connected calendar account.
-- Schedule automated calendar sync every 15 minutes via pg_cron + pg_net.

CREATE OR REPLACE FUNCTION public.update_calendar_connection_label(
  p_org_id uuid,
  p_connection_id uuid,
  p_account_label text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT user_id INTO v_owner_id
  FROM public.calendar_connections
  WHERE id = p_connection_id
    AND org_id = p_org_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Calendar connection not found';
  END IF;

  IF NOT (
    (v_owner_id = auth.uid() AND public.user_has_permission(p_org_id, 'calendar.connect'))
    OR public.is_org_admin(p_org_id)
    OR public.user_has_permission(p_org_id, 'calendar.manage')
  ) THEN
    RAISE EXCEPTION 'Forbidden: calendar.connect, calendar.manage, or org admin required';
  END IF;

  UPDATE public.calendar_connections
  SET
    account_label = NULLIF(trim(p_account_label), ''),
    updated_at = now()
  WHERE id = p_connection_id
    AND org_id = p_org_id;
END;
$$;

COMMENT ON FUNCTION public.update_calendar_connection_label(uuid, uuid, text) IS
  'Update display nickname for a calendar connection. Owners with calendar.connect, org admins, or calendar.manage may rename any org connection.';

GRANT EXECUTE ON FUNCTION public.update_calendar_connection_label(uuid, uuid, text) TO authenticated;

-- Fan out calendar-sync Edge Function once per connected Google account.
-- Vault secrets: supabase_url, imap_sync_cron_secret (same value as CRON_SECRET on calendar-sync).
CREATE OR REPLACE FUNCTION public.trigger_calendar_sync_for_connected()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn record;
  v_url text;
  v_cron_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_url';

  SELECT decrypted_secret INTO v_cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'imap_sync_cron_secret';

  IF v_url IS NULL OR v_cron_secret IS NULL THEN
    RAISE WARNING 'trigger_calendar_sync_for_connected: missing vault secrets (supabase_url or imap_sync_cron_secret)';
    RETURN;
  END IF;

  FOR v_conn IN
    SELECT id, org_id
    FROM public.calendar_connections
    WHERE provider = 'google'
      AND status IN ('connected', 'error')
    ORDER BY org_id, email NULLS LAST, id
  LOOP
    PERFORM net.http_post(
      url := v_url || '/functions/v1/calendar-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_cron_secret
      ),
      body := jsonb_build_object(
        'action', 'sync',
        'orgId', v_conn.org_id,
        'connectionId', v_conn.id,
        'provider', 'google'
      )
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.trigger_calendar_sync_for_connected() IS
  'Cron wrapper: POST calendar-sync once per connected Google calendar_connections row.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'calendar-sync-every-15-min';

    PERFORM cron.schedule(
      'calendar-sync-every-15-min',
      '*/15 * * * *',
      $CRON$
      SELECT public.trigger_calendar_sync_for_connected();
      $CRON$
    );
  END IF;
END
$$;
