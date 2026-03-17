-- When a contact is linked to a company, auto-link that contact to all projects
-- that are already linked to that company.
CREATE OR REPLACE FUNCTION public.autolink_contact_to_company_projects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.company_id = OLD.company_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.project_contacts (project_id, contact_id)
  SELECT pc.project_id, NEW.id
  FROM public.project_companies pc
  WHERE pc.company_id = NEW.company_id
  ON CONFLICT (project_id, contact_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_autolink_projects ON public.contacts;
CREATE TRIGGER contacts_autolink_projects
  AFTER INSERT OR UPDATE OF company_id ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.autolink_contact_to_company_projects();

-- Backfill existing contacts that already have a company link.
INSERT INTO public.project_contacts (project_id, contact_id)
SELECT pc.project_id, c.id
FROM public.contacts c
JOIN public.project_companies pc ON pc.company_id = c.company_id
WHERE c.company_id IS NOT NULL
ON CONFLICT (project_id, contact_id) DO NOTHING;
