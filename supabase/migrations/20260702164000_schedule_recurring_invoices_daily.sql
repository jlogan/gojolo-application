-- Run recurring invoice generation every day at 8am Eastern during daylight time (12:00 UTC).
-- Replaces the previous Monday-only cron so every due recurring schedule is processed on its due date.

select cron.unschedule('process-recurring-invoices-weekly')
where exists (
  select 1 from cron.job where jobname = 'process-recurring-invoices-weekly'
);

select cron.unschedule('process-recurring-invoices-daily-8am-et')
where exists (
  select 1 from cron.job where jobname = 'process-recurring-invoices-daily-8am-et'
);

select cron.schedule(
  'process-recurring-invoices-daily-8am-et',
  '0 12 * * *',
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
