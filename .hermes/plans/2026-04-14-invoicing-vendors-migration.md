# Invoicing, Payments & Vendor Portal — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add invoicing (with Stripe payments), vendor portal, expenses, and project billing to jolo — enabling the team to create invoices from logged time, accept payments, and give vendors visibility into their projects/tasks/timesheets/bills.

**Architecture:** Single `invoices` table with `direction` column (`outbound` = billing clients, `inbound` = vendor bills). Vendors are org members with `role = 'vendor'` — same app, restricted sidebar/RLS. Stripe keys stored per-org in `organizations.settings` (encrypted). All new tables follow existing RLS pattern: org-scoped via `organization_users`.

**Tech Stack:** React 18, TypeScript, Supabase (Postgres + Auth + Edge Functions + Storage), Stripe JS, Tailwind CSS, Lucide icons

**Existing patterns to follow:**
- Tables: uuid PKs, `org_id` FK, `created_at` timestamptz, RLS enabled
- RLS: `org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())`
- Pages: `/src/pages/` with `useOrg()` context, `supabase` client from `@/lib/supabase`
- Sidebar: `NAV` array in `AppShell.tsx`, role-gated with `isOrgAdmin`/`isPlatformAdmin`

---

## Phase 1: Project & Timesheet Upgrades

### Task 1: Expand project statuses and add billing fields

**Objective:** Add billing_type, hourly rate, and fixed cost to projects; expand status beyond just "active"

**Files:**
- Create: `supabase/migrations/20260414200000_project_billing_and_statuses.sql`
- Modify: `src/pages/projects/ProjectForm.tsx` (add billing fields)
- Modify: `src/pages/projects/ProjectsList.tsx` (show status badges)
- Modify: `src/pages/projects/ProjectDetail.tsx` (show billing info)

**Migration SQL:**
```sql
-- Add billing fields to projects
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS project_cost decimal(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_rate decimal(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_hours decimal(15,2);

-- Note: status column already exists as text DEFAULT 'active'
-- Valid statuses: 'not_started', 'in_progress', 'on_hold', 'finished', 'cancelled'
-- Update any existing 'active' rows to 'in_progress'
UPDATE public.projects SET status = 'in_progress' WHERE status = 'active';

COMMENT ON COLUMN public.projects.billing_type IS 'fixed = fixed project cost, project_hours = project hourly rate, task_hours = per-task hourly rate';
```

**UI changes:**
- ProjectForm: Add billing_type select (Fixed Rate / Project Hours / Task Hours), conditional cost/rate fields
- ProjectsList: Color-coded status badges (gray=not_started, blue=in_progress, orange=on_hold, green=finished, slate=cancelled)
- ProjectDetail: Show billing summary section

---

### Task 2: Add hourly_rate to time_logs and start/stop timer

**Objective:** Capture hourly rate at time of logging; add timer start/stop capability

**Files:**
- Create: `supabase/migrations/20260414200100_timesheet_enhancements.sql`
- Modify: `src/pages/projects/TaskDetail.tsx` (add timer start/stop UI)
- Modify: `src/pages/Timesheets.tsx` (add standalone time entry form, show rates)

**Migration SQL:**
```sql
-- Add rate capture and timer fields to time_logs
ALTER TABLE public.time_logs
  ADD COLUMN IF NOT EXISTS hourly_rate decimal(15,2),
  ADD COLUMN IF NOT EXISTS timer_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS timer_stopped_at timestamptz,
  ADD COLUMN IF NOT EXISTS comment text;

-- Active timers view (for showing running timers in header/sidebar)
CREATE OR REPLACE VIEW public.active_timers AS
SELECT tl.id, tl.task_id, tl.project_id, tl.user_id, tl.timer_started_at,
       t.title as task_title, p.name as project_name
FROM public.time_logs tl
JOIN public.tasks t ON t.id = tl.task_id
JOIN public.projects p ON p.id = tl.project_id
WHERE tl.timer_started_at IS NOT NULL
  AND tl.timer_stopped_at IS NULL
  AND tl.hours = 0 AND tl.minutes = 0;
```

**UI changes:**
- TaskDetail: Play/Stop timer button that creates a time_log with `timer_started_at` set, then on stop calculates hours/minutes and sets `timer_stopped_at`
- Timesheets: Add "+ Log Time" button with form (select project → task → hours/minutes/date/description/rate)

---

### Task 3: Add vendor permissions for tasks and timesheets

**Objective:** Expand vendor role to include task and timesheet permissions

**Files:**
- Create: `supabase/migrations/20260414200200_vendor_permissions.sql`

**Migration SQL:**
```sql
-- Add task and timesheet permissions for vendor role
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('tasks.view'), ('tasks.update'),
  ('timesheets.view'), ('timesheets.create'),
  ('invoices.view'),
  ('invoices.pay')
) AS p(perm)
WHERE r.name = 'vendor'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Add invoice permissions for admin and account_manager
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('invoices.view'), ('invoices.create'), ('invoices.update'), ('invoices.delete'),
  ('invoices.send'), ('invoices.pay'),
  ('expenses.view'), ('expenses.create'), ('expenses.update'), ('expenses.delete')
) AS p(perm)
WHERE r.name IN ('admin', 'account_manager')
ON CONFLICT (role_id, permission) DO NOTHING;

-- Member: view invoices and expenses
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('invoices.view'), ('expenses.view')) AS p(perm)
WHERE r.name = 'member'
ON CONFLICT (role_id, permission) DO NOTHING;
```

---

## Phase 2: Invoicing & Payments

### Task 4: Create invoices and related tables

**Objective:** Core invoicing schema — invoices, line items, payment records

**Files:**
- Create: `supabase/migrations/20260414200300_invoices_schema.sql`

**Migration SQL:**
```sql
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
```

---

### Task 5: Invoices list page

**Objective:** Create the invoices list page with tabs for outbound (Invoices) and inbound (Bills)

**Files:**
- Create: `src/pages/invoices/InvoicesList.tsx`
- Modify: `src/components/AppShell.tsx` (add Invoices to NAV, add Bills for vendors)
- Modify: `src/components/AppShell.tsx` (add routes)

**Key behaviors:**
- Two tabs: "Invoices" (direction=outbound) and "Bills" (direction=inbound)
- Vendors only see the "Bills" tab (filtered to their vendor_user_id)
- Status filter pills: All, Draft, Sent, Unpaid, Partially Paid, Paid, Overdue, Cancelled
- Columns: Number, Client/Vendor, Project, Status, Amount, Due Date, Paid
- "+ New Invoice" / "+ New Bill" button (admin/account_manager only)
- Click row → InvoiceDetail

**Sidebar changes:**
- Add `{ to: '/invoices', label: 'Invoices', icon: FileText, testId: 'nav-invoices' }` to NAV array
- For vendors: filter NAV to show only Projects, Timesheets, Invoices (labeled "Bills")
- Add `isVendor` computed property to OrgContext: `currentMembership?.role_name === 'vendor'`
- Conditionally filter NAV: `const visibleNav = isVendor ? NAV.filter(n => ['Projects', 'Timesheets', 'Bills'].includes(n.label)) : NAV`

---

### Task 6: Invoice create/edit form

**Objective:** Full invoice form with line items editor

**Files:**
- Create: `src/pages/invoices/InvoiceForm.tsx`

**Key behaviors:**
- Select direction (outbound/inbound), company/contact, project
- Date fields: issue_date, due_date
- Line items: add/remove/reorder rows with description, qty, unit_price, tax_rate, subtotal
- "Import from Time Logs" button — opens modal showing unbilled time_logs for selected project, checkboxes to select, auto-generates line items grouped by task
- Discount section (percent or fixed)
- Adjustment field
- Auto-calculated subtotal, tax, discount, total
- Notes and terms text areas
- Save as Draft / Send buttons

---

### Task 7: Invoice detail page with payment recording

**Objective:** View invoice, record payments, generate PDF

**Files:**
- Create: `src/pages/invoices/InvoiceDetail.tsx`
- Create: `src/lib/invoicePdf.ts` (reuse html2canvas + jsPDF pattern from resumePdf.ts)

**Key behaviors:**
- Invoice header: number, status badge, dates, amounts
- Line items table (read-only)
- Payment history section with "+ Record Payment" form (amount, method, date, note)
- Status actions: Mark as Sent, Mark as Cancelled
- "Pay with Stripe" button (for inbound bills where Stripe is configured)
- PDF download button
- For vendors: read-only view of their bills with payment button

---

### Task 8: Stripe per-org configuration (Admin)

**Objective:** Admin UI to configure Stripe keys per org; Edge Function for checkout

**Files:**
- Modify: `src/pages/Admin.tsx` (add "Payments" section with Stripe key config)
- Create: `supabase/functions/create-stripe-checkout/index.ts`
- Create: `supabase/functions/stripe-webhook/index.ts`

**Admin UI:**
- "Payments" section in Admin with fields for Stripe Publishable Key and Secret Key
- Keys saved to `organizations.settings.stripe_publishable_key` and `organizations.settings.stripe_secret_key`
- Test connection button

**Edge Functions:**
- `create-stripe-checkout`: Creates Stripe Checkout session for an invoice. Reads Stripe keys from org settings. Returns session URL.
- `stripe-webhook`: Handles `checkout.session.completed` event. Records payment in `invoice_payments`, updates invoice status.

---

### Task 9: Bill from Time Logs workflow

**Objective:** One-click generation of invoice from unbilled project time

**Files:**
- Create: `src/pages/invoices/BillFromTimeLogs.tsx` (modal/page)
- Modify: `src/pages/projects/ProjectDetail.tsx` (add "Generate Invoice" button)

**Key behaviors:**
- Select project → shows all unbilled time_logs grouped by task
- Each row: task name, user, hours, rate, subtotal
- Checkbox to include/exclude entries
- "Create Invoice" button generates invoice with line items, each linking to the time_log IDs
- Time logs marked as billed via trigger
- Works for both directions: admin creates outbound invoice for client, or inbound bill for vendor

---

## Phase 3: Vendor Portal Experience

### Task 10: Vendor-scoped sidebar and navigation

**Objective:** Vendors see a restricted sidebar: Projects, Tasks, Timesheets, Bills

**Files:**
- Modify: `src/contexts/OrgContext.tsx` (add `isVendor` to context)
- Modify: `src/components/AppShell.tsx` (filter NAV based on role)

**Changes to OrgContext:**
```typescript
// Add to OrgState type
isVendor: boolean

// Add computation
const isVendor = currentMembership?.role_name === 'vendor'

// Add to value
isVendor,
```

**Changes to AppShell:**
```typescript
const VENDOR_NAV = [
  { to: '/projects', label: 'Projects', icon: FolderKanban, testId: 'nav-projects' },
  { to: '/timesheets', label: 'Timesheets', icon: Clock, testId: 'nav-timesheets' },
  { to: '/invoices', label: 'Bills', icon: FileText, testId: 'nav-bills' },
]

// In render:
const navItems = isVendor ? VENDOR_NAV : NAV
```

---

### Task 11: Vendor-scoped RLS policies

**Objective:** Vendors can only see projects they're members of, tasks assigned to them, their own time logs, and bills where they're the vendor_user_id

**Files:**
- Create: `supabase/migrations/20260414200400_vendor_rls.sql`

**Migration SQL:**
```sql
-- Vendor-specific invoice policy: vendors only see inbound invoices where they're the vendor
-- The existing org-level SELECT policy already covers this (vendors are org members)
-- But we add an additional constraint: vendors only see invoices where vendor_user_id = auth.uid()
-- or where direction = 'outbound' (they shouldn't see other vendors' bills)

-- Drop and recreate invoice SELECT policy to be role-aware
DROP POLICY IF EXISTS "invoices_select" ON public.invoices;

CREATE POLICY "invoices_select_admin" ON public.invoices FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM organization_users WHERE user_id = auth.uid())
    AND (
      -- Non-vendors see everything in their org
      EXISTS (
        SELECT 1 FROM organization_users ou
        JOIN roles r ON r.id = ou.role_id
        WHERE ou.user_id = auth.uid()
          AND ou.org_id = invoices.org_id
          AND r.name != 'vendor'
      )
      OR
      -- Vendors only see their own inbound bills
      (vendor_user_id = auth.uid() AND direction = 'inbound')
    )
  );

-- Vendors should only see projects they're members of (already enforced by project_members)
-- Vendors should only see tasks assigned to them
-- Existing task RLS is org-wide; add vendor restriction
-- NOTE: Current tasks RLS allows all org members to see all tasks
-- For vendors, we may want to restrict to assigned tasks only
-- This can be done at the UI level initially to avoid breaking existing policies
```

---

### Task 12: Expenses page

**Objective:** CRUD for expenses with billable flag and invoice linking

**Files:**
- Create: `src/pages/expenses/ExpensesList.tsx`
- Create: `src/pages/expenses/ExpenseForm.tsx`
- Modify: `src/components/AppShell.tsx` (add Expenses to NAV for non-vendors)

**Key behaviors:**
- List with filters: All, Billable, Billed, Non-billable
- Form: category, name, amount, date, project link, billable toggle, receipt upload, notes
- "Bill to Invoice" action — adds expense as line item to an existing or new invoice
- Categories: General, Travel, Software, Hardware, Subcontractor, Office, Other (stored as text, could be a lookup table later)

---

## Phase 4: Dashboard & Reports (Week 2)

### Task 13: Dashboard with KPIs

**Objective:** Replace welcome text with real metrics

**Files:**
- Modify: `src/pages/Dashboard.tsx`

**Widgets:**
- Total revenue (paid invoices this month/quarter/year)
- Outstanding invoices (unpaid + partially_paid amount_due sum)
- Hours logged (this week/month)
- Active projects count
- Recent activity feed (latest invoices, payments, time entries)
- For vendors: their total billed, total paid, hours this period

---

### Task 14: Reports page

**Objective:** Financial and timesheet reports

**Files:**
- Create: `src/pages/Reports.tsx`
- Modify: `src/components/AppShell.tsx` (add to NAV for admin/account_manager)

**Reports:**
- Revenue by month (bar chart)
- Revenue by project
- Timesheet summary by user/project/date range
- Outstanding invoices aging
- Expense summary by category
- Project profitability (revenue - expenses - time cost)

---

### Task 15: Recurring invoices

**Objective:** Auto-generate invoices on a schedule

**Files:**
- Create: `supabase/functions/process-recurring-invoices/index.ts`
- Modify: `src/pages/invoices/InvoiceForm.tsx` (add recurring toggle)

**Behaviors:**
- Toggle recurring on invoice form with interval selector
- Edge function runs on cron, finds invoices where `is_recurring = true` and `next_recurring_date <= today`
- Duplicates the invoice with new dates, resets status to draft or sent
- Updates `next_recurring_date`

---

## Route & Navigation Summary

### New routes to add in AppShell.tsx:
```
/invoices                    → InvoicesList
/invoices/new                → InvoiceForm
/invoices/:id                → InvoiceDetail
/invoices/:id/edit           → InvoiceForm
/expenses                    → ExpensesList
/expenses/new                → ExpenseForm
/expenses/:id/edit           → ExpenseForm
/reports                     → Reports
```

### Sidebar NAV (final):
**Admin/Member:**
Home, Inbox, Projects, Leads, Timesheets, Invoices, Expenses, Contacts

**Vendor:**
Projects, Timesheets, Bills (= Invoices filtered to inbound)

**Admin footer:**
Organizations, Admin (with new Payments section), Profile, Sign out

---

## Migration Order (recommended execution sequence)

1. Task 1 — Project billing fields + statuses (migration + UI)
2. Task 2 — Timesheet enhancements (migration + timer UI)
3. Task 3 — Vendor permissions (migration only)
4. Task 4 — Invoices schema (migration — all tables, triggers, functions)
5. Task 10 — Vendor sidebar + isVendor context (quick UI change)
6. Task 5 — Invoices list page
7. Task 6 — Invoice form with line items
8. Task 7 — Invoice detail + payment recording
9. Task 9 — Bill from Time Logs workflow
10. Task 8 — Stripe config + Edge Functions
11. Task 11 — Vendor RLS
12. Task 12 — Expenses
13. Task 13 — Dashboard
14. Task 14 — Reports
15. Task 15 — Recurring invoices
