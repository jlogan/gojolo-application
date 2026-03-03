-- Ensure inbox-attachments storage bucket exists (idempotent).
-- Run this if you see "Bucket not found" for inbox-attachments.
INSERT INTO storage.buckets (id, name, public)
VALUES ('inbox-attachments', 'inbox-attachments', false)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;

-- Ensure storage policies exist for inbox-attachments (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'inbox_att_storage_select'
  ) THEN
    CREATE POLICY "inbox_att_storage_select" ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'inbox-attachments');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'inbox_att_storage_insert'
  ) THEN
    CREATE POLICY "inbox_att_storage_insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'inbox-attachments');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'inbox_att_storage_delete'
  ) THEN
    CREATE POLICY "inbox_att_storage_delete" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'inbox-attachments');
  END IF;
END $$;
