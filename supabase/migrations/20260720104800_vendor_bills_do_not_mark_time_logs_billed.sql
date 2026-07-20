-- Vendor bills (inbound invoices) may reference time_log_ids for audit/reference,
-- but must not change time_logs.billed. Only outbound/client invoice linkage counts.

CREATE OR REPLACE FUNCTION public.sync_time_logs_billed_from_invoice_items()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  affected_ids uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_ids := ARRAY(
      SELECT DISTINCT unnest(COALESCE(OLD.time_log_ids, '{}'::uuid[]))
    );
  ELSIF TG_OP = 'UPDATE' THEN
    affected_ids := ARRAY(
      SELECT DISTINCT unnest(COALESCE(NEW.time_log_ids, '{}'::uuid[]) || COALESCE(OLD.time_log_ids, '{}'::uuid[]))
    );
  ELSE
    affected_ids := ARRAY(
      SELECT DISTINCT unnest(COALESCE(NEW.time_log_ids, '{}'::uuid[]))
    );
  END IF;

  IF array_length(affected_ids, 1) IS NOT NULL THEN
    UPDATE public.time_logs tl
    SET billed = EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      JOIN public.invoices inv ON inv.id = ii.invoice_id
      WHERE tl.id = ANY(ii.time_log_ids)
        AND inv.direction = 'outbound'
        AND (TG_OP <> 'DELETE' OR ii.id IS DISTINCT FROM OLD.id)
    )
    WHERE tl.id = ANY(affected_ids);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Backfill: clear billed flags that came only from inbound/vendor bill linkage.
UPDATE public.time_logs tl
SET billed = EXISTS (
  SELECT 1
  FROM public.invoice_items ii
  JOIN public.invoices inv ON inv.id = ii.invoice_id
  WHERE tl.id = ANY(ii.time_log_ids)
    AND inv.direction = 'outbound'
);
