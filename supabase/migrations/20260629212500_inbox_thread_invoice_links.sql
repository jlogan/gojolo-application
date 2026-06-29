-- Link inbox/email threads to invoices for cross-module visibility.
CREATE TABLE IF NOT EXISTS public.inbox_thread_invoices (
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (thread_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_thread_invoices_invoice ON public.inbox_thread_invoices(invoice_id);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_invoices_thread ON public.inbox_thread_invoices(thread_id);

ALTER TABLE public.inbox_thread_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "iti_select" ON public.inbox_thread_invoices FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id
      WHERE t.id = inbox_thread_invoices.thread_id
        AND ou.user_id = auth.uid()
    )
  );

CREATE POLICY "iti_insert" ON public.inbox_thread_invoices FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.inbox_threads t
      JOIN public.invoices i ON i.id = inbox_thread_invoices.invoice_id AND i.org_id = t.org_id
      JOIN public.organization_users ou ON ou.org_id = t.org_id
      WHERE t.id = inbox_thread_invoices.thread_id
        AND ou.user_id = auth.uid()
    )
  );

CREATE POLICY "iti_delete" ON public.inbox_thread_invoices FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id
      WHERE t.id = inbox_thread_invoices.thread_id
        AND ou.user_id = auth.uid()
    )
  );

CREATE POLICY "iti_update" ON public.inbox_thread_invoices FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.inbox_threads t
      JOIN public.organization_users ou ON ou.org_id = t.org_id
      WHERE t.id = inbox_thread_invoices.thread_id
        AND ou.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.inbox_threads t
      JOIN public.invoices i ON i.id = inbox_thread_invoices.invoice_id AND i.org_id = t.org_id
      JOIN public.organization_users ou ON ou.org_id = t.org_id
      WHERE t.id = inbox_thread_invoices.thread_id
        AND ou.user_id = auth.uid()
    )
  );

-- Preserve existing one-off invoice-send audit link in the generalized link table.
INSERT INTO public.inbox_thread_invoices (thread_id, invoice_id)
SELECT email_sent_thread_id, id
FROM public.invoices
WHERE email_sent_thread_id IS NOT NULL
ON CONFLICT DO NOTHING;
