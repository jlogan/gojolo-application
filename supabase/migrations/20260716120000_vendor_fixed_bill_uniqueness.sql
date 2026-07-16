-- Vendor default fixed bills are one per vendor per billing period (project_id IS NULL).
-- Hourly and per-project fixed override bills remain keyed by project_id.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inbound_vendor_period_no_project
  ON public.invoices (org_id, vendor_user_id, billing_period_start, billing_period_end)
  WHERE direction = 'inbound' AND status <> 'cancelled'
    AND vendor_user_id IS NOT NULL AND project_id IS NULL
    AND billing_period_start IS NOT NULL AND billing_period_end IS NOT NULL;
