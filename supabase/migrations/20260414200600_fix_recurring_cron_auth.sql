-- Update recurring invoices cron to use vault-based auth (matching imap-sync pattern)

-- Remove the old job if it exists
SELECT cron.unschedule('process-recurring-invoices-daily');

-- Re-create with vault-based service_role_key auth
SELECT cron.schedule(
  'process-recurring-invoices-daily',
  '0 6 * * *',
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
