-- Schedule vendor bill generation. Supabase cron runs in UTC, so schedule both
-- 10:00 and 11:00 UTC on Mondays and let the Edge Function only execute at
-- 6:00 AM America/New_York (handles EDT/EST safely).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA cron TO postgres;

SELECT cron.unschedule('generate-vendor-bills-monday-6am-et')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'generate-vendor-bills-monday-6am-et');

SELECT cron.schedule(
  'generate-vendor-bills-monday-6am-et',
  '0 10,11 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://apqtjqcezkupjkkhlwxy.supabase.co/functions/v1/generate-vendor-bills',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{"scheduled":true}'::jsonb
  );
  $$
);
