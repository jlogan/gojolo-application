-- Resume template experiences should only require company + employment dates.
-- Role title and responsibilities are generated dynamically from job description.

ALTER TABLE public.resume_template_experiences
  ALTER COLUMN role_title DROP NOT NULL;

-- Ensure bullets remains optional payload
ALTER TABLE public.resume_template_experiences
  ALTER COLUMN bullets SET DEFAULT '[]'::jsonb;
