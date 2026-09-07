-- Allow workspace admins to edit the display name/email shown for workspace members.
-- This updates public.profiles only; it does not change the user's Supabase Auth login email.
CREATE OR REPLACE FUNCTION public.update_org_member_profile(
  p_org_id uuid,
  p_user_id uuid,
  p_display_name text,
  p_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_display_name text := nullif(trim(coalesce(p_display_name, '')), '');
  v_email text := lower(nullif(trim(coalesce(p_email, '')), ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_platform_admin() AND NOT public.is_org_admin(p_org_id) THEN
    RAISE EXCEPTION 'Only workspace admins can update member profiles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_users ou
    WHERE ou.org_id = p_org_id
      AND ou.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'User is not a member of this workspace';
  END IF;

  IF v_email IS NULL OR v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' THEN
    RAISE EXCEPTION 'Enter a valid email address';
  END IF;

  INSERT INTO public.profiles (id, display_name, email, updated_at)
  VALUES (p_user_id, v_display_name, v_email, now())
  ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_org_member_profile(uuid, uuid, text, text) TO authenticated;

-- Preserve admin-edited profile names/emails on login while still filling missing profile data.
CREATE OR REPLACE FUNCTION public.ensure_my_profile()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_display_name text;
  v_avatar text;
  v_provider text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    u.email,
    COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email),
    COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture'),
    COALESCE(u.raw_app_meta_data->>'provider', '')
  INTO v_email, v_display_name, v_avatar, v_provider
  FROM auth.users u
  WHERE u.id = v_uid;

  INSERT INTO public.profiles (id, display_name, email, avatar_url, google_avatar_url, updated_at)
  VALUES (v_uid, v_display_name, v_email, v_avatar, v_avatar, now())
  ON CONFLICT (id) DO UPDATE
  SET
    email = COALESCE(public.profiles.email, EXCLUDED.email),
    display_name = COALESCE(NULLIF(public.profiles.display_name, ''), EXCLUDED.display_name),
    avatar_url = CASE
      WHEN v_provider = 'google' THEN COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url)
      ELSE COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url)
    END,
    google_avatar_url = CASE
      WHEN v_provider = 'google' THEN COALESCE(EXCLUDED.google_avatar_url, public.profiles.google_avatar_url)
      ELSE public.profiles.google_avatar_url
    END,
    updated_at = now();

  RETURN v_uid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_my_profile() TO authenticated;
