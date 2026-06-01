-- Leads module permissions: view, create, update, delete (role-gated)
-- leads.view:   access Leads page / see org leads
-- leads.create:  create new leads
-- leads.update:  edit existing leads (status, details, activity)
-- leads.delete:  delete leads

-- Admin: full CRUD
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('leads.view'), ('leads.create'), ('leads.update'), ('leads.delete')) AS p(perm)
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Account Manager: full CRUD
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('leads.view'), ('leads.create'), ('leads.update'), ('leads.delete')) AS p(perm)
WHERE r.name = 'account_manager'
ON CONFLICT (role_id, permission) DO NOTHING;

-- Member: view + create + update (no delete)
INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM public.roles r
CROSS JOIN (VALUES ('leads.view'), ('leads.create'), ('leads.update')) AS p(perm)
WHERE r.name = 'member'
ON CONFLICT (role_id, permission) DO NOTHING;
