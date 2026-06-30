-- Invoice-level payment method preferences and public bank-transfer details
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_methods jsonb NOT NULL DEFAULT '{"stripe": true, "paypal": true, "bank_transfer": false}'::jsonb,
  ADD COLUMN IF NOT EXISTS bank_payment_details text;

COMMENT ON COLUMN public.invoices.payment_methods IS 'Invoice-level public payment method visibility: stripe, paypal, bank_transfer.';
COMMENT ON COLUMN public.invoices.bank_payment_details IS 'Optional bank transfer instructions shown on the public invoice page.';

-- Public invoice RPC: returns sanitized invoice payload by hash (no auth required)
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
  v_stripe_configured boolean;
  v_paypal_configured boolean;
  v_bank_enabled boolean;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE hash = p_hash LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT name INTO v_org_name FROM organizations WHERE id = v_invoice.org_id;
  SELECT name INTO v_company_name FROM companies WHERE id = v_invoice.company_id;
  SELECT name, email INTO v_contact_name, v_contact_email FROM contacts WHERE id = v_invoice.contact_id;

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

  SELECT EXISTS (
    SELECT 1 FROM organizations
    WHERE id = v_invoice.org_id
      AND NULLIF(settings->>'stripe_secret_key', '') IS NOT NULL
  ) INTO v_stripe_configured;

  SELECT EXISTS (
    SELECT 1 FROM organizations
    WHERE id = v_invoice.org_id
      AND NULLIF(settings->>'paypal_username', '') IS NOT NULL
      AND NULLIF(settings->>'paypal_password', '') IS NOT NULL
      AND NULLIF(settings->>'paypal_signature', '') IS NOT NULL
  ) INTO v_paypal_configured;

  v_bank_enabled := COALESCE((v_invoice.payment_methods->>'bank_transfer')::boolean, false)
    AND NULLIF(v_invoice.bank_payment_details, '') IS NOT NULL;

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
      'stripe', v_stripe_configured AND COALESCE((v_invoice.payment_methods->>'stripe')::boolean, true),
      'paypal', v_paypal_configured AND COALESCE((v_invoice.payment_methods->>'paypal')::boolean, true),
      'bank_transfer', v_bank_enabled
    ),
    'bankDetails', CASE WHEN v_bank_enabled THEN v_invoice.bank_payment_details ELSE NULL END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_invoice(text) TO anon, authenticated;
