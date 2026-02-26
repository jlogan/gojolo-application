import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from './AuthContext'

export type Organization = {
  id: string
  name: string
  slug: string
  settings: Record<string, unknown> | null
  created_at: string
}

export type OrgMembership = {
  org: Organization
  role_id: string
}

type OrgState = {
  memberships: OrgMembership[]
  currentOrg: Organization | null
  loading: boolean
  isPlatformAdmin: boolean | null
  setCurrentOrg: (org: Organization | null) => void
  refetch: () => Promise<void>
}

const OrgContext = createContext<OrgState | null>(null)

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [memberships, setMemberships] = useState<OrgMembership[]>([])
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPlatformAdmin, setIsPlatformAdmin] = useState<boolean | null>(null)

  const fetchOrgs = useCallback(async () => {
    if (!user) {
      setMemberships([])
      setCurrentOrgState(null)
      setLoading(false)
      return
    }
    const { data: orgUsers, error } = await supabase
      .from('organization_users')
      .select(`
        role_id,
        organizations (
          id,
          name,
          slug,
          settings,
          created_at
        )
      `)
      .eq('user_id', user.id)

    if (error) {
      console.error('Failed to fetch orgs', error)
      setMemberships([])
      setLoading(false)
      return
    }

    type Row = { role_id: string; organizations: Organization | Organization[] | null }
    const list: OrgMembership[] = (orgUsers ?? [])
      .filter((ou: Row) => ou.organizations)
      .map((ou: Row) => ({
        org: Array.isArray(ou.organizations) ? ou.organizations[0] : (ou.organizations as Organization),
        role_id: ou.role_id,
      }))

    setMemberships(list)

    const storedId = localStorage.getItem('jolo_current_org_id')
    const next = storedId
      ? list.find((m) => m.org.id === storedId)?.org ?? list[0]?.org ?? null
      : list[0]?.org ?? null
    setCurrentOrgState(next)
    if (next) localStorage.setItem('jolo_current_org_id', next.id)
    setLoading(false)
  }, [user?.id])

  useEffect(() => {
    fetchOrgs()
  }, [fetchOrgs])

  useEffect(() => {
    if (!user) {
      setIsPlatformAdmin(null)
      return
    }
    supabase.rpc('is_platform_admin').then(({ data }) => setIsPlatformAdmin(!!data))
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    const run = async () => {
      const { data: profile } = await supabase.from('profiles').select('email').eq('id', user.id).single()
      if (user.email && profile && (profile as { email: string | null }).email !== user.email) {
        await supabase.from('profiles').update({ email: user.email }).eq('id', user.id)
      }
      const { data: consumed } = await supabase.rpc('consume_my_invitations')
      if (consumed && Number(consumed) > 0) fetchOrgs()
    }
    run()
  }, [user?.id, user?.email, fetchOrgs])

  const setCurrentOrg = useCallback((org: Organization | null) => {
    setCurrentOrgState(org)
    if (org) localStorage.setItem('jolo_current_org_id', org.id)
    else localStorage.removeItem('jolo_current_org_id')
  }, [])

  const value: OrgState = {
    memberships,
    currentOrg,
    loading,
    isPlatformAdmin,
    setCurrentOrg,
    refetch: fetchOrgs,
  }

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg() {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg must be used within OrgProvider')
  return ctx
}
