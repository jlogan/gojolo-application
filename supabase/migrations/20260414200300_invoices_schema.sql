-- ============================================================
-- Invoices Schema Migration
-- Currencies, Tax Rates, Invoices, Line Items, Payments, Expenses
-- Plus triggers and functions for auto-calculations
-- ============================================================

-- Currencies (org-level config)
CREATE TABLE IF NOT EXISTS public.currencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,          -- USD, EUR, GBP
  name text NOT NULL,          -- US Dollar
  symbol text NOT NULL,        -- $
  decimal_separator text DEFAULT '.',
  thousand_separator text DEFAULT ',',
  placement text DEFAULT 'before',  -- before or after
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, code)
);
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "currencies_select" ON public.currencies FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "currencies_manage" ON public.currencies FOR ALL TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Tax rates
CREATE TABLE IF NOT EXISTS public.tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,          -- "Sales Tax", "VAT"
  rate decimal(5,2) NOT NULL,  -- 8.50 = 8.5%
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_select" ON public.tax_rates FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "tax_manage" ON public.tax_rates FOR ALL TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Invoices (unified: direction = 'outbound' for client invoices, 'inbound' for vendor bills)
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  direction text NOT NULL DEFAULT 'outbound',  -- 'outbound' or 'inbound'
  number integer,
  prefix text DEFAULT 'INV-',
  status text NOT NULL DEFAULT 'draft',
  -- Statuses: draft, sent, unpaid, partially_paid, paid, overdue, cancelled

  -- Counterparty (client or vendor)
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  vendor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- for inbound: the vendor org member

  -- Project link
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,

  -- Dates
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  paid_date date,

  -- Amounts
  currency_id uuid REFERENCES public.currencies(id) ON DELETE SET NULL,
  subtotal decimal(15,2) DEFAULT 0,
  tax_total decimal(15,2) DEFAULT 0,
  discount_type text,         -- 'percent' or 'fixed'
  discount_value decimal(15,2) DEFAULT 0,
  discount_total decimal(15,2) DEFAULT 0,
  adjustment decimal(15,2) DEFAULT 0,
  total decimal(15,2) DEFAULT 0,
  amount_paid decimal(15,2) DEFAULT 0,
  amount_due decimal(15,2) DEFAULT 0,

  -- Notes
  notes text,
  terms text,

  -- Recurring
  is_recurring boolean DEFAULT false,
  recurring_interval text,     -- 'weekly', 'monthly', 'quarterly', 'yearly'
  next_recurring_date date,

  -- Access
  hash text DEFAULT encode(gen_random_bytes(16), 'hex'),  -- public access link

  -- Stripe
  stripe_payment_intent_id text,
  stripe_invoice_id text,

  -- Meta
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_invoices_org ON public.invoices(org_id);
CREATE INDEX idx_invoices_status ON public.invoices(status);
CREATE INDEX idx_invoices_direction ON public.invoices(direction);
CREATE INDEX idx_invoices_project ON public.invoices(project_id);
CREATE INDEX idx_invoices_company ON public.invoices(company_id);
CREATE INDEX idx_invoices_vendor_user ON public.invoices(vendor_user_id);
CREATE INDEX idx_invoices_hash ON public.invoices(hash);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- Org members can see all invoices in their org
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "invoices_insert" ON public.invoices FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "invoices_update" ON public.invoices FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "invoices_delete" ON public.invoices FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- Invoice line items
CREATE TABLE IF NOT EXISTS public.invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  long_description text,
  quantity decimal(15,2) NOT NULL DEFAULT 1,
  unit_price decimal(15,2) NOT NULL DEFAULT 0,
  unit text DEFAULT 'hours',   -- hours, qty, etc.
  tax_rate_id uuid REFERENCES public.tax_rates(id) ON DELETE SET NULL,
  tax_amount decimal(15,2) DEFAULT 0,
  subtotal decimal(15,2) DEFAULT 0,  -- qty * unit_price
  total decimal(15,2) DEFAULT 0,     -- subtotal + tax
  sort_order integer DEFAULT 0,

  -- Link to time logs (when generated from timesheets)
  time_log_ids uuid[] DEFAULT '{}',

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_invoice_items_invoice ON public.invoice_items(invoice_id);
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inv_items_select" ON public.invoice_items FOR SELECT TO authenticated
  USING (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "inv_items_manage" ON public.invoice_items FOR ALL TO authenticated
  USING (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- Payment records
CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount decimal(15,2) NOT NULL,
  payment_method text,          -- 'stripe', 'bank_transfer', 'cash', 'check', etc.
  transaction_id text,          -- Stripe payment intent ID, check number, etc.
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_inv_payments_invoice ON public.invoice_payments(invoice_id);
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inv_pay_select" ON public.invoice_payments FOR SELECT TO authenticated
  USING (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));
CREATE POLICY "inv_pay_manage" ON public.invoice_payments FOR ALL TO authenticated
  USING (invoice_id IN (SELECT id FROM invoices WHERE org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())));

-- Expenses
CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'general',
  name text NOT NULL,
  amount decimal(15,2) NOT NULL,
  currency_id uuid REFERENCES public.currencies(id) ON DELETE SET NULL,
  tax_rate_id uuid REFERENCES public.tax_rates(id) ON DELETE SET NULL,
  tax_amount decimal(15,2) DEFAULT 0,
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  billable boolean DEFAULT false,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,  -- when billed
  payment_method text,
  receipt_path text,           -- Supabase Storage path
  note text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_expenses_org ON public.expenses(org_id);
CREATE INDEX idx_expenses_project ON public.expenses(project_id);
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expenses_select" ON public.expenses FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));
CREATE POLICY "expenses_manage" ON public.expenses FOR ALL TO authenticated
  USING (org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid()));

-- ============================================================
-- Functions & Triggers
-- ============================================================

-- Auto-increment invoice numbers per org
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_org_id uuid, p_direction text DEFAULT 'outbound')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_next integer;
BEGIN
  SELECT COALESCE(MAX(number), 0) + 1 INTO v_next
  FROM public.invoices
  WHERE org_id = p_org_id AND direction = p_direction;
  RETURN v_next;
END;
$$;

-- Update invoice totals trigger
CREATE OR REPLACE FUNCTION public.recalc_invoice_totals()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_subtotal decimal(15,2);
  v_tax decimal(15,2);
  v_inv record;
  v_discount decimal(15,2);
  v_total decimal(15,2);
BEGIN
  SELECT COALESCE(SUM(subtotal), 0), COALESCE(SUM(tax_amount), 0)
  INTO v_subtotal, v_tax
  FROM public.invoice_items
  WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT * INTO v_inv FROM public.invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  IF v_inv.discount_type = 'percent' THEN
    v_discount := v_subtotal * COALESCE(v_inv.discount_value, 0) / 100;
  ELSE
    v_discount := COALESCE(v_inv.discount_value, 0);
  END IF;

  v_total := v_subtotal + v_tax - v_discount + COALESCE(v_inv.adjustment, 0);

  UPDATE public.invoices SET
    subtotal = v_subtotal,
    tax_total = v_tax,
    discount_total = v_discount,
    total = v_total,
    amount_due = v_total - COALESCE(v_inv.amount_paid, 0),
    updated_at = now()
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_recalc_invoice_totals
AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public.recalc_invoice_totals();

-- Update amount_paid when payments change
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
      WHEN v_paid > 0 THEN 'partially_paid'
      ELSE status
    END,
    paid_date = CASE WHEN v_paid >= COALESCE(v_total, 0) THEN CURRENT_DATE ELSE NULL END,
    updated_at = now()
  WHERE id = v_inv_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_recalc_invoice_payments
AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
FOR EACH ROW EXECUTE FUNCTION public.recalc_invoice_payments();

-- Mark time_logs as billed when linked to an invoice item
CREATE OR REPLACE FUNCTION public.mark_time_logs_billed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.time_log_ids IS NOT NULL AND array_length(NEW.time_log_ids, 1) > 0 THEN
    UPDATE public.time_logs SET billed = true WHERE id = ANY(NEW.time_log_ids);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mark_time_logs_billed
AFTER INSERT ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public.mark_time_logs_billed();

-- Stripe config stored in organizations.settings jsonb:
-- settings.stripe_secret_key (encrypted), settings.stripe_publishable_key
-- No schema change needed — organizations.settings already exists as jsonb
