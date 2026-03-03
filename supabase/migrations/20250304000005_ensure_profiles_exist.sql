-- Ensure every authenticated user can bootstrap and maintain their own profile row.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'profiles_insert_own'
  ) THEN
    CREATE POLICY "profiles_insert_own" ON public.profiles
      FOR INSERT TO authenticated
      WITH CHECK (id = auth.uid());
  END IF;
END $$;

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
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    u.email,
    COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email),
    COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
  INTO v_email, v_display_name, v_avatar
  FROM auth.users u
  WHERE u.id = v_uid;

  INSERT INTO public.profiles (id, display_name, email, avatar_url, updated_at)
  VALUES (v_uid, v_display_name, v_email, v_avatar, now())
  ON CONFLICT (id) DO UPDATE
  SET
    display_name = COALESCE(NULLIF(public.profiles.display_name, ''), EXCLUDED.display_name),
    email = COALESCE(public.profiles.email, EXCLUDED.email),
    avatar_url = COALESCE(NULLIF(public.profiles.avatar_url, ''), EXCLUDED.avatar_url),
    updated_at = now();

  RETURN v_uid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_my_profile() TO authenticated;

-- Backfill any missing profiles from existing auth.users.
INSERT INTO public.profiles (id, display_name, email, avatar_url)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email),
  u.email,
  COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- Fill empty display name/avatar/email for existing profiles.
UPDATE public.profiles p
SET
  display_name = COALESCE(NULLIF(p.display_name, ''), COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email)),
  email = COALESCE(p.email, u.email),
  avatar_url = COALESCE(NULLIF(p.avatar_url, ''), COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')),
  updated_at = now()
FROM auth.users u
WHERE p.id = u.id
  AND (
    p.display_name IS NULL OR p.display_name = ''
    OR p.email IS NULL
    OR p.avatar_url IS NULL OR p.avatar_url = ''
  );
