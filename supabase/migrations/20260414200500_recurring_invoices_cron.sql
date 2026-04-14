-- Schedule daily recurring invoice processing via pg_cron + pg_net
-- Runs at 6:00 AM UTC every day

-- Ensure required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;

-- Schedule the cron job
-- Uses net.http_post to call the Edge Function with service_role key
SELECT cron.schedule(
  'process-recurring-invoices-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://apqtjqcezkupjkkhlwxy.supabase.co/functions/v1/process-recurring-invoices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
