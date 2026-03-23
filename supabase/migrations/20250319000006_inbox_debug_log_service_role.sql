-- Allow service_role to read all inbox_debug_log (for Studio SQL editor / API with service key)
CREATE POLICY "inbox_debug_log_select_service" ON public.inbox_debug_log
  FOR SELECT TO service_role USING (true);
