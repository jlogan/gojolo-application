-- Fan out IMAP sync cron: one Edge Function invocation per active account instead of
-- syncing every org in a single request. Vault secrets: supabase_url, imap_sync_cron_secret.

CREATE OR REPLACE FUNCTION public.trigger_imap_sync_for_active_accounts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account record;
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
    RAISE WARNING 'trigger_imap_sync_for_active_accounts: missing vault secrets (supabase_url or imap_sync_cron_secret)';
    RETURN;
  END IF;

  FOR v_account IN
    SELECT id, org_id
    FROM public.imap_accounts
    WHERE is_active = true
    ORDER BY email
  LOOP
    PERFORM net.http_post(
      url := v_url || '/functions/v1/imap-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_cron_secret
      ),
      body := jsonb_build_object(
        'orgId', v_account.org_id,
        'accountId', v_account.id
      )
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.trigger_imap_sync_for_active_accounts() IS
  'Cron wrapper: POST imap-sync once per active imap_accounts row (ordered by email).';

-- Reschedule imap-sync-every-2-min: job name kept for continuity; actual interval is 5 minutes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'imap-sync-every-2-min';

    PERFORM cron.schedule(
      'imap-sync-every-2-min',
      '*/5 * * * *',
      $CRON$
      SELECT public.trigger_imap_sync_for_active_accounts();
      $CRON$
    );
  END IF;
END
$$;
