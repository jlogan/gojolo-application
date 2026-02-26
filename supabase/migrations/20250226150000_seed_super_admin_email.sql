-- Designated super admin: this email is always added as platform admin on signup or when present.
-- Ensures nagolpj@gmail.com has platform admin wherever this app is installed.

-- 1) Ensure existing user with this email is already a platform admin (for current installs).
INSERT INTO public.platform_admins (user_id)
SELECT id FROM auth.users WHERE lower(email) = 'nagolpj@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- 2) Bootstrap trigger: add this email as platform admin on first signup, or first user if no one else.
CREATE OR REPLACE FUNCTION public.bootstrap_platform_admin()
RETURNS trigger AS $$
BEGIN
  IF lower(NEW.email) = 'nagolpj@gmail.com' THEN
    INSERT INTO public.platform_admins (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  ELSIF (SELECT count(*) FROM public.platform_admins) = 0 THEN
    INSERT INTO public.platform_admins (user_id) VALUES (NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
