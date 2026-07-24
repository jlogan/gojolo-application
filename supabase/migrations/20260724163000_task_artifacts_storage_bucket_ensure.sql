-- Ensure task-artifacts storage bucket and policies exist (idempotent).
-- Run via: supabase db push

INSERT INTO storage.buckets (id, name, public)
VALUES ('task-artifacts', 'task-artifacts', false)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;

-- Repair tasks whose org_id drifted from their parent project (upload paths use task.org_id).
UPDATE public.tasks t
SET org_id = p.org_id
FROM public.projects p
WHERE t.project_id = p.id
  AND t.org_id IS DISTINCT FROM p.org_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'ta_art_select'
  ) THEN
    CREATE POLICY "ta_art_select" ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'task-artifacts');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'ta_art_insert'
  ) THEN
    CREATE POLICY "ta_art_insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'task-artifacts');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'ta_art_delete'
  ) THEN
    CREATE POLICY "ta_art_delete" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'task-artifacts');
  END IF;
END $$;
