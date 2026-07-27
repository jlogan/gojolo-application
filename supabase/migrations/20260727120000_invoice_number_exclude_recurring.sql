-- Exclude recurring invoice templates from the per-org invoice number sequence.
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_org_id uuid, p_direction text DEFAULT 'outbound')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_next integer;
BEGIN
  SELECT COALESCE(MAX(number), 0) + 1 INTO v_next
  FROM public.invoices
  WHERE org_id = p_org_id
    AND direction = p_direction
    AND COALESCE(is_recurring, false) = false;
  RETURN v_next;
END;
$$;
