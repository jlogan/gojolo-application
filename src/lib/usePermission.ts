import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export function usePermission(orgId: string | undefined, permission: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    if (!orgId) {
      setAllowed(null)
      return
    }
    let cancelled = false
    setAllowed(null)
    supabase
      .rpc('user_has_permission', { p_org_id: orgId, p_permission: permission })
      .then(
        ({ data }) => {
          if (!cancelled) setAllowed(!!data)
        },
        () => {
          if (!cancelled) setAllowed(false)
        },
      )
    return () => {
      cancelled = true
    }
  }, [orgId, permission])

  return allowed
}
