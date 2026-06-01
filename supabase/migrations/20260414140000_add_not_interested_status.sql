-- Add 'not_interested' to leads status check constraint.
-- Used when the candidate reviewed the JD and chose not to apply.
-- Distinct from 'closed_lost' (rejected or stale) — preserves the lead for preference-learning.

ALTER TABLE public.leads DROP CONSTRAINT leads_status_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'researching', 'applying', 'applied', 'follow_up', 'interview', 'closed_won', 'closed_lost', 'not_interested'));
