-- Storage bucket for resume template candidate photos
INSERT INTO storage.buckets (id, name, public)
VALUES ('resume-template-assets', 'resume-template-assets', true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'resume_template_assets_select'
  ) THEN
    CREATE POLICY "resume_template_assets_select" ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'resume-template-assets');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'resume_template_assets_insert'
  ) THEN
    CREATE POLICY "resume_template_assets_insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'resume-template-assets');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'resume_template_assets_update'
  ) THEN
    CREATE POLICY "resume_template_assets_update" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'resume-template-assets')
      WITH CHECK (bucket_id = 'resume-template-assets');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'resume_template_assets_delete'
  ) THEN
    CREATE POLICY "resume_template_assets_delete" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'resume-template-assets');
  END IF;
END $$;
