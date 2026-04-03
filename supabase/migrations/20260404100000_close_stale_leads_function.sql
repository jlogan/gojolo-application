-- Auto-close leads with no qualifying activity for 60+ days (Closed Lost).
-- "Last activity" for this rule is the latest lead_attempts.attempted_at, or leads.created_at if there are no attempts.
-- Schedule execution via Supabase Dashboard → Database → Extensions → pg_cron, or a daily Edge Function that runs:
--   SELECT public.close_stale_leads();

CREATE OR REPLACE FUNCTION public.close_stale_leads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE public.leads l
  SET
    status = 'closed_lost',
    updated_at = now()
  WHERE l.status NOT IN ('closed_won', 'closed_lost')
    AND COALESCE(
      (SELECT MAX(la.attempted_at) FROM public.lead_attempts la WHERE la.lead_id = l.id),
      l.created_at
    ) < (now() AT TIME ZONE 'utc') - interval '60 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.close_stale_leads() FROM PUBLIC;
-- Call from cron / service role / SQL editor (adjust grants to match your scheduler identity).
GRANT EXECUTE ON FUNCTION public.close_stale_leads() TO service_role;

COMMENT ON FUNCTION public.close_stale_leads() IS
  'Sets status to closed_lost when last activity (max attempt or created_at) is older than 60 days. Run daily via pg_cron or scheduler.';
