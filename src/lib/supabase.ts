import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseMisconfigured = !url || !anonKey

export const supabase: SupabaseClient = supabaseMisconfigured
  ? (new Proxy({} as SupabaseClient, {
      get() {
        throw new Error(
          'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment variables before building.',
        )
      },
    }))
  : createClient(url!, anonKey!)
