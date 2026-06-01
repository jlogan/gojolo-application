-- Unschedule the existing daily cron job
SELECT cron.unschedule('process-recurring-invoices-daily');

-- Schedule a new weekly cron job: every Monday at 6:00 AM UTC
SELECT cron.schedule(
  'process-recurring-invoices-weekly',
  '0 6 * * 1',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/process-recurring-invoices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
