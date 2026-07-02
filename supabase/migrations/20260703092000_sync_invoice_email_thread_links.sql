-- Keep invoice email-sent thread links synchronized with the generalized
-- inbox_thread_invoices junction table so the link appears on both the invoice
-- detail page and the inbox thread detail page.

CREATE OR REPLACE FUNCTION public.sync_invoice_email_thread_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.email_sent_thread_id IS NOT NULL THEN
    INSERT INTO public.inbox_thread_invoices (thread_id, invoice_id)
    VALUES (NEW.email_sent_thread_id, NEW.id)
    ON CONFLICT (thread_id, invoice_id) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.email_sent_thread_id IS NOT NULL
    AND OLD.email_sent_thread_id IS DISTINCT FROM NEW.email_sent_thread_id THEN
    DELETE FROM public.inbox_thread_invoices
    WHERE thread_id = OLD.email_sent_thread_id
      AND invoice_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_invoice_email_thread_link ON public.invoices;
CREATE TRIGGER trg_sync_invoice_email_thread_link
AFTER INSERT OR UPDATE OF email_sent_thread_id ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.sync_invoice_email_thread_link();

INSERT INTO public.inbox_thread_invoices (thread_id, invoice_id)
SELECT email_sent_thread_id, id
FROM public.invoices
WHERE email_sent_thread_id IS NOT NULL
ON CONFLICT (thread_id, invoice_id) DO NOTHING;
