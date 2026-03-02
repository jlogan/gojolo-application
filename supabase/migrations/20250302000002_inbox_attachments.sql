-- Inbox message attachments (stored in Supabase Storage)
CREATE TABLE IF NOT EXISTS public.inbox_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES public.inbox_messages(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_path text NOT NULL,
  file_size bigint,
  content_type text,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_inbox_attachments_message ON public.inbox_attachments(message_id);
CREATE INDEX idx_inbox_attachments_thread ON public.inbox_attachments(thread_id);

ALTER TABLE public.inbox_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ia_select" ON public.inbox_attachments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_attachments.thread_id
  ));
CREATE POLICY "ia_insert" ON public.inbox_attachments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.inbox_threads t
    JOIN public.organization_users ou ON ou.org_id = t.org_id AND ou.user_id = auth.uid()
    WHERE t.id = inbox_attachments.thread_id
  ));
CREATE POLICY "ia_delete" ON public.inbox_attachments FOR DELETE TO authenticated
  USING (uploaded_by = auth.uid());

-- Storage bucket for inbox attachments
INSERT INTO storage.buckets (id, name, public) VALUES ('inbox-attachments', 'inbox-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "inbox_att_storage_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'inbox-attachments');
CREATE POLICY "inbox_att_storage_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'inbox-attachments');
CREATE POLICY "inbox_att_storage_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'inbox-attachments');
