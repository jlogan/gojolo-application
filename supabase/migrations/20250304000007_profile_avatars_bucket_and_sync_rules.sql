-- Store profile photos locally in Supabase Storage.
INSERT INTO storage.buckets (id, name, public)
VALUES ('profile-avatars', 'profile-avatars', true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;

-- Keep ensure_my_profile from overwriting locally synced avatar URLs.
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
    email = COALESCE(EXCLUDED.email, public.profiles.email),
    display_name = CASE
      WHEN v_provider = 'google' THEN COALESCE(EXCLUDED.display_name, public.profiles.display_name)
      ELSE COALESCE(public.profiles.display_name, EXCLUDED.display_name)
    END,
    avatar_url = CASE
      WHEN v_provider = 'google' THEN COALESCE(
        CASE WHEN public.profiles.avatar_url LIKE '%/storage/v1/object/public/profile-avatars/%' THEN public.profiles.avatar_url END,
        EXCLUDED.avatar_url,
        public.profiles.avatar_url
      )
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
