-- Storage bucket for generated lead resume PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('lead-resumes', 'lead-resumes', false)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_resumes_storage_select'
  ) THEN
    CREATE POLICY "lead_resumes_storage_select" ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'lead-resumes');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_resumes_storage_insert'
  ) THEN
    CREATE POLICY "lead_resumes_storage_insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'lead-resumes');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_resumes_storage_update'
  ) THEN
    CREATE POLICY "lead_resumes_storage_update" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'lead-resumes')
      WITH CHECK (bucket_id = 'lead-resumes');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'lead_resumes_storage_delete'
  ) THEN
    CREATE POLICY "lead_resumes_storage_delete" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'lead-resumes');
  END IF;
END $$;
