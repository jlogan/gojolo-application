-- Cover letter documents table + storage bucket for generated cover letter PDFs.
-- Mirrors resume_documents pattern: one row per generated cover letter, linked to a lead.

-- 1) Table
CREATE TABLE IF NOT EXISTS public.cover_letter_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  template_id uuid REFERENCES public.resume_templates(id) ON DELETE SET NULL,
  candidate_name text NOT NULL,
  company_name text,
  role_title text,
  job_description text,
  prompt text,
  content_text text,
  content_html text,
  render_format text NOT NULL DEFAULT 'pdf',
  file_path text,
  file_url text,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cover_letter_documents_render_format_check CHECK (render_format IN ('pdf', 'json', 'html'))
);

CREATE INDEX IF NOT EXISTS idx_cover_letter_documents_org ON public.cover_letter_documents(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cover_letter_documents_lead ON public.cover_letter_documents(lead_id, created_at DESC);

-- 2) RLS
ALTER TABLE public.cover_letter_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cover_letter_documents_select_org" ON public.cover_letter_documents FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "cover_letter_documents_insert_org" ON public.cover_letter_documents FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "cover_letter_documents_update_org" ON public.cover_letter_documents FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));
CREATE POLICY "cover_letter_documents_delete_org" ON public.cover_letter_documents FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.organization_users WHERE user_id = auth.uid()));

-- 3) Storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('lead-cover-letters', 'lead-cover-letters', false)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_cover_letters_storage_select'
  ) THEN
    CREATE POLICY "lead_cover_letters_storage_select" ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'lead-cover-letters');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_cover_letters_storage_insert'
  ) THEN
    CREATE POLICY "lead_cover_letters_storage_insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'lead-cover-letters');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_cover_letters_storage_update'
  ) THEN
    CREATE POLICY "lead_cover_letters_storage_update" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'lead-cover-letters')
      WITH CHECK (bucket_id = 'lead-cover-letters');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_cover_letters_storage_delete'
  ) THEN
    CREATE POLICY "lead_cover_letters_storage_delete" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'lead-cover-letters');
  END IF;
END $$;
