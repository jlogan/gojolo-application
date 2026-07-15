-- Use the same Vault-based auth pattern as recurring invoices for vendor bill generation.
-- The previous job used current_setting('app.settings.service_role_key', true), which is empty on hosted Supabase.

select cron.unschedule('generate-vendor-bills-monday-6am-et')
where exists (
  select 1 from cron.job where jobname = 'generate-vendor-bills-monday-6am-et'
);

select cron.schedule(
  'generate-vendor-bills-monday-6am-et',
  '0 10,11 * * 1',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/generate-vendor-bills',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"scheduled":true}'::jsonb
  ) AS request_id;
  $$
);
