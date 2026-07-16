-- Keep inbound vendor bills on status 'approved' (UI: Open) when partially paid;
-- outbound client invoices continue to use 'unpaid' for open balance.

CREATE OR REPLACE FUNCTION public.recalc_invoice_payments()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_paid decimal(15,2);
  v_total decimal(15,2);
  v_inv_id uuid;
  v_direction text;
  v_status text;
BEGIN
  v_inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM public.invoice_payments WHERE invoice_id = v_inv_id;

  SELECT total, direction, status
  INTO v_total, v_direction, v_status
  FROM public.invoices WHERE id = v_inv_id;

  UPDATE public.invoices SET
    amount_paid = v_paid,
    amount_due = COALESCE(v_total, 0) - v_paid,
    status = CASE
      WHEN v_paid >= COALESCE(v_total, 0) THEN 'paid'
      WHEN v_status = 'cancelled' THEN 'cancelled'
      WHEN v_status = 'draft' AND v_paid = 0 THEN 'draft'
      WHEN v_direction = 'inbound' THEN 'approved'
      ELSE 'unpaid'
    END,
    paid_date = CASE
      WHEN v_paid >= COALESCE(v_total, 0) THEN (
        SELECT MAX(payment_date)
        FROM public.invoice_payments
        WHERE invoice_id = v_inv_id
      )
      ELSE NULL
    END,
    updated_at = now()
  WHERE id = v_inv_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Repair any inbound bills that were incorrectly set to unpaid by payment recalc.
UPDATE public.invoices
SET status = 'approved', updated_at = now()
WHERE direction = 'inbound'
  AND status = 'unpaid'
  AND COALESCE(amount_paid, 0) < COALESCE(total, 0);
