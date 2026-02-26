-- Schedule imap-sync to run every 2 minutes so all orgs' IMAP accounts are synced.
-- Requires pg_cron and pg_net: enable in Dashboard → Database → Extensions, then run the
-- optional block below (or run it manually in SQL Editor after enabling extensions).
-- Vault secrets: supabase_url, imap_sync_cron_secret (same as CRON_SECRET on imap-sync function).
-- This migration only creates the schedule if the cron schema exists (extensions enabled).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cron') THEN
    PERFORM cron.schedule(
      'imap-sync-every-2-min',
      '*/2 * * * *',
      $CRON$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/imap-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'imap_sync_cron_secret')
        ),
        body := '{}'::jsonb
      ) AS request_id;
      $CRON$
    );
  END IF;
END
$$;
