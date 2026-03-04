-- Timesheets module permissions: view and billable status (role-gated)
-- timesheets.view: access Timesheets page / see org time entries
-- timesheets.billable_status: can set or change Billable/Non billable on time logs

INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('timesheets.view'), ('timesheets.billable_status')) AS p(perm)
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Member: view only (cannot edit billable status)
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, 'timesheets.view'
FROM public.roles r
WHERE r.name = 'member'
ON CONFLICT (role_id, permission) DO NOTHING;
