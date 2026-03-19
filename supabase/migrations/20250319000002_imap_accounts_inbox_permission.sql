-- Allow users with inbox.view permission to SELECT imap_accounts (same as admin).
-- Fixes: account_manager couldn't see From dropdown or proper Reply All recipients
-- because imap_accounts RLS only allowed is_org_admin (role name 'admin').
CREATE POLICY "imap_select_inbox_permission"
  ON public.imap_accounts FOR SELECT TO authenticated
  USING (public.user_has_permission(org_id, 'inbox.view'));
