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
  role_name: string | null
}

type OrgState = {
  memberships: OrgMembership[]
  currentOrg: Organization | null
  loading: boolean
  isPlatformAdmin: boolean | null
  isOrgAdmin: boolean
  setCurrentOrg: (org: Organization | null) => void
  refetch: () => Promise<void>
  allOrganizations: Organization[]
  refetchAllOrgs: () => Promise<void>
}

const OrgContext = createContext<OrgState | null>(null)

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [memberships, setMemberships] = useState<OrgMembership[]>([])
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPlatformAdmin, setIsPlatformAdmin] = useState<boolean | null>(null)
  const [allOrganizations, setAllOrganizations] = useState<Organization[]>([])

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
        ),
        roles (name)
      `)
      .eq('user_id', user.id)

    if (error) {
      console.error('Failed to fetch orgs', error)
      setMemberships([])
      setLoading(false)
      return
    }

    type Row = {
      role_id: string
      organizations: Organization | Organization[] | null
      roles: { name: string } | { name: string }[] | null
    }
    const list: OrgMembership[] = (orgUsers ?? [])
      .filter((ou: Row) => ou.organizations)
      .map((ou: Row) => {
        const org = Array.isArray(ou.organizations) ? ou.organizations[0] : (ou.organizations as Organization)
        const role = ou.roles ? (Array.isArray(ou.roles) ? ou.roles[0] : ou.roles) : null
        return {
          org,
          role_id: ou.role_id,
          role_name: role?.name ?? null,
        }
      })

    setMemberships(list)

    const storedId = localStorage.getItem('jolo_current_org_id')
    const next = storedId
      ? list.find((m) => m.org.id === storedId)?.org ?? list[0]?.org ?? null
      : list[0]?.org ?? null
    setCurrentOrgState(next)
    if (next) localStorage.setItem('jolo_current_org_id', next.id)
    setLoading(false)
  }, [user?.id])

  const refetchAllOrgs = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.from('organizations').select('id, name, slug, settings, created_at').order('name')
    setAllOrganizations((data as Organization[]) ?? [])
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
    if (!isPlatformAdmin || !user) return
    refetchAllOrgs()
  }, [isPlatformAdmin, user?.id, refetchAllOrgs])

  useEffect(() => {
    const storedId = localStorage.getItem('jolo_current_org_id')
    if (!storedId || !isPlatformAdmin || memberships.some((m) => m.org.id === storedId)) return
    supabase
      .from('organizations')
      .select('id, name, slug, settings, created_at')
      .eq('id', storedId)
      .single()
      .then(({ data }) => {
        if (data) setCurrentOrgState(data as Organization)
      })
  }, [isPlatformAdmin, memberships])

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

  const currentMembership = currentOrg ? memberships.find((m) => m.org.id === currentOrg.id) : null
  const isOrgAdmin = currentMembership?.role_name === 'admin' || isPlatformAdmin === true

  const value: OrgState = {
    memberships,
    currentOrg,
    loading,
    isPlatformAdmin,
    isOrgAdmin,
    setCurrentOrg,
    refetch: fetchOrgs,
    allOrganizations,
    refetchAllOrgs,
  }

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg() {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg must be used within OrgProvider')
  return ctx
}
