-- Tag contacts/companies created from the lead funnel for filtering (vs customer records).

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS sourced_from_lead boolean NOT NULL DEFAULT false;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS sourced_from_lead boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.contacts.sourced_from_lead IS 'True when this contact was created from a lead/opportunity flow (prospect), not a manual customer record.';
COMMENT ON COLUMN public.companies.sourced_from_lead IS 'True when this company was created from a lead/opportunity flow.';

-- Backfill existing wizard data
UPDATE public.contacts SET sourced_from_lead = true WHERE type = 'lead' AND sourced_from_lead = false;

UPDATE public.companies c
SET sourced_from_lead = true
FROM public.leads l
WHERE l.company_id = c.id AND c.sourced_from_lead = false;
