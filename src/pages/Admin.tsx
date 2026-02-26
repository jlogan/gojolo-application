import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft,
  Building2,
  Mail,
  UserPlus,
  Users,
  Plug,
  Settings,
  LayoutDashboard,
} from 'lucide-react'

type Org = { id: string; name: string; slug: string }
type Role = { id: string; name: string }
type Invitation = {
  id: string
  org_id: string
  email: string
  role_id: string | null
  created_at: string
  used_at: string | null
  organizations: { name: string } | { name: string }[] | null
}

type AdminSection = 'overview' | 'organizations' | 'users' | 'invitations' | 'integrations' | 'settings'

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'workspace'
}

const SECTIONS: { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'organizations', label: 'Organizations', icon: Building2 },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'invitations', label: 'Invitations', icon: Mail },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'settings', label: 'Settings', icon: Settings },
]

export default function Admin() {
  const { isPlatformAdmin, currentOrg } = useOrg()
  const [section, setSection] = useState<AdminSection>('overview')
  const [orgs, setOrgs] = useState<Org[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)

  const [createName, setCreateName] = useState('')
  const [createSlug, setCreateSlug] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createMessage, setCreateMessage] = useState<string | null>(null)

  const [inviteOrgId, setInviteOrgId] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRoleId, setInviteRoleId] = useState('')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteMessage, setInviteMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!isPlatformAdmin) {
      setLoading(false)
      return
    }
    const load = async () => {
      const [orgsRes, rolesRes, invRes] = await Promise.all([
        supabase.from('organizations').select('id, name, slug').order('name'),
        supabase.from('roles').select('id, name').order('name'),
        supabase
          .from('org_invitations')
          .select('id, org_id, email, role_id, created_at, used_at, organizations(name)')
          .is('used_at', null)
          .order('created_at', { ascending: false }),
      ])
      setOrgs((orgsRes.data as Org[]) ?? [])
      setRoles((rolesRes.data as Role[]) ?? [])
      setInvitations((invRes.data as unknown as Invitation[]) ?? [])
      setLoading(false)
    }
    load()
  }, [isPlatformAdmin])

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createName.trim()) return
    setCreateLoading(true)
    setCreateMessage(null)
    const slug = createSlug.trim() || slugify(createName)
    const { data, error } = await supabase.rpc('create_organization', {
      org_name: createName.trim(),
      org_slug: slug,
    })
    if (error) {
      setCreateMessage(error.message)
    } else {
      setCreateMessage('Organization created.')
      setCreateName('')
      setCreateSlug('')
      setOrgs((prev) => [...prev, data as Org].sort((a, b) => a.name.localeCompare(b.name)))
    }
    setCreateLoading(false)
  }

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteOrgId || !inviteEmail.trim()) return
    setInviteLoading(true)
    setInviteMessage(null)
    const { error } = await supabase.rpc('invite_user_to_org', {
      p_org_id: inviteOrgId,
      p_email: inviteEmail.trim(),
      p_role_id: inviteRoleId || null,
    })
    if (error) {
      setInviteMessage(error.message)
    } else {
      setInviteMessage('Invitation sent. They’ll get access when they sign in with that email.')
      setInviteEmail('')
      const invRes = await supabase
        .from('org_invitations')
        .select('id, org_id, email, role_id, created_at, used_at, organizations(name)')
        .is('used_at', null)
        .order('created_at', { ascending: false })
      setInvitations((invRes.data as unknown as Invitation[]) ?? [])
    }
    setInviteLoading(false)
  }

  if (isPlatformAdmin === false) {
    return (
      <div className="p-4 md:p-6" data-testid="admin-forbidden">
        <p className="text-gray-400 mb-4">You don’t have access to admin.</p>
        <Link to="/" className="text-accent hover:underline text-sm font-medium">
          Back to app
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 text-gray-400 text-sm" data-testid="admin-loading">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0" data-testid="admin-page">
      {/* Back link - visible on mobile */}
      <div className="md:hidden p-4 border-b border-border shrink-0">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 font-medium"
          data-testid="admin-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
      </div>

      {/* Admin sidebar */}
      <aside className="w-full md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-border bg-surface-elevated">
        <div className="p-3">
          <h1 className="text-lg font-semibold text-white px-3 py-2">Admin</h1>
          <nav className="space-y-0.5" aria-label="Admin sections">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  section === id
                    ? 'bg-surface-muted text-white'
                    : 'text-gray-400 hover:bg-surface-muted hover:text-gray-200'
                }`}
                data-testid={`admin-nav-${id}`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="p-4 md:p-6 max-w-3xl">
          {section === 'overview' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Overview</h2>
              <p className="text-gray-400 text-sm mb-6">
                Manage organizations, users, invitations, and integrations from the sections in the sidebar.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-surface-elevated p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Organizations</p>
                  <p className="text-2xl font-semibold text-white">{orgs.length}</p>
                </div>
                <div className="rounded-lg border border-border bg-surface-elevated p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Pending invitations</p>
                  <p className="text-2xl font-semibold text-white">{invitations.length}</p>
                </div>
              </div>
              {currentOrg && (
                <p className="mt-4 text-sm text-gray-500">
                  Current workspace: <span className="text-gray-300">{currentOrg.name}</span>
                </p>
              )}
            </>
          )}

          {section === 'organizations' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Organizations</h2>
              <p className="text-gray-400 text-sm mb-6">
                Create workspaces and see all organizations. Only platform admins can create new ones.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated p-4 mb-6">
                <h3 className="text-sm font-medium text-white mb-3">Create organization</h3>
                <form onSubmit={handleCreateOrg} className="space-y-3">
                  <div>
                    <label htmlFor="admin-org-name" className="block text-xs font-medium text-gray-500 mb-1">
                      Name
                    </label>
                    <input
                      id="admin-org-name"
                      type="text"
                      value={createName}
                      onChange={(e) => {
                        setCreateName(e.target.value)
                        if (!createSlug) setCreateSlug(slugify(e.target.value))
                      }}
                      placeholder="Acme Inc"
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                      data-testid="admin-org-name"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-org-slug" className="block text-xs font-medium text-gray-500 mb-1">
                      Slug
                    </label>
                    <input
                      id="admin-org-slug"
                      type="text"
                      value={createSlug}
                      onChange={(e) => setCreateSlug(e.target.value)}
                      placeholder="acme-inc"
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                      data-testid="admin-org-slug"
                    />
                  </div>
                  {createMessage && (
                    <p className={`text-sm ${createMessage.includes('created') ? 'text-accent' : 'text-red-400'}`}>
                      {createMessage}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={createLoading || !createName.trim()}
                    className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                    data-testid="admin-org-submit"
                  >
                    {createLoading ? 'Creating…' : 'Create organization'}
                  </button>
                </form>
              </div>
              <div className="rounded-lg border border-border bg-surface-elevated">
                <h3 className="text-sm font-medium text-white px-4 py-3 border-b border-border">All organizations</h3>
                {orgs.length === 0 ? (
                  <p className="p-4 text-gray-400 text-sm">No organizations yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {orgs.map((org) => (
                      <li key={org.id} className="flex items-center gap-3 px-4 py-3">
                        <Building2 className="w-4 h-4 text-gray-500 shrink-0" />
                        <span className="text-gray-200 font-medium">{org.name}</span>
                        <span className="text-gray-500 text-xs">{org.slug}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {section === 'users' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Users</h2>
              <p className="text-gray-400 text-sm mb-6">
                Manage organization members and roles. Per-org user management will be available here.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated p-6 text-center">
                <Users className="w-10 h-10 text-gray-500 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">User management by organization is coming soon.</p>
              </div>
            </>
          )}

          {section === 'invitations' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Invitations</h2>
              <p className="text-gray-400 text-sm mb-6">
                Invite people by email. When they sign in (e.g. with Google using that email), they get access to the chosen workspace with the selected role.
              </p>
              <form onSubmit={handleInvite} className="rounded-lg border border-border bg-surface-elevated p-4 mb-6 space-y-3">
                <div>
                  <label htmlFor="admin-invite-org" className="block text-xs font-medium text-gray-500 mb-1">
                    Organization
                  </label>
                  <select
                    id="admin-invite-org"
                    value={inviteOrgId}
                    onChange={(e) => setInviteOrgId(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    data-testid="admin-invite-org"
                  >
                    <option value="">Select organization</option>
                    {orgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="admin-invite-email" className="block text-xs font-medium text-gray-500 mb-1">
                    Email
                  </label>
                  <input
                    id="admin-invite-email"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@example.com"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    data-testid="admin-invite-email"
                  />
                </div>
                <div>
                  <label htmlFor="admin-invite-role" className="block text-xs font-medium text-gray-500 mb-1">
                    Role
                  </label>
                  <select
                    id="admin-invite-role"
                    value={inviteRoleId}
                    onChange={(e) => setInviteRoleId(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    data-testid="admin-invite-role"
                  >
                    <option value="">Select role</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                {inviteMessage && (
                  <p className={`text-sm ${inviteMessage.includes('access') ? 'text-accent' : 'text-red-400'}`}>
                    {inviteMessage}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={inviteLoading || !inviteOrgId || !inviteEmail.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                  data-testid="admin-invite-submit"
                >
                  <UserPlus className="w-4 h-4" />
                  {inviteLoading ? 'Sending…' : 'Send invitation'}
                </button>
              </form>
              <div className="rounded-lg border border-border bg-surface-elevated">
                <h3 className="text-sm font-medium text-white px-4 py-3 border-b border-border">Pending invitations</h3>
                {invitations.length === 0 ? (
                  <p className="p-4 text-gray-400 text-sm">No pending invitations.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {invitations.map((inv) => (
                      <li key={inv.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                        <Mail className="w-4 h-4 text-gray-500 shrink-0" />
                        <span className="text-gray-200">{inv.email}</span>
                        <span className="text-gray-500">
                          → {Array.isArray(inv.organizations) ? inv.organizations[0]?.name : (inv.organizations as { name: string } | null)?.name ?? ''}
                        </span>
                        <span className="text-gray-500 text-xs">
                          {roles.find((r) => r.id === inv.role_id)?.name ?? '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {section === 'integrations' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Integrations</h2>
              <p className="text-gray-400 text-sm mb-6">
                Connect email (IMAP), SMS (Twilio), and other services. Configuration will be available here.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated p-6 text-center">
                <Plug className="w-10 h-10 text-gray-500 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Integrations (IMAP, Twilio, etc.) are coming soon.</p>
              </div>
            </>
          )}

          {section === 'settings' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Settings</h2>
              <p className="text-gray-400 text-sm mb-6">
                Platform-wide settings and preferences.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated p-6 text-center">
                <Settings className="w-10 h-10 text-gray-500 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Admin settings are coming soon.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
