-- Allow authors to update and delete their own task comments
CREATE POLICY "tc_update" ON public.task_comments FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "tc_delete" ON public.task_comments FOR DELETE TO authenticated
  USING (user_id = auth.uid());
