-- Fix time_logs UPDATE policy to allow org members to update any log in their org's projects
-- Previously only allowed users to update their own logs (user_id = auth.uid())

DROP POLICY IF EXISTS tl_update ON time_logs;

CREATE POLICY tl_update ON time_logs
  FOR UPDATE
  USING (
    project_id IN (
      SELECT projects.id
      FROM projects
      WHERE projects.org_id IN (
        SELECT organization_users.org_id
        FROM organization_users
        WHERE organization_users.user_id = auth.uid()
      )
    )
  );
