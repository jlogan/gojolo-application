-- Vendor-scoped RLS for invoices
-- Replace the broad org-level SELECT policy with a role-aware one:
--   - Non-vendors (admin, member, account_manager) see all invoices in their org
--   - Vendors only see inbound invoices where vendor_user_id = auth.uid()

-- Drop the existing broad SELECT policy
DROP POLICY IF EXISTS "invoices_select" ON public.invoices;

-- Create role-aware SELECT policy
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT TO authenticated
  USING (
    org_id IN (
      SELECT ou.org_id
      FROM public.organization_users ou
      JOIN public.roles r ON r.id = ou.role_id
      WHERE ou.user_id = auth.uid()
        AND r.name != 'vendor'
    )
    OR
    (
      -- Vendors can only see inbound invoices assigned to them
      direction = 'inbound'
      AND vendor_user_id = auth.uid()
      AND org_id IN (
        SELECT ou.org_id
        FROM public.organization_users ou
        JOIN public.roles r ON r.id = ou.role_id
        WHERE ou.user_id = auth.uid()
          AND r.name = 'vendor'
      )
    )
  );

-- NOTE: Tasks RLS is currently org-wide (all org members see all tasks in their org).
-- Ideally vendors should only see tasks assigned to them or in projects they're members of.
-- For now, vendor task visibility is restricted at the UI level.
-- TODO: Add vendor-scoped RLS for tasks as a future improvement.
