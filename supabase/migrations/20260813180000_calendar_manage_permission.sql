-- calendar.manage: refresh/sync team calendars without owning the OAuth connection

INSERT INTO public.role_permissions (role_id, permission)
SELECT r.id, 'calendar.manage'
FROM public.roles r
WHERE r.name IN ('admin', 'account_manager')
ON CONFLICT (role_id, permission) DO NOTHING;
