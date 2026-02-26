-- Fix: allow authenticated users to create organizations (fixes "new row violates row-level security" on workspace creation).
-- Drop and recreate so the policy is correct regardless of prior migration state.

DROP POLICY IF EXISTS "orgs_insert_authenticated" ON public.organizations;

CREATE POLICY "orgs_insert_authenticated"
  ON public.organizations
  FOR INSERT
  TO authenticated
  WITH CHECK (true);
