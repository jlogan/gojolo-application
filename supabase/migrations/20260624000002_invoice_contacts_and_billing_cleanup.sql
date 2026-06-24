-- Invoice contacts + billing status cleanup from accounting Loom feedback

CREATE TABLE IF NOT EXISTS public.invoice_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(invoice_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_contacts_invoice ON public.invoice_contacts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_contacts_contact ON public.invoice_contacts(contact_id);

ALTER TABLE public.invoice_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_contacts_select" ON public.invoice_contacts;
CREATE POLICY "invoice_contacts_select" ON public.invoice_contacts FOR SELECT TO authenticated
  USING (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

DROP POLICY IF EXISTS "invoice_contacts_manage" ON public.invoice_contacts;
CREATE POLICY "invoice_contacts_manage" ON public.invoice_contacts FOR ALL TO authenticated
  USING (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())))
  WITH CHECK (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

INSERT INTO public.invoice_contacts (invoice_id, contact_id, is_primary)
SELECT id, contact_id, true
FROM public.invoices
WHERE contact_id IS NOT NULL
ON CONFLICT (invoice_id, contact_id) DO NOTHING;

-- Keep time_logs.billed in sync with actual invoice_items linkage, including edits/deletes.
CREATE OR REPLACE FUNCTION public.sync_time_logs_billed_from_invoice_items()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  affected_ids uuid[];
BEGIN
  affected_ids := ARRAY(
    SELECT DISTINCT unnest(COALESCE(NEW.time_log_ids, '{}'::uuid[]) || COALESCE(OLD.time_log_ids, '{}'::uuid[]))
  );

  IF array_length(affected_ids, 1) IS NOT NULL THEN
    UPDATE public.time_logs tl
    SET billed = EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      WHERE tl.id = ANY(ii.time_log_ids)
        AND ii.id <> COALESCE(OLD.id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE tl.id = ANY(affected_ids);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.time_log_ids IS NOT NULL AND array_length(NEW.time_log_ids, 1) > 0 THEN
    UPDATE public.time_logs SET billed = true WHERE id = ANY(NEW.time_log_ids);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_mark_time_logs_billed ON public.invoice_items;
DROP TRIGGER IF EXISTS trg_sync_time_logs_billed ON public.invoice_items;
CREATE TRIGGER trg_sync_time_logs_billed
AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public.sync_time_logs_billed_from_invoice_items();

-- Jay wants only draft/unpaid/paid/cancelled for invoice status. Treat legacy sent/viewed/overdue as unpaid.
UPDATE public.invoices SET status = 'unpaid' WHERE status IN ('sent', 'viewed', 'overdue', 'partial', 'partially_paid');

CREATE OR REPLACE FUNCTION public.recalc_invoice_payments()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_paid decimal(15,2);
  v_total decimal(15,2);
  v_inv_id uuid;
BEGIN
  v_inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM public.invoice_payments WHERE invoice_id = v_inv_id;

  SELECT total INTO v_total FROM public.invoices WHERE id = v_inv_id;

  UPDATE public.invoices SET
    amount_paid = v_paid,
    amount_due = COALESCE(v_total, 0) - v_paid,
    status = CASE
      WHEN v_paid >= COALESCE(v_total, 0) THEN 'paid'
      WHEN status = 'cancelled' THEN 'cancelled'
      WHEN status = 'draft' AND v_paid = 0 THEN 'draft'
      ELSE 'unpaid'
    END,
    paid_date = CASE WHEN v_paid >= COALESCE(v_total, 0) THEN CURRENT_DATE ELSE NULL END,
    updated_at = now()
  WHERE id = v_inv_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Public invoice RPC updated for multiple contacts and unpaid payment state.
CREATE OR REPLACE FUNCTION public.get_public_invoice(p_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_org_name text;
  v_company_name text;
  v_contact_name text;
  v_contact_email text;
  v_items jsonb;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE hash = p_hash LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT name INTO v_org_name FROM organizations WHERE id = v_invoice.org_id;
  SELECT name INTO v_company_name FROM companies WHERE id = v_invoice.company_id;

  SELECT
    string_agg(c.name, ', ' ORDER BY ic.is_primary DESC, c.name),
    string_agg(c.email, ', ' ORDER BY ic.is_primary DESC, c.name)
  INTO v_contact_name, v_contact_email
  FROM invoice_contacts ic
  JOIN contacts c ON c.id = ic.contact_id
  WHERE ic.invoice_id = v_invoice.id;

  IF v_contact_name IS NULL AND v_invoice.contact_id IS NOT NULL THEN
    SELECT name, email INTO v_contact_name, v_contact_email FROM contacts WHERE id = v_invoice.contact_id;
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'description', description,
      'long_description', long_description,
      'quantity', quantity,
      'unit', unit,
      'unit_price', unit_price,
      'subtotal', subtotal,
      'total', total,
      'sort_order', sort_order
    ) ORDER BY sort_order
  ) INTO v_items FROM invoice_items WHERE invoice_id = v_invoice.id;

  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_invoice.id,
      'number', v_invoice.number,
      'prefix', v_invoice.prefix,
      'status', v_invoice.status,
      'issue_date', v_invoice.issue_date,
      'due_date', v_invoice.due_date,
      'subtotal', v_invoice.subtotal,
      'tax_total', v_invoice.tax_total,
      'discount_total', v_invoice.discount_total,
      'adjustment', v_invoice.adjustment,
      'total', v_invoice.total,
      'amount_paid', v_invoice.amount_paid,
      'amount_due', v_invoice.amount_due,
      'notes', v_invoice.notes,
      'terms', v_invoice.terms,
      'hash', v_invoice.hash
    ),
    'org', jsonb_build_object('name', v_org_name),
    'billTo', jsonb_build_object(
      'company', v_company_name,
      'contact', v_contact_name,
      'email', v_contact_email
    ),
    'items', COALESCE(v_items, '[]'::jsonb),
    'paymentMethods', jsonb_build_object(
      'stripe', EXISTS (
        SELECT 1 FROM organizations
        WHERE id = v_invoice.org_id
          AND NULLIF(settings->>'stripe_secret_key', '') IS NOT NULL
      ),
      'paypal', EXISTS (
        SELECT 1 FROM organizations
        WHERE id = v_invoice.org_id
          AND NULLIF(settings->>'paypal_username', '') IS NOT NULL
          AND NULLIF(settings->>'paypal_password', '') IS NOT NULL
          AND NULLIF(settings->>'paypal_signature', '') IS NOT NULL
      )
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_invoice(text) TO anon, authenticated;
