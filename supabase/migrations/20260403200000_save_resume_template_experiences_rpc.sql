-- Atomically replace featured job rows for a resume template (single transaction, avoids multi-request races).
CREATE OR REPLACE FUNCTION public.save_resume_template_experiences(
  p_template_id uuid,
  p_items jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.resume_templates rt
    WHERE rt.id = p_template_id
      AND rt.org_id IN (
        SELECT ou.org_id
        FROM public.organization_users ou
        WHERE ou.user_id = auth.uid()
      )
  ) THEN
    RAISE EXCEPTION 'access denied or template not found';
  END IF;

  DELETE FROM public.resume_template_experiences rte
  WHERE rte.template_id = p_template_id;

  FOR rec IN
    SELECT
      NULLIF(TRIM(elem->>'company_name'), '') AS company_name,
      NULLIF(TRIM(elem->>'job_location'), '') AS job_location,
      (NULLIF(TRIM(elem->>'start_year'), ''))::integer AS start_year,
      CASE
        WHEN elem->>'end_year' IS NOT NULL AND TRIM(elem->>'end_year') <> ''
          THEN (TRIM(elem->>'end_year'))::integer
        ELSE NULL
      END AS end_year,
      (ord - 1)::integer AS sort_order
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p_items) = 'array' THEN p_items
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS t(elem, ord)
  LOOP
    IF rec.company_name IS NULL OR rec.company_name = '' THEN
      RAISE EXCEPTION 'company_name required for each job';
    END IF;
    IF rec.start_year IS NULL THEN
      RAISE EXCEPTION 'start_year required for each job';
    END IF;

    INSERT INTO public.resume_template_experiences (
      template_id,
      sort_order,
      company_name,
      role_title,
      start_year,
      end_year,
      job_location,
      is_current,
      description,
      bullets
    ) VALUES (
      p_template_id,
      rec.sort_order,
      rec.company_name,
      NULL,
      rec.start_year,
      rec.end_year,
      rec.job_location,
      false,
      NULL,
      '[]'::jsonb
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.save_resume_template_experiences(uuid, jsonb) IS
  'Replaces resume_template_experiences for a template in one transaction; caller must belong to template org.';

REVOKE ALL ON FUNCTION public.save_resume_template_experiences(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_resume_template_experiences(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_resume_template_experiences(uuid, jsonb) TO service_role;
