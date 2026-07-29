-- Keep Jay Coach O IMAP current via the lightweight imap-idle importer.
-- The primary imap-sync cron is still used for all active accounts, but this
-- mailbox has shown long-running/Unexpected close behavior in full sync. The
-- imap-idle function successfully imports new Jay Coach messages and advances
-- last_fetched_uid, so run it as an account-specific safety net.

DO $$
DECLARE
  v_url text;
  v_cron_secret text;
  v_account_id uuid;
  v_org_id uuid;
BEGIN
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_url';

  SELECT decrypted_secret INTO v_cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'imap_sync_cron_secret';

  SELECT id, org_id INTO v_account_id, v_org_id
  FROM public.imap_accounts
  WHERE email = 'jay@coacho.com'
    AND is_active = true
  LIMIT 1;

  IF v_url IS NULL OR v_cron_secret IS NULL THEN
    RAISE WARNING 'jay-coacho-imap-idle: missing vault secrets (supabase_url or imap_sync_cron_secret)';
    RETURN;
  END IF;

  IF v_account_id IS NULL OR v_org_id IS NULL THEN
    RAISE WARNING 'jay-coacho-imap-idle: active jay@coacho.com IMAP account not found';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'jay-coacho-imap-idle-every-5-min';

    PERFORM cron.schedule(
      'jay-coacho-imap-idle-every-5-min',
      '*/5 * * * *',
      format(
        $SQL$
        SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', %L
          ),
          body := jsonb_build_object(
            'orgId', %L,
            'accountId', %L
          )
        );
        $SQL$,
        v_url || '/functions/v1/imap-idle',
        v_cron_secret,
        v_org_id::text,
        v_account_id::text
      )
    );
  END IF;
END
$$;
