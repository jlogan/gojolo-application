-- Add task and timesheet permissions for vendor role
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('tasks.view'), ('tasks.update'),
  ('timesheets.view'), ('timesheets.create'),
  ('invoices.view'),
  ('invoices.pay')
) AS p(perm)
WHERE r.name = 'vendor'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Add invoice permissions for admin and account_manager
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES
  ('invoices.view'), ('invoices.create'), ('invoices.update'), ('invoices.delete'),
  ('invoices.send'), ('invoices.pay'),
  ('expenses.view'), ('expenses.create'), ('expenses.update'), ('expenses.delete')
) AS p(perm)
WHERE r.name IN ('admin', 'account_manager')
ON CONFLICT (role_id, permission) DO NOTHING;

-- Member: view invoices and expenses
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('invoices.view'), ('expenses.view')) AS p(perm)
WHERE r.name = 'member'
ON CONFLICT (role_id, permission) DO NOTHING;
