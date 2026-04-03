-- Job location per template experience (featured job history)
ALTER TABLE public.resume_template_experiences
  ADD COLUMN IF NOT EXISTS job_location text;

COMMENT ON COLUMN public.resume_template_experiences.job_location IS 'City/region for this employment row; shown on generated resumes.';

-- Denormalized final HTML snapshot for interviews / audit (also stored inside content_json.document_html)
ALTER TABLE public.resume_documents
  ADD COLUMN IF NOT EXISTS document_html text;

COMMENT ON COLUMN public.resume_documents.document_html IS 'Final TipTap HTML snapshot at save time; mirrors content_json.document_html for easy querying.';
