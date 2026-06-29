-- Track invoice emails sent through the Inbox compose flow.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_sent_thread_id uuid REFERENCES public.inbox_threads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_email_sent_at ON public.invoices(email_sent_at);
CREATE INDEX IF NOT EXISTS idx_invoices_email_sent_thread ON public.invoices(email_sent_thread_id);
