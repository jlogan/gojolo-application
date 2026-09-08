import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export type AppProfile = {
  id: string
  display_name: string | null
  email: string | null
  avatar_url: string | null
}

type AuthState = {
  session: Session | null
  user: User | null
  profile: AppProfile | null
  loading: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  refetchProfile: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<AppProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const loadProfile = useCallback(async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null)
      return
    }
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, email, avatar_url')
      .eq('id', userId)
      .maybeSingle()
    setProfile((data as AppProfile | null) ?? null)
  }, [])

  const ensureProfile = useCallback(async (authUser: User | null) => {
    if (!authUser) return
    const { error } = await supabase.rpc('ensure_my_profile')
    if (!error) return
    // Fallback for environments that have not applied the RPC migration yet.
    const userMeta = (authUser.user_metadata ?? {}) as { full_name?: string; name?: string; avatar_url?: string; picture?: string }
    await supabase.from('profiles').upsert({
      id: authUser.id,
      display_name: userMeta.full_name ?? userMeta.name ?? authUser.email ?? null,
      email: authUser.email ?? null,
      avatar_url: userMeta.avatar_url ?? userMeta.picture ?? null,
    }, { onConflict: 'id', ignoreDuplicates: true })
  }, [])

  const syncProfileAvatarToStorage = useCallback(async (sessionToSync: Session | null) => {
    const provider = (sessionToSync?.user?.app_metadata?.provider as string | undefined) ?? ''
    if (provider !== 'google') return
    const token = sessionToSync?.access_token
    if (!token) return
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-profile-avatar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({}),
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session)
      const nextUser = session?.user ?? null
      setUser(nextUser)
      await ensureProfile(nextUser)
      await loadProfile(nextUser?.id)
      void syncProfileAvatarToStorage(session)
      setLoading(false)
    }).catch(() => {
      setSession(null)
      setUser(null)
      setProfile(null)
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const nextUser = session?.user ?? null
      setSession(session)
      setUser(nextUser)
      void ensureProfile(nextUser).then(() => loadProfile(nextUser?.id))
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        void syncProfileAvatarToStorage(session)
      }
    })

    return () => subscription.unsubscribe()
  }, [ensureProfile, loadProfile, syncProfileAvatarToStorage])

  useEffect(() => {
    if (!user?.id) {
      setProfile(null)
      return
    }
    const channel = supabase
      .channel(`profile-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
        () => { void loadProfile(user.id) },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user?.id, loadProfile])

  const signInWithGoogle = useCallback(async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    })
  }, [])

  const signOut = useCallback(async () => {
    const uid = session?.user?.id
    if (uid) localStorage.removeItem(`jolo_current_org_id_${uid}`)
    localStorage.removeItem('jolo_current_org_id')
    localStorage.removeItem('jolo_app_mode')
    await supabase.auth.signOut()
    window.location.href = '/login'
  }, [session?.user?.id])

  const value: AuthState = {
    session,
    user,
    profile,
    loading,
    signInWithGoogle,
    signOut,
    refetchProfile: () => loadProfile(user?.id),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
