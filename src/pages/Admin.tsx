import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft,
  Mail,
  UserPlus,
  Users,
  Settings,
  Phone,
  Inbox,
  ChevronDown,
} from 'lucide-react'

type Role = { id: string; name: string }
type Invitation = {
  id: string
  org_id: string
  email: string
  role_id: string | null
  created_at: string
}

type OrgMember = {
  user_id: string
  role_id: string
  profiles: { display_name: string | null; email: string | null } | { display_name: string | null; email: string | null }[] | null
  roles: { name: string } | { name: string }[] | null
}

type PhoneNumber = {
  id: string
  org_id: string | null
  phone_number: string
  friendly_name: string | null
  is_active: boolean
}

type ImapAccount = {
  id: string
  org_id: string
  label: string | null
  email: string
  is_active: boolean
}

type AdminSection = 'users' | 'imap' | 'phone_numbers' | 'settings'

const SECTIONS: { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'imap', label: 'IMAP accounts', icon: Inbox },
  { id: 'phone_numbers', label: 'Phone numbers', icon: Phone },
  { id: 'settings', label: 'Settings', icon: Settings },
]

export default function Admin() {
  const { isPlatformAdmin, currentOrg, isOrgAdmin } = useOrg()
  const [section, setSection] = useState<AdminSection>('users')
  const [roles, setRoles] = useState<Role[]>([])
  const [members, setMembers] = useState<OrgMember[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([])
  const [imapAccounts, setImapAccounts] = useState<ImapAccount[]>([])
  const [loading, setLoading] = useState(true)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRoleId, setInviteRoleId] = useState('')
  const [inviteSendMagicLink, setInviteSendMagicLink] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteMessage, setInviteMessage] = useState<string | null>(null)

  const [imapEmail, setImapEmail] = useState('')
  const [imapLabel, setImapLabel] = useState('')
  const [imapHost, setImapHost] = useState('imap.gmail.com')
  const [imapPort, setImapPort] = useState(993)
  const [imapEncryption, setImapEncryption] = useState<'none' | 'tls' | 'ssl'>('ssl')
  const [imapUsername, setImapUsername] = useState('')
  const [imapPassword, setImapPassword] = useState('')
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com')
  const [smtpPort, setSmtpPort] = useState(587)
  const [smtpEncryption, setSmtpEncryption] = useState<'none' | 'tls' | 'ssl'>('tls')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [imapLoading, setImapLoading] = useState(false)
  const [imapTestLoading, setImapTestLoading] = useState(false)
  const [smtpTestLoading, setSmtpTestLoading] = useState(false)
  const [imapMessage, setImapMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!currentOrg?.id || (!isOrgAdmin && !isPlatformAdmin)) {
      setLoading(false)
      return
    }
    const load = async () => {
      const [rolesRes, membersRes, invRes, phoneRes, imapRes] = await Promise.all([
        supabase.from('roles').select('id, name').order('name'),
        supabase
          .from('organization_users')
          .select('user_id, role_id, profiles(display_name, email), roles(name)')
          .eq('org_id', currentOrg.id),
        supabase
          .from('org_invitations')
          .select('id, org_id, email, role_id, created_at')
          .eq('org_id', currentOrg.id)
          .is('used_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('phone_numbers').select('id, org_id, phone_number, friendly_name, is_active').eq('org_id', currentOrg.id).order('phone_number'),
        supabase.from('imap_accounts').select('id, org_id, label, email, is_active').eq('org_id', currentOrg.id),
      ])
      setRoles((rolesRes.data as Role[]) ?? [])
      setMembers((membersRes.data as unknown as OrgMember[]) ?? [])
      setInvitations((invRes.data as Invitation[]) ?? [])
      setPhoneNumbers((phoneRes.data as PhoneNumber[]) ?? [])
      setImapAccounts((imapRes.data as ImapAccount[]) ?? [])
      setLoading(false)
    }
    load()
  }, [currentOrg?.id, isOrgAdmin, isPlatformAdmin])

  const refetchUsers = async () => {
    if (!currentOrg?.id) return
    const [membersRes, invRes] = await Promise.all([
      supabase.from('organization_users').select('user_id, role_id, profiles(display_name, email), roles(name)').eq('org_id', currentOrg.id),
      supabase.from('org_invitations').select('id, org_id, email, role_id, created_at').eq('org_id', currentOrg.id).is('used_at', null).order('created_at', { ascending: false }),
    ])
      setMembers((membersRes.data as unknown as OrgMember[]) ?? [])
    setInvitations((invRes.data as Invitation[]) ?? [])
  }

  const refetchPhones = async () => {
    if (!currentOrg?.id) return
    const { data } = await supabase.from('phone_numbers').select('id, org_id, phone_number, friendly_name, is_active').eq('org_id', currentOrg.id).order('phone_number')
    setPhoneNumbers((data as PhoneNumber[]) ?? [])
  }

  const refetchImap = async () => {
    if (!currentOrg?.id) return
    const { data } = await supabase.from('imap_accounts').select('id, org_id, label, email, is_active').eq('org_id', currentOrg.id)
    setImapAccounts((data as ImapAccount[]) ?? [])
  }

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !inviteEmail.trim()) return
    setInviteLoading(true)
    setInviteMessage(null)
    const { error } = await supabase.rpc('invite_user_to_org', {
      p_org_id: currentOrg.id,
      p_email: inviteEmail.trim(),
      p_role_id: inviteRoleId || null,
    })
    if (error) {
      setInviteMessage(error.message)
      setInviteLoading(false)
      return
    }
    if (inviteSendMagicLink) {
      await supabase.auth.signInWithOtp({
        email: inviteEmail.trim(),
        options: { emailRedirectTo: `${window.location.origin}/` },
      })
    }
    setInviteMessage(inviteSendMagicLink
      ? 'Invitation sent and magic link emailed. They can set a password or sign in with Google.'
      : 'Invitation sent. They’ll get access when they sign in with that email (e.g. Google).')
    setInviteEmail('')
    setInviteSendMagicLink(false)
    refetchUsers()
    setInviteLoading(false)
  }

  const callImapEdge = async (save: boolean, testSmtpOnly?: boolean) => {
    if (!currentOrg?.id) return { error: { message: 'No workspace selected.' } }
    if (!testSmtpOnly && (!imapEmail.trim() || !imapHost.trim() || !imapUsername.trim() || !imapPassword)) {
      return { error: { message: 'Fill in email, host, username, and password.' } }
    }
    if (testSmtpOnly && (!smtpHost.trim() || !smtpUsername.trim() || !smtpPassword)) {
      return { error: { message: 'Fill in SMTP host, username, and password.' } }
    }
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-test-and-save`
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      return { error: { message: 'Please sign in again.' } }
    }
    await supabase.auth.refreshSession()
    const { data: { session: freshSession } } = await supabase.auth.getSession()
    const token = freshSession?.access_token ?? session.access_token
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        orgId: currentOrg.id,
        email: imapEmail.trim(),
        host: imapHost.trim(),
        port: imapPort || (imapEncryption === 'ssl' ? 993 : 143),
        imapEncryption,
        username: imapUsername.trim(),
        password: imapPassword,
        label: imapLabel.trim() || null,
        save,
        testSmtpOnly: testSmtpOnly || false,
        smtpHost: smtpHost.trim() || null,
        smtpPort: smtpPort || 587,
        smtpEncryption,
        smtpUsername: smtpUsername.trim() || null,
        smtpPassword: smtpPassword || null,
      }),
    })
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; message?: string }
    const errMsg = data?.error ?? (!res.ok ? (data?.message || res.statusText || `Request failed (${res.status})`) : null)
    if (errMsg) return { error: { message: errMsg } }
    return { data }
  }

  const handleTestImap = async () => {
    setImapTestLoading(true)
    setImapMessage(null)
    const { error } = await callImapEdge(false)
    if (error) {
      setImapMessage(error.message)
    } else {
      setImapMessage('IMAP connection successful.')
    }
    setImapTestLoading(false)
  }

  const handleTestSmtp = async () => {
    setSmtpTestLoading(true)
    setImapMessage(null)
    const { error } = await callImapEdge(false, true)
    if (error) {
      setImapMessage(error.message)
    } else {
      setImapMessage('SMTP connection successful.')
    }
    setSmtpTestLoading(false)
  }

  const handleAddImap = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !imapEmail.trim() || !imapHost.trim() || !imapUsername.trim() || !imapPassword) {
      setImapMessage('Fill in email, host, username, and password.')
      return
    }
    setImapLoading(true)
    setImapMessage(null)
    const { error } = await callImapEdge(true)
    if (error) {
      setImapMessage(error.message)
    } else {
      setImapMessage('IMAP account added. You can turn sync on from the Inbox once it’s set up.')
      setImapEmail('')
      setImapLabel('')
      setImapHost('imap.gmail.com')
      setImapPort(993)
      setImapEncryption('ssl')
      setImapUsername('')
      setImapPassword('')
      setSmtpHost('smtp.gmail.com')
      setSmtpPort(587)
      setSmtpEncryption('tls')
      setSmtpUsername('')
      setSmtpPassword('')
      refetchImap()
    }
    setImapLoading(false)
  }

  const handleTogglePhone = async (id: string, is_active: boolean) => {
    await supabase.from('phone_numbers').update({ is_active }).eq('id', id).eq('org_id', currentOrg!.id)
    refetchPhones()
  }

  if (!isOrgAdmin && !isPlatformAdmin) {
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
          {currentOrg && (
            <p className="text-sm text-gray-500 mb-4">
              Managing: <span className="text-gray-300 font-medium">{currentOrg.name}</span>
            </p>
          )}

          {section === 'users' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Users</h2>
              <p className="text-gray-400 text-sm mb-6">
                Members and pending invitations for this workspace. Add users by email; they can sign in with Google or set a password via magic link.
              </p>
              <form onSubmit={handleInvite} className="rounded-lg border border-border bg-surface-elevated p-4 mb-6 space-y-3">
                <h3 className="text-sm font-medium text-white">Add user</h3>
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
                  <div className="relative">
                    <select
                      id="admin-invite-role"
                      value={inviteRoleId}
                      onChange={(e) => setInviteRoleId(e.target.value)}
                      className="w-full rounded-lg border border-border bg-surface-muted pl-3 pr-9 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent appearance-none cursor-pointer"
                      data-testid="admin-invite-role"
                    >
                      <option value="">Select role</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" aria-hidden />
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={inviteSendMagicLink}
                    onChange={(e) => setInviteSendMagicLink(e.target.checked)}
                    className="rounded border-border bg-surface-muted text-accent focus:ring-accent"
                  />
                  <span className="text-sm text-gray-400">Send magic link so they can set a password (or they can sign in with Google only)</span>
                </label>
                {inviteMessage && (
                  <p className={`text-sm ${inviteMessage.includes('Invitation') ? 'text-accent' : 'text-red-400'}`}>
                    {inviteMessage}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={inviteLoading || !inviteEmail.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                  data-testid="admin-invite-submit"
                >
                  <UserPlus className="w-4 h-4" />
                  {inviteLoading ? 'Sending…' : 'Add user'}
                </button>
              </form>
              <div className="rounded-lg border border-border bg-surface-elevated mb-4">
                <h3 className="text-sm font-medium text-white px-4 py-3 border-b border-border">Members</h3>
                {members.length === 0 ? (
                  <p className="p-4 text-gray-400 text-sm">No members yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {members.map((m) => (
                      <li key={m.user_id} className="flex items-center justify-between px-4 py-3 text-sm">
                        <div>
                          <p className="text-gray-200 font-medium">{(Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ?? '—'}</p>
                          <p className="text-gray-500 text-xs">{(Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.email ?? '—'}</p>
                        </div>
                        <span className="text-gray-500 text-xs">{(Array.isArray(m.roles) ? m.roles[0] : m.roles)?.name ?? '—'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
                        <span className="text-gray-500 text-xs">{roles.find((r) => r.id === inv.role_id)?.name ?? '—'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {section === 'imap' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">IMAP accounts</h2>
              <p className="text-gray-400 text-sm mb-6">
                Email accounts to monitor in the Inbox. For Gmail use an App Password (Account → Security → 2-Step Verification → App passwords).
              </p>
              <form onSubmit={handleAddImap} className="rounded-lg border border-border bg-surface-elevated p-4 mb-4 space-y-3">
                <div>
                  <label htmlFor="admin-imap-email" className="block text-xs font-medium text-gray-500 mb-1">Email</label>
                  <input
                    id="admin-imap-email"
                    type="email"
                    value={imapEmail}
                    onChange={(e) => setImapEmail(e.target.value)}
                    placeholder="inbox@example.com"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  />
                </div>
                <div>
                  <label htmlFor="admin-imap-label" className="block text-xs font-medium text-gray-500 mb-1">Label (optional)</label>
                  <input
                    id="admin-imap-label"
                    type="text"
                    value={imapLabel}
                    onChange={(e) => setImapLabel(e.target.value)}
                    placeholder="Support inbox"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="admin-imap-host" className="block text-xs font-medium text-gray-500 mb-1">IMAP host</label>
                    <input
                      id="admin-imap-host"
                      type="text"
                      value={imapHost}
                      onChange={(e) => setImapHost(e.target.value)}
                      placeholder="imap.gmail.com"
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-imap-port" className="block text-xs font-medium text-gray-500 mb-1">Port</label>
                    <input
                      id="admin-imap-port"
                      type="number"
                      value={imapPort}
                      onChange={(e) => setImapPort(parseInt(e.target.value, 10) || 993)}
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="admin-imap-encryption" className="block text-xs font-medium text-gray-500 mb-1">IMAP encryption</label>
                  <div className="relative">
                    <select
                      id="admin-imap-encryption"
                      value={imapEncryption}
                      onChange={(e) => setImapEncryption(e.target.value as 'none' | 'tls' | 'ssl')}
                      className="w-full rounded-lg border border-border bg-surface-muted pl-3 pr-9 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent appearance-none cursor-pointer"
                    >
                      <option value="none">None</option>
                      <option value="tls">TLS (STARTTLS)</option>
                      <option value="ssl">SSL</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" aria-hidden />
                  </div>
                </div>
                <div>
                  <label htmlFor="admin-imap-username" className="block text-xs font-medium text-gray-500 mb-1">IMAP username</label>
                  <input
                    id="admin-imap-username"
                    type="text"
                    value={imapUsername}
                    onChange={(e) => setImapUsername(e.target.value)}
                    placeholder="your@email.com or Gmail address"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    autoComplete="username"
                  />
                </div>
                <div>
                  <label htmlFor="admin-imap-password" className="block text-xs font-medium text-gray-500 mb-1">IMAP password</label>
                  <input
                    id="admin-imap-password"
                    type="password"
                    value={imapPassword}
                    onChange={(e) => setImapPassword(e.target.value)}
                    placeholder="App password for Gmail"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    autoComplete="current-password"
                  />
                </div>

                <h3 className="text-sm font-medium text-white pt-2 border-t border-border mt-4">SMTP settings</h3>
                <p className="text-gray-500 text-xs">For sending replies from this account. Optional.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="admin-smtp-host" className="block text-xs font-medium text-gray-500 mb-1">SMTP host</label>
                    <input
                      id="admin-smtp-host"
                      type="text"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.gmail.com"
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-smtp-port" className="block text-xs font-medium text-gray-500 mb-1">SMTP port</label>
                    <input
                      id="admin-smtp-port"
                      type="number"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(parseInt(e.target.value, 10) || 587)}
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="admin-smtp-encryption" className="block text-xs font-medium text-gray-500 mb-1">SMTP encryption</label>
                  <div className="relative">
                    <select
                      id="admin-smtp-encryption"
                      value={smtpEncryption}
                      onChange={(e) => setSmtpEncryption(e.target.value as 'none' | 'tls' | 'ssl')}
                      className="w-full rounded-lg border border-border bg-surface-muted pl-3 pr-9 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent appearance-none cursor-pointer"
                    >
                      <option value="none">None</option>
                      <option value="tls">TLS</option>
                      <option value="ssl">SSL</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" aria-hidden />
                  </div>
                </div>
                <div>
                  <label htmlFor="admin-smtp-username" className="block text-xs font-medium text-gray-500 mb-1">SMTP username</label>
                  <input
                    id="admin-smtp-username"
                    type="text"
                    value={smtpUsername}
                    onChange={(e) => setSmtpUsername(e.target.value)}
                    placeholder="Same as IMAP or leave blank"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    autoComplete="username"
                  />
                </div>
                <div>
                  <label htmlFor="admin-smtp-password" className="block text-xs font-medium text-gray-500 mb-1">SMTP password</label>
                  <input
                    id="admin-smtp-password"
                    type="password"
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                    placeholder="Leave blank to use IMAP password"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    autoComplete="current-password"
                  />
                </div>
                <div className="flex flex-wrap gap-2 pb-2">
                  <button
                    type="button"
                    onClick={handleTestSmtp}
                    disabled={smtpTestLoading || !smtpHost.trim() || !smtpUsername.trim() || !smtpPassword}
                    className="px-4 py-2 rounded-lg border border-border bg-surface-muted text-gray-200 text-sm font-medium hover:bg-surface-muted/80 disabled:opacity-50"
                  >
                    {smtpTestLoading ? 'Testing…' : 'Test SMTP connection'}
                  </button>
                </div>

                {imapMessage && <p className={`text-sm ${imapMessage.includes('added') || imapMessage.includes('successful') ? 'text-accent' : 'text-red-400'}`}>{imapMessage}</p>}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleTestImap}
                    disabled={imapTestLoading || !imapEmail.trim() || !imapHost.trim() || !imapUsername.trim() || !imapPassword}
                    className="px-4 py-2 rounded-lg border border-border bg-surface-muted text-gray-200 text-sm font-medium hover:bg-surface-muted/80 disabled:opacity-50"
                  >
                    {imapTestLoading ? 'Testing…' : 'Test connection'}
                  </button>
                  <button type="submit" disabled={imapLoading || !imapEmail.trim() || !imapHost.trim() || !imapUsername.trim() || !imapPassword} className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
                    {imapLoading ? 'Adding…' : 'Add IMAP account'}
                  </button>
                </div>
              </form>
              <div className="rounded-lg border border-border bg-surface-elevated">
                {imapAccounts.length === 0 ? (
                  <p className="p-4 text-gray-400 text-sm">No IMAP accounts yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {imapAccounts.map((acc) => (
                      <li key={acc.id} className="flex items-center justify-between px-4 py-3 text-sm">
                        <div>
                          <p className="text-gray-200 font-medium">{acc.label || acc.email}</p>
                          <p className="text-gray-500 text-xs">{acc.email}</p>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded ${acc.is_active ? 'bg-accent/20 text-accent' : 'text-gray-500'}`}>{acc.is_active ? 'On' : 'Off'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {section === 'phone_numbers' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Phone numbers</h2>
              <p className="text-gray-400 text-sm mb-6">
                SMS numbers assigned to this workspace. Turn on or off for the Inbox.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated">
                {phoneNumbers.length === 0 ? (
                  <p className="p-4 text-gray-400 text-sm">No phone numbers assigned to this workspace. Contact your platform admin to add and assign numbers.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {phoneNumbers.map((pn) => (
                      <li key={pn.id} className="flex items-center justify-between px-4 py-3 text-sm">
                        <div>
                          <p className="text-gray-200 font-medium">{pn.friendly_name || pn.phone_number}</p>
                          <p className="text-gray-500 text-xs">{pn.phone_number}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleTogglePhone(pn.id, !pn.is_active)}
                          className={`text-xs px-3 py-1.5 rounded font-medium ${pn.is_active ? 'bg-accent/20 text-accent hover:bg-accent/30' : 'bg-surface-muted text-gray-400 hover:bg-surface-muted/80'}`}
                        >
                          {pn.is_active ? 'On' : 'Off'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {section === 'settings' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Organization settings</h2>
              <p className="text-gray-400 text-sm mb-6">
                Workspace name and preferences. More options coming soon.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated p-6 text-center">
                <Settings className="w-10 h-10 text-gray-500 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Organization settings (name, slug, etc.) are coming soon.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
