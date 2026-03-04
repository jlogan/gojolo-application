import { useCallback, useEffect, useState } from 'react'
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
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Check,
  Hash,
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
  host: string | null
  port: number | null
  imap_encryption: string | null
  imap_username: string | null
  addresses: string[] | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_use_tls: boolean | null
  smtp_username: string | null
  is_active: boolean
}

type RolePermission = { id: string; role_id: string; permission: string }
type SlackConfig = {
  id: string; webhook_url: string | null; bot_token: string | null; default_channel: string | null; is_active: boolean
  app_id: string | null; client_id: string | null; client_secret: string | null; signing_secret: string | null
  bot_user_id: string | null; team_id: string | null; team_name: string | null; scopes: string | null
  inbox_channel: string | null; notify_on_new_email: boolean; notify_on_assignment: boolean
  notify_on_mention: boolean; notify_on_thread_close: boolean
  notify_on_task_created?: boolean; notify_on_task_status_change?: boolean; notify_on_task_comment?: boolean
}
type AdminSection = 'users' | 'imap' | 'phone_numbers' | 'slack' | 'settings'

const SECTIONS: { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'users', label: 'Users & Roles', icon: Users },
  { id: 'imap', label: 'Email accounts', icon: Inbox },
  { id: 'slack', label: 'Slack', icon: Hash },
  { id: 'phone_numbers', label: 'Phone numbers', icon: Phone },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const ALL_PERMISSIONS = [
  { module: 'Projects', perms: ['projects.view', 'projects.create', 'projects.update', 'projects.delete'] },
  { module: 'Contacts', perms: ['contacts.view', 'contacts.create', 'contacts.update', 'contacts.delete'] },
  { module: 'Companies', perms: ['companies.view', 'companies.create', 'companies.update', 'companies.delete'] },
  { module: 'Inbox', perms: ['inbox.view', 'inbox.message', 'inbox.delete'] },
  { module: 'Timesheets', perms: ['timesheets.view', 'timesheets.billable_status'] },
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

  const [usersTab, setUsersTab] = useState<'members' | 'roles' | 'invitations'>('members')
  const [rolePermissions, setRolePermissions] = useState<RolePermission[]>([])
  const [newRoleName, setNewRoleName] = useState('')
  const [roleMessage, setRoleMessage] = useState<string | null>(null)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRoleId, setInviteRoleId] = useState('')
  const [inviteSendMagicLink, setInviteSendMagicLink] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteMessage, setInviteMessage] = useState<string | null>(null)

  const [imapLabel, setImapLabel] = useState('')
  const [imapAliases, setImapAliases] = useState('')
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
  const [imapTestMessage, setImapTestMessage] = useState<string | null>(null)
  const [smtpTestMessage, setSmtpTestMessage] = useState<string | null>(null)
  const [editingImapId, setEditingImapId] = useState<string | null>(null)
  const [imapView, setImapView] = useState<'list' | 'form'>('list')
  const [imapSyncAccountId, setImapSyncAccountId] = useState<string | null>(null)

  // Slack
  const [slackConfig, setSlackConfig] = useState<SlackConfig | null>(null)
  const [slackForm, setSlackForm] = useState({
    bot_token: '', default_channel: '', inbox_channel: '',
    app_id: '', client_id: '', client_secret: '', signing_secret: '',
    bot_user_id: '',
    is_active: false, notify_on_new_email: true, notify_on_assignment: true,
    notify_on_mention: true, notify_on_thread_close: false,
    notify_on_task_created: true, notify_on_task_status_change: true, notify_on_task_comment: true,
  })
  const [slackSaving, setSlackSaving] = useState(false)
  const [slackMessage, setSlackMessage] = useState<string | null>(null)
  const [slackTestLoading, setSlackTestLoading] = useState(false)
  const [slackTestMessage, setSlackTestMessage] = useState<string | null>(null)
  const [slackTestChannels, setSlackTestChannels] = useState<{ id: string; name: string; is_private: boolean; is_member: boolean }[]>([])
  const [slackTab, setSlackTab] = useState<'connection' | 'notifications' | 'test' | 'mapping'>('connection')
  const [slackUsers, setSlackUsers] = useState<{ id: string; label: string; name: string; email: string | null }[]>([])
  const [userSlackMappings, setUserSlackMappings] = useState<{ user_id: string; slack_user_id: string }[]>([])
  const [slackMappingLoading, setSlackMappingLoading] = useState(false)
  const [slackMappingError, setSlackMappingError] = useState<string | null>(null)
  const [orgTimezone, setOrgTimezone] = useState<string>('America/New_York')
  const [orgTimezoneSaving, setOrgTimezoneSaving] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [imapSyncMessage, setImapSyncMessage] = useState<string | null>(null)

  useEffect(() => {
    if (section === 'imap') setImapView('list')
  }, [section])

  const loadSlackUsersAndMappings = useCallback(async () => {
    if (!currentOrg?.id) return
    setSlackMappingLoading(true)
    setSlackMappingError(null)
    try {
      const [usersRes, mapRes] = await Promise.all([
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/slack-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
          body: JSON.stringify({ orgId: currentOrg.id }),
        }),
        supabase.from('user_slack_mappings').select('user_id, slack_user_id').eq('org_id', currentOrg.id),
      ])
      const usersData = await usersRes.json().catch(() => ({})) as { users?: { id: string; label: string; name: string; email: string | null }[]; error?: string }
      const maps = (mapRes.data ?? []) as { user_id: string; slack_user_id: string }[]
      setUserSlackMappings(maps)
      if (!usersRes.ok || usersData.error) {
        setSlackUsers([])
        setSlackMappingError(usersData.error ?? `Request failed (${usersRes.status}). Deploy the slack-users Edge Function and ensure Bot Configuration is saved.`)
      } else {
        const list = usersData.users ?? []
        setSlackUsers(list)
        setSlackMappingError(list.length === 0 ? 'Slack returned no users. Add the users:read scope to your Slack app at api.slack.com.' : null)
      }
    } catch (e) {
      setSlackUsers([])
      setSlackMappingError((e as Error).message || 'Failed to load Slack users.')
    } finally {
      setSlackMappingLoading(false)
    }
  }, [currentOrg?.id])

  useEffect(() => {
    if (slackTab !== 'mapping' || !currentOrg?.id) return
    loadSlackUsersAndMappings()
  }, [slackTab, currentOrg?.id, loadSlackUsersAndMappings])

  useEffect(() => {
    if (!currentOrg?.id || (!isOrgAdmin && !isPlatformAdmin)) {
      setLoading(false)
      return
    }
    const load = async () => {
      const [rolesRes, ouRes, invRes, phoneRes, imapRes] = await Promise.all([
        supabase.from('roles').select('id, name').order('name'),
        supabase
          .from('organization_users')
          .select('user_id, role_id, roles(name)')
          .eq('org_id', currentOrg.id),
        supabase
          .from('org_invitations')
          .select('id, org_id, email, role_id, created_at')
          .eq('org_id', currentOrg.id)
          .is('used_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('phone_numbers').select('id, org_id, phone_number, friendly_name, is_active').eq('org_id', currentOrg.id).order('phone_number'),
        supabase.from('imap_accounts').select('id, org_id, label, email, host, port, imap_encryption, imap_username, addresses, smtp_host, smtp_port, smtp_use_tls, smtp_username, is_active').eq('org_id', currentOrg.id),
      ])
      setRoles((rolesRes.data as Role[]) ?? [])
      const ouRows = (ouRes.data ?? []) as { user_id: string; role_id: string; roles: { name: string } | { name: string }[] | null }[]
      if (ouRows.length > 0) {
        const uids = ouRows.map(r => r.user_id)
        const { data: profiles } = await supabase.from('profiles').select('id, display_name, email').in('id', uids)
        const profMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; email: string | null }) => [p.id, p]))
        setMembers(ouRows.map(r => ({
          user_id: r.user_id, role_id: r.role_id,
          profiles: profMap.get(r.user_id) ?? null,
          roles: r.roles,
        })))
      } else { setMembers([]) }
      setInvitations((invRes.data as Invitation[]) ?? [])
      setPhoneNumbers((phoneRes.data as PhoneNumber[]) ?? [])
      setImapAccounts((imapRes.data as ImapAccount[]) ?? [])
      // Load Slack config
      const { data: slackData } = await supabase.from('slack_configs').select('*').eq('org_id', currentOrg.id).limit(1)
      if (slackData?.length) {
        const sc = slackData[0] as SlackConfig
        setSlackConfig(sc)
        setSlackForm({
          bot_token: sc.bot_token ?? '',
          default_channel: sc.default_channel ?? '', inbox_channel: sc.inbox_channel ?? '',
          app_id: sc.app_id ?? '', client_id: sc.client_id ?? '',
          client_secret: sc.client_secret ?? '', signing_secret: sc.signing_secret ?? '',
          bot_user_id: sc.bot_user_id ?? '',
          is_active: sc.is_active, notify_on_new_email: sc.notify_on_new_email,
          notify_on_assignment: sc.notify_on_assignment, notify_on_mention: sc.notify_on_mention,
          notify_on_thread_close: sc.notify_on_thread_close,
          notify_on_task_created: sc.notify_on_task_created !== false,
          notify_on_task_status_change: sc.notify_on_task_status_change !== false,
          notify_on_task_comment: sc.notify_on_task_comment !== false,
        })
      }
      const { data: rpData } = await supabase.from('role_permissions').select('id, role_id, permission').order('permission')
      setRolePermissions((rpData as RolePermission[]) ?? [])
      const { data: orgRow } = await supabase.from('organizations').select('timezone').eq('id', currentOrg.id).single()
      setOrgTimezone(orgRow?.timezone && typeof orgRow.timezone === 'string' ? orgRow.timezone : 'America/New_York')
      setLoading(false)
    }
    load()
  }, [currentOrg?.id, isOrgAdmin, isPlatformAdmin])

  const refetchUsers = async () => {
    if (!currentOrg?.id) return
    const [ouRes, invRes] = await Promise.all([
      supabase.from('organization_users').select('user_id, role_id, roles(name)').eq('org_id', currentOrg.id),
      supabase.from('org_invitations').select('id, org_id, email, role_id, created_at').eq('org_id', currentOrg.id).is('used_at', null).order('created_at', { ascending: false }),
    ])
    const ouRows = (ouRes.data ?? []) as { user_id: string; role_id: string; roles: { name: string } | { name: string }[] | null }[]
    if (ouRows.length > 0) {
      const uids = ouRows.map(r => r.user_id)
      const { data: profiles } = await supabase.from('profiles').select('id, display_name, email').in('id', uids)
      const profMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; email: string | null }) => [p.id, p]))
      const membersData: OrgMember[] = ouRows.map(r => ({
        user_id: r.user_id, role_id: r.role_id,
        profiles: profMap.get(r.user_id) ?? null,
        roles: r.roles,
      }))
      setMembers(membersData)
    } else {
      setMembers([])
    }
    setInvitations((invRes.data as Invitation[]) ?? [])
  }

  const refetchRoles = async () => {
    const { data: rolesData } = await supabase.from('roles').select('id, name').order('name')
    setRoles((rolesData as Role[]) ?? [])
    const { data: rpData } = await supabase.from('role_permissions').select('id, role_id, permission').order('permission')
    setRolePermissions((rpData as RolePermission[]) ?? [])
  }

  const handleChangeUserRole = async (userId: string, newRoleId: string) => {
    if (!currentOrg?.id) return
    await supabase.from('organization_users').update({ role_id: newRoleId }).eq('org_id', currentOrg.id).eq('user_id', userId)
    refetchUsers()
  }

  const handleRemoveUser = async (userId: string) => {
    if (!currentOrg?.id || !confirm('Remove this user from the workspace?')) return
    await supabase.from('organization_users').delete().eq('org_id', currentOrg.id).eq('user_id', userId)
    refetchUsers()
  }

  const handleCreateRole = async () => {
    if (!newRoleName.trim()) return
    const slug = newRoleName.trim().toLowerCase().replace(/\s+/g, '_')
    const { error } = await supabase.from('roles').insert({ name: slug, permissions: {} })
    if (error) { setRoleMessage(error.message); return }
    setNewRoleName('')
    setRoleMessage(`Role "${slug}" created`)
    refetchRoles()
  }

  const handleTogglePermission = async (roleId: string, permission: string) => {
    const existing = rolePermissions.find(rp => rp.role_id === roleId && rp.permission === permission)
    if (existing) {
      await supabase.from('role_permissions').delete().eq('id', existing.id)
    } else {
      await supabase.from('role_permissions').insert({ role_id: roleId, permission })
    }
    refetchRoles()
  }

  const handleDeleteRole = async (roleId: string) => {
    const role = roles.find(r => r.id === roleId)
    if (!role || ['admin', 'member'].includes(role.name)) { setRoleMessage('Cannot delete built-in roles'); return }
    if (!confirm(`Delete role "${role.name}"? Users with this role will lose permissions.`)) return
    await supabase.from('role_permissions').delete().eq('role_id', roleId)
    await supabase.from('roles').delete().eq('id', roleId)
    setRoleMessage(`Role "${role.name}" deleted`)
    refetchRoles()
  }

  const getRolePerms = (roleId: string) => rolePermissions.filter(rp => rp.role_id === roleId).map(rp => rp.permission)

  const refetchPhones = async () => {
    if (!currentOrg?.id) return
    const { data } = await supabase.from('phone_numbers').select('id, org_id, phone_number, friendly_name, is_active').eq('org_id', currentOrg.id).order('phone_number')
    setPhoneNumbers((data as PhoneNumber[]) ?? [])
  }

  const refetchImap = async () => {
    if (!currentOrg?.id) return
    const { data, error } = await supabase
      .from('imap_accounts')
      .select('id, org_id, label, email, host, port, imap_encryption, imap_username, addresses, smtp_host, smtp_port, smtp_use_tls, smtp_username, is_active')
      .eq('org_id', currentOrg.id)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('Failed to fetch IMAP accounts:', error)
      setImapMessage('Could not load IMAP accounts. You may need to refresh.')
      return
    }
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
    const isEdit = Boolean(editingImapId)
    if (!testSmtpOnly && (!imapHost.trim() || !imapUsername.trim())) {
      return { error: { message: 'Fill in host and username.' } }
    }
    if (!testSmtpOnly && !imapPassword && !(save && isEdit)) {
      return { error: { message: 'Fill in password (required to test; leave blank when saving only to keep current).' } }
    }
    if (testSmtpOnly && (!smtpHost.trim() || !smtpUsername.trim() || !smtpPassword)) {
      return { error: { message: 'Fill in SMTP host, username, and password.' } }
    }
    const addresses = [
      imapUsername.trim().toLowerCase(),
      ...imapAliases
        .split(/[\n,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && s.includes('@')),
    ].filter((s, i, a) => a.indexOf(s) === i)
    const body = {
      orgId: currentOrg.id,
      accountId: editingImapId || null,
      email: imapUsername.trim(),
      host: imapHost.trim(),
      port: imapPort || (imapEncryption === 'ssl' ? 993 : 143),
      imapEncryption,
      username: imapUsername.trim(),
      password: imapPassword || null,
      label: imapLabel.trim() || null,
      addresses: addresses.length ? addresses : [imapUsername.trim().toLowerCase()],
      save,
      testSmtpOnly: testSmtpOnly || false,
      smtpHost: smtpHost.trim() || null,
      smtpPort: smtpPort || 587,
      smtpEncryption,
      smtpUsername: smtpUsername.trim() || null,
      smtpPassword: smtpPassword || null,
    }
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-test-and-save`
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      return { error: { message: 'Please sign in again.' } }
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string }
    let errMsg = data?.error ?? (!res.ok ? (data?.message || res.statusText || `Request failed (${res.status})`) : null)
    if (res.status === 401 && errMsg?.toLowerCase().includes('jwt')) {
      try {
        const payload = JSON.parse(atob(session.access_token.split('.')[1]))
        const iss = payload.iss ?? 'unknown'
        const expectedOrigin = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '')
        const tokenOrigin = iss.replace('/auth/v1', '')
        if (tokenOrigin !== expectedOrigin) {
          errMsg = `Invalid JWT: session was issued by ${tokenOrigin} but the app is calling ${expectedOrigin}. Sign out and sign in again.`
        } else {
          errMsg = `Invalid JWT: token issuer matches (${iss}). Try signing out and back in, or check Project Settings → API → JWT Secret hasn’t been rotated.`
        }
      } catch {
        errMsg = `Invalid JWT. Sign out and sign in again, then retry.`
      }
    }
    if (errMsg) return { error: { message: errMsg } }
    return { data }
  }

  const handleTestImap = async () => {
    setImapTestLoading(true)
    setImapTestMessage(null)
    setSmtpTestMessage(null)
    const { error } = await callImapEdge(false)
    if (error) {
      setImapTestMessage(error.message)
    } else {
      setImapTestMessage('IMAP connection successful.')
    }
    setImapTestLoading(false)
  }

  const callImapSync = async (accountId: string, resync = true) => {
    if (!currentOrg?.id) return { error: 'No workspace selected.' }
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return { error: 'Please sign in again.' }
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-sync`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ orgId: currentOrg.id, accountId, resync }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      messagesInserted?: number
      messagesUpdated?: number
      threadsCreated?: number
      errors?: string[]
    }
    if (data?.error) return { error: data.error }
    if (data?.errors?.length) return { error: data.errors.join('; ') }
    return {
      messagesInserted: data?.messagesInserted ?? 0,
      messagesUpdated: data?.messagesUpdated ?? 0,
      threadsCreated: data?.threadsCreated ?? 0,
    }
  }

  const handleSyncImap = async (accountId: string) => {
    setImapSyncAccountId(accountId)
    setImapSyncMessage(null)
    const result = await callImapSync(accountId)
    setImapSyncAccountId(null)
    if (result?.error) {
      setImapSyncMessage(result.error)
    } else {
      const { messagesInserted = 0, messagesUpdated = 0, threadsCreated = 0 } = result as {
        messagesInserted?: number
        messagesUpdated?: number
        threadsCreated?: number
      }
      const parts: string[] = []
      if (messagesUpdated > 0) parts.push(`${messagesUpdated} message(s) re-downloaded`)
      if (messagesInserted > 0) parts.push(`${messagesInserted} new message(s), ${threadsCreated} thread(s)`)
      setImapSyncMessage(
        parts.length > 0 ? `Sync complete. ${parts.join('; ')}.` : 'Sync complete. No new messages.'
      )
    }
  }

  const handleTestSmtp = async () => {
    setSmtpTestLoading(true)
    setSmtpTestMessage(null)
    setImapTestMessage(null)
    const { error } = await callImapEdge(false, true)
    if (error) {
      setSmtpTestMessage(error.message)
    } else {
      setSmtpTestMessage('SMTP connection successful.')
    }
    setSmtpTestLoading(false)
  }

  const handleTestSlackChannels = async () => {
    if (!currentOrg?.id) return
    setSlackTestLoading(true)
    setSlackTestMessage(null)
    setSlackTestChannels([])
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.refreshSession()
      const token = session?.access_token
      if (sessionError || !token) {
        setSlackTestMessage('You must be signed in to test Slack channel access. Try signing out and back in.')
        setSlackTestLoading(false)
        return
      }
      const callSlackChannels = async () => {
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/slack-channels`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ orgId: currentOrg.id }),
        })
        const raw = await res.text()
        const data = (JSON.parse(raw || '{}')) as {
          error?: string
          channels?: { id: string; name: string; is_private: boolean; is_member: boolean }[]
          isActive?: boolean
        }
        return { res, raw, data }
      }

      let { res, raw, data } = await callSlackChannels()

      if (!res.ok || data.error) {
        const fallback = raw?.slice(0, 240) || `HTTP ${res.status}`
        let msg = data.error || `Could not retrieve channels from Slack (${fallback}).`
        if (res.status === 401 && (raw.includes('Invalid JWT') || raw.includes('invalid') || raw.includes('JWT'))) {
          msg = 'Session expired or invalid. Sign out and sign back in, then try again. If it persists, deploy the function with: supabase functions deploy slack-channels --no-verify-jwt'
        }
        setSlackTestMessage(msg)
        return
      }
      const channels = data.channels ?? []
      setSlackTestChannels(channels)
      const memberCount = channels.filter((c) => c.is_member).length
      const privateCount = channels.filter((c) => c.is_private).length
      const publicCount = channels.length - privateCount
      setSlackTestMessage(`Retrieved ${channels.length} total channel(s): ${publicCount} public, ${privateCount} private. Bot is in ${memberCount} channel(s).${data.isActive ? '' : ' (Config is currently disabled)'}`)
    } catch (err) {
      setSlackTestMessage((err as Error).message || 'Could not retrieve channels from Slack.')
    } finally {
      setSlackTestLoading(false)
    }
  }

  const startEditImap = (acc: ImapAccount) => {
    setImapView('form')
    setEditingImapId(acc.id)
    setImapLabel(acc.label ?? '')
    setImapUsername(acc.imap_username ?? acc.email)
    setImapAliases((acc.addresses ?? [acc.email]).filter((a) => a !== (acc.imap_username ?? acc.email)).join('\n'))
    setImapHost(acc.host ?? 'imap.gmail.com')
    setImapPort(acc.port ?? 993)
    setImapEncryption((acc.imap_encryption as 'none' | 'tls' | 'ssl') ?? 'ssl')
    setImapPassword('')
    setSmtpHost(acc.smtp_host ?? 'smtp.gmail.com')
    setSmtpPort(acc.smtp_port ?? 587)
    setSmtpEncryption(acc.smtp_use_tls ? 'tls' : 'ssl')
    setSmtpUsername(acc.smtp_username ?? '')
    setSmtpPassword('')
    setImapMessage(null)
    setImapTestMessage(null)
    setSmtpTestMessage(null)
  }

  const cancelEditImap = () => {
    setEditingImapId(null)
    setImapLabel('')
    setImapUsername('')
    setImapAliases('')
    setImapHost('imap.gmail.com')
    setImapPort(993)
    setImapEncryption('ssl')
    setImapPassword('')
    setSmtpHost('smtp.gmail.com')
    setSmtpPort(587)
    setSmtpEncryption('tls')
    setSmtpUsername('')
    setSmtpPassword('')
    setImapMessage(null)
    setImapTestMessage(null)
    setSmtpTestMessage(null)
  }

  const handleRemoveImap = async (id: string) => {
    if (!currentOrg?.id) return
    if (!window.confirm('Remove this IMAP account? This cannot be undone.')) return
    const { error } = await supabase.from('imap_accounts').delete().eq('id', id).eq('org_id', currentOrg.id)
    if (error) setImapMessage(error.message)
    else {
      setImapMessage('Account removed.')
      if (editingImapId === id) {
        cancelEditImap()
        setImapView('list')
      }
      refetchImap()
    }
  }

  const handleAddImap = async (e: React.FormEvent) => {
    e.preventDefault()
    const isEdit = Boolean(editingImapId)
    if (!currentOrg?.id || !imapHost.trim() || !imapUsername.trim()) {
      setImapMessage('Fill in host and username.')
      return
    }
    if (!isEdit && !imapPassword) {
      setImapMessage('Fill in password when adding an account.')
      return
    }
    const primaryEmail = imapUsername.trim().toLowerCase()
    if (!isEdit && imapAccounts.some((acc) => (acc.imap_username ?? acc.email).toLowerCase() === primaryEmail)) {
      setImapMessage('This account is already added for this workspace.')
      return
    }
    setImapLoading(true)
    setImapMessage(null)
    setImapTestMessage(null)
    setSmtpTestMessage(null)
    const { error } = await callImapEdge(true)
    if (error) {
      setImapMessage(error.message)
    } else {
      setImapMessage(editingImapId ? 'Account updated.' : 'IMAP account added. You can turn sync on from the Inbox once it’s set up.')
      cancelEditImap()
      setImapView('list')
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
              <h2 className="text-xl font-semibold text-white mb-2">Users &amp; Roles</h2>
              <p className="text-gray-400 text-sm mb-4">Manage team members, roles, and granular permissions for this workspace.</p>

              {/* Tabs */}
              <div className="flex gap-1 mb-6 border-b border-border">
                {([['members', 'Members'], ['roles', 'Roles & Permissions'], ['invitations', 'Invitations']] as const).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setUsersTab(id)}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${usersTab === id ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Members tab */}
              {usersTab === 'members' && (
                <>
                  <form onSubmit={handleInvite} className="rounded-lg border border-border bg-surface-elevated p-4 mb-6 space-y-3">
                    <h3 className="text-sm font-medium text-white">Add user</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="admin-invite-email" className="block text-xs font-medium text-gray-500 mb-1">Email</label>
                        <input id="admin-invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@example.com"
                          className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                      </div>
                      <div>
                        <label htmlFor="admin-invite-role" className="block text-xs font-medium text-gray-500 mb-1">Role</label>
                        <select id="admin-invite-role" value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)}
                          className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50">
                          <option value="">Select role</option>
                          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={inviteSendMagicLink} onChange={(e) => setInviteSendMagicLink(e.target.checked)}
                        className="rounded border-border bg-surface-muted text-accent focus:ring-accent" />
                      <span className="text-sm text-gray-400">Send magic link</span>
                    </label>
                    {inviteMessage && <p className={`text-sm ${inviteMessage.includes('Invitation') ? 'text-accent' : 'text-red-400'}`}>{inviteMessage}</p>}
                    <button type="submit" disabled={inviteLoading || !inviteEmail.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
                      <UserPlus className="w-4 h-4" /> {inviteLoading ? 'Sending…' : 'Add user'}
                    </button>
                  </form>

                  <div className="rounded-lg border border-border bg-surface-elevated">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <h3 className="text-sm font-medium text-white">Members ({members.length})</h3>
                    </div>
                    {members.length === 0 ? <p className="p-4 text-gray-400 text-sm">No members yet.</p> : (
                      <table className="w-full text-sm">
                        <thead><tr className="border-b border-border text-gray-500 text-xs">
                          <th className="text-left px-4 py-2 font-medium">User</th>
                          <th className="text-left px-4 py-2 font-medium">Role</th>
                          <th className="text-right px-4 py-2 font-medium">Actions</th>
                        </tr></thead>
                        <tbody className="divide-y divide-border">
                          {members.map((m) => {
                            const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
                            return (
                              <tr key={m.user_id} className="hover:bg-surface-muted/30">
                                <td className="px-4 py-3">
                                  <p className="text-gray-200 font-medium">{profile?.display_name ?? '—'}</p>
                                  <p className="text-gray-500 text-xs">{profile?.email ?? '—'}</p>
                                </td>
                                <td className="px-4 py-3">
                                  <select value={m.role_id} onChange={(e) => handleChangeUserRole(m.user_id, e.target.value)}
                                    className="rounded border border-border bg-surface-muted px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent">
                                    {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                  </select>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <button type="button" onClick={() => handleRemoveUser(m.user_id)}
                                    className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-surface-muted" title="Remove user">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}

              {/* Roles & Permissions tab */}
              {usersTab === 'roles' && (
                <>
                  {roleMessage && <p className={`text-sm mb-4 ${roleMessage.includes('created') || roleMessage.includes('deleted') ? 'text-accent' : 'text-red-400'}`}>{roleMessage}</p>}

                  {/* Create new role */}
                  <div className="flex items-center gap-2 mb-6">
                    <input type="text" value={newRoleName} onChange={e => setNewRoleName(e.target.value)} placeholder="New role name"
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateRole() } }}
                      className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 w-48" />
                    <button type="button" onClick={handleCreateRole} disabled={!newRoleName.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
                      <Plus className="w-4 h-4" /> Create role
                    </button>
                  </div>

                  {/* Permissions matrix */}
                  <div className="rounded-lg border border-border bg-surface-elevated overflow-x-auto">
                    <table className="w-full text-sm min-w-[600px]">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 w-40">Module / Permission</th>
                          {roles.map(r => (
                            <th key={r.id} className="px-3 py-3 text-xs font-medium text-gray-300 text-center">
                              <div>{r.name}</div>
                              {!['admin', 'member'].includes(r.name) && (
                                <button type="button" onClick={() => handleDeleteRole(r.id)} className="text-[10px] text-gray-500 hover:text-red-400 mt-0.5">delete</button>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ALL_PERMISSIONS.map(mod => (
                          mod.perms.map((perm, pi) => (
                            <tr key={perm} className={`border-b border-border ${pi === 0 ? 'border-t border-border/50' : ''}`}>
                              <td className="px-4 py-2 text-gray-300">
                                {pi === 0 && <span className="text-xs font-medium text-gray-400 uppercase block mb-0.5">{mod.module}</span>}
                                <span className="text-xs">{perm.split('.')[1]}</span>
                              </td>
                              {roles.map(r => {
                                const has = getRolePerms(r.id).includes(perm)
                                return (
                                  <td key={r.id} className="px-3 py-2 text-center">
                                    <button type="button" onClick={() => handleTogglePermission(r.id, perm)}
                                      className={`w-5 h-5 rounded border ${has ? 'bg-accent border-accent text-white' : 'border-border text-transparent hover:border-gray-500'} flex items-center justify-center mx-auto transition-colors`}>
                                      {has && <Check className="w-3 h-3" />}
                                    </button>
                                  </td>
                                )
                              })}
                            </tr>
                          ))
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Invitations tab */}
              {usersTab === 'invitations' && (
                <div className="rounded-lg border border-border bg-surface-elevated">
                  <h3 className="text-sm font-medium text-white px-4 py-3 border-b border-border">Pending invitations</h3>
                  {invitations.length === 0 ? <p className="p-4 text-gray-400 text-sm">No pending invitations.</p> : (
                    <ul className="divide-y divide-border">
                      {invitations.map((inv) => (
                        <li key={inv.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                          <Mail className="w-4 h-4 text-gray-500 shrink-0" />
                          <span className="text-gray-200 flex-1">{inv.email}</span>
                          <span className="text-gray-500 text-xs">{roles.find((r) => r.id === inv.role_id)?.name ?? '—'}</span>
                          <span className="text-gray-500 text-xs">{new Date(inv.created_at).toLocaleDateString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {section === 'imap' && imapView === 'list' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Email accounts</h2>
              <p className="text-gray-400 text-sm mb-6">
                Connect email accounts to monitor in the Inbox.
              </p>
              <div className="flex gap-3 mb-6">
                <button type="button" onClick={() => {
                  cancelEditImap()
                  setImapHost('imap.gmail.com'); setImapPort(993); setImapEncryption('ssl')
                  setSmtpHost('smtp.gmail.com'); setSmtpPort(587); setSmtpEncryption('tls')
                  setImapView('form')
                }}
                  className="flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border border-border hover:border-accent/50 hover:bg-surface-muted/50 transition-colors cursor-pointer">
                  <svg className="w-8 h-8" viewBox="0 0 24 24"><path fill="#EA4335" d="M1 5.64L12 13.14L23 5.64V18.36C23 19.26 22.26 20 21.36 20H2.64C1.74 20 1 19.26 1 18.36V5.64Z"/><path fill="#4285F4" d="M23 5.64L12 13.14L1 5.64L12 0L23 5.64Z" opacity="0.8"/></svg>
                  <span className="text-sm font-medium text-white">Google Gmail</span>
                  <span className="text-xs text-gray-500">App Password required</span>
                </button>
                <button type="button" onClick={() => {
                  cancelEditImap()
                  setImapHost(''); setImapPort(993); setImapEncryption('ssl')
                  setSmtpHost(''); setSmtpPort(587); setSmtpEncryption('tls')
                  setImapView('form')
                }}
                  className="flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border border-border hover:border-accent/50 hover:bg-surface-muted/50 transition-colors cursor-pointer">
                  <Mail className="w-8 h-8 text-gray-400" />
                  <span className="text-sm font-medium text-white">Other IMAP</span>
                  <span className="text-xs text-gray-500">Custom server settings</span>
                </button>
              </div>
              <div>
              </div>
              <div className="rounded-lg border border-border bg-surface-elevated">
                {imapAccounts.length === 0 ? (
                  <p className="p-4 text-gray-400 text-sm">No IMAP accounts yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {imapAccounts.map((acc) => (
                      <li key={acc.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                        <div>
                          <p className="text-gray-200 font-medium">{acc.label || acc.email}</p>
                          <p className="text-gray-500 text-xs">{acc.email}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-xs px-2 py-1 rounded ${acc.is_active ? 'bg-accent/20 text-accent' : 'text-gray-500'}`}>{acc.is_active ? 'On' : 'Off'}</span>
                          <button
                            type="button"
                            onClick={() => handleSyncImap(acc.id)}
                            disabled={imapSyncAccountId !== null}
                            className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted disabled:opacity-50"
                            title="Sync now"
                          >
                            <RefreshCw className={`w-4 h-4 ${imapSyncAccountId === acc.id ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditImap(acc)}
                            className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted"
                            title="Edit account"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveImap(acc.id)}
                            className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-surface-muted"
                            title="Remove account"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {imapSyncMessage && (
                  <p className={`px-4 py-2 text-sm border-t border-border ${imapSyncMessage.startsWith('Synced') || imapSyncMessage.startsWith('Sync complete') ? 'text-accent' : 'text-red-400'}`}>
                    {imapSyncMessage}
                  </p>
                )}
              </div>
            </>
          )}

          {section === 'imap' && imapView === 'form' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">{editingImapId ? 'Edit account' : 'Add email account'}</h2>
              <p className="text-gray-400 text-sm mb-6">
                {imapHost.includes('gmail.com') ? 'Gmail detected — only email and App Password are needed. Get your App Password from Account → Security → 2-Step Verification → App passwords.' : 'Enter your IMAP and SMTP server details below.'}
              </p>
              <form onSubmit={handleAddImap} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
                <div>
                  <label htmlFor="admin-imap-label" className="block text-xs font-medium text-gray-500 mb-1">Label (optional)</label>
                  <input
                    id="admin-imap-label"
                    type="text"
                    value={imapLabel}
                    onChange={(e) => setImapLabel(e.target.value)}
                    placeholder="e.g. Jason - Brogrammers"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  />
                </div>

                <h3 className="text-sm font-medium text-white pt-1">{imapHost.includes('gmail.com') ? 'Gmail account' : 'IMAP settings'}</h3>
                <div>
                  <label htmlFor="admin-imap-username" className="block text-xs font-medium text-gray-500 mb-1">{imapHost.includes('gmail.com') ? 'Email address' : 'IMAP username'}</label>
                  <input
                    id="admin-imap-username"
                    type="text"
                    value={imapUsername}
                    onChange={(e) => setImapUsername(e.target.value)}
                    placeholder="jason@jaylogan.com"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    autoComplete="username"
                  />
                  <p className="text-gray-500 text-xs mt-1">Your email address for this account (used to sign in). This is also the primary address for send/receive.</p>
                </div>
                <div>
                  <label htmlFor="admin-imap-aliases" className="block text-xs font-medium text-gray-500 mb-1">Aliases</label>
                  <textarea
                    id="admin-imap-aliases"
                    value={imapAliases}
                    onChange={(e) => setImapAliases(e.target.value)}
                    placeholder={'jason@brogrammers.agency\njason@pymuapp.com'}
                    rows={3}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-y"
                  />
                  <p className="text-gray-500 text-xs mt-1">Other addresses that send and receive through this account (one per line or comma-separated). You can send as and receive mail to any of these when replying.</p>
                </div>
                {!imapHost.includes('gmail.com') && (<>
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
                </>)}
                <div>
                  <label htmlFor="admin-imap-password" className="block text-xs font-medium text-gray-500 mb-1">{imapHost.includes('gmail.com') ? 'App Password' : 'IMAP password'}</label>
                  <input
                    id="admin-imap-password"
                    type="password"
                    value={imapPassword}
                    onChange={(e) => setImapPassword(e.target.value)}
                    placeholder={editingImapId ? 'Leave blank to keep current' : 'App password for Gmail'}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                    autoComplete="current-password"
                  />
                </div>
                <div className="flex flex-wrap gap-2 pb-2">
                  <button
                    type="button"
                    onClick={handleTestImap}
                    disabled={imapTestLoading || !imapHost.trim() || !imapUsername.trim() || !imapPassword}
                    className="px-4 py-2 rounded-lg border border-border bg-surface-muted text-gray-200 text-sm font-medium hover:bg-surface-muted/80 disabled:opacity-50"
                  >
                    {imapTestLoading ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
                {imapTestMessage && (
                  <p className={`text-sm ${imapTestMessage.includes('successful') ? 'text-accent' : 'text-red-400'}`}>{imapTestMessage}</p>
                )}

                {!imapHost.includes('gmail.com') && (
                <>
                <h3 className="text-sm font-medium text-white pt-2 border-t border-border mt-4">SMTP settings</h3>
                <p className="text-gray-500 text-xs">For sending replies from this account.</p>
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
                {smtpTestMessage && (
                  <p className={`text-sm ${smtpTestMessage.includes('successful') ? 'text-accent' : 'text-red-400'}`}>{smtpTestMessage}</p>
                )}
                </>
                )}

                {imapMessage && <p className={`text-sm ${imapMessage.includes('added') || imapMessage.includes('updated') || imapMessage.includes('removed') ? 'text-accent' : 'text-red-400'}`}>{imapMessage}</p>}
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      cancelEditImap()
                      setImapView('list')
                    }}
                    className="px-4 py-2 rounded-lg border border-border bg-surface-muted text-gray-200 text-sm font-medium hover:bg-surface-muted/80"
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={imapLoading || !imapHost.trim() || !imapUsername.trim() || (!!editingImapId ? false : !imapPassword)} className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
                    {imapLoading ? (editingImapId ? 'Updating…' : 'Adding…') : (editingImapId ? 'Update account' : 'Add IMAP account')}
                  </button>
                </div>
              </form>
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

          {section === 'slack' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Slack Integration</h2>
              <p className="text-gray-400 text-sm mb-4">Connect a custom Slack bot for real-time notifications and team collaboration.</p>

              <div className="flex gap-1 mb-6 border-b border-border">
                {([['connection', 'Bot Configuration'], ['notifications', 'Notification Settings'], ['mapping', 'User mapping'], ['test', 'Channel Access Test']] as const).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setSlackTab(id)}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${slackTab === id ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {slackTab === 'connection' && (
                <div className="rounded-lg border border-border bg-surface-elevated p-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Bot Token <span className="text-accent">*</span></label>
                      <input type="password" value={slackForm.bot_token} onChange={e => setSlackForm(f => ({ ...f, bot_token: e.target.value }))}
                        placeholder="xoxb-..."
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                      <p className="text-gray-500 text-xs mt-1">Bot User OAuth Token from OAuth & Permissions page.</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Signing Secret <span className="text-accent">*</span></label>
                      <input type="password" value={slackForm.signing_secret} onChange={e => setSlackForm(f => ({ ...f, signing_secret: e.target.value }))}
                        placeholder="abc123..."
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                      <p className="text-gray-500 text-xs mt-1">From Basic Information → App Credentials. Verifies incoming Slack requests.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">App ID</label>
                      <input type="text" value={slackForm.app_id} onChange={e => setSlackForm(f => ({ ...f, app_id: e.target.value }))}
                        placeholder="A0XXXXXXX"
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Bot User ID <span className="text-accent">*</span></label>
                      <input type="text" value={slackForm.bot_user_id} onChange={e => setSlackForm(f => ({ ...f, bot_user_id: e.target.value }))}
                        placeholder="U0XXXXXXX"
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                      <p className="text-gray-500 text-xs mt-1">Used to identify the bot's own messages.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Client ID</label>
                      <input type="text" value={slackForm.client_id} onChange={e => setSlackForm(f => ({ ...f, client_id: e.target.value }))}
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Client Secret</label>
                      <input type="password" value={slackForm.client_secret} onChange={e => setSlackForm(f => ({ ...f, client_secret: e.target.value }))}
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-xs text-gray-400 space-y-1">
                    <p className="font-medium text-gray-300">Required Slack app bot scopes</p>
                    <p>chat:write, conversations:read, users:read, app_mentions:read, channels:history, groups:history</p>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={slackForm.is_active} onChange={e => setSlackForm(f => ({ ...f, is_active: e.target.checked }))}
                      className="rounded border-border bg-surface-muted text-accent focus:ring-accent" />
                    <span className="text-sm text-gray-300">Enable Slack integration</span>
                  </label>
                </div>
              )}

              {slackTab === 'notifications' && (
                <div className="rounded-lg border border-border bg-surface-elevated p-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Default Channel</label>
                      <input type="text" value={slackForm.default_channel} onChange={e => setSlackForm(f => ({ ...f, default_channel: e.target.value }))}
                        placeholder="#general"
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                      <p className="text-gray-500 text-xs mt-1">Fallback channel when no project/contact-specific channel is configured.</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Inbox Channel</label>
                      <input type="text" value={slackForm.inbox_channel} onChange={e => setSlackForm(f => ({ ...f, inbox_channel: e.target.value }))}
                        placeholder="#inbox"
                        className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                      <p className="text-gray-500 text-xs mt-1">Dedicated channel for all inbox notifications. Overrides default channel for email events.</p>
                    </div>
                  </div>
                  <h3 className="text-sm font-medium text-white pt-2">Notification Events</h3>
                  <div className="space-y-2">
                    {[
                      { key: 'notify_on_new_email' as const, label: 'New inbound emails', desc: 'Post a message when a new email arrives in any inbox account' },
                      { key: 'notify_on_assignment' as const, label: 'Thread assignments', desc: 'Post when a thread is assigned to a team member' },
                      { key: 'notify_on_mention' as const, label: 'Internal comment mentions', desc: 'Post when someone is @mentioned in an internal comment' },
                      { key: 'notify_on_thread_close' as const, label: 'Thread closed', desc: 'Post when a thread is closed or resolved' },
                      { key: 'notify_on_task_created' as const, label: 'Task created', desc: 'Post when a new task is added to a project' },
                      { key: 'notify_on_task_status_change' as const, label: 'Task status change', desc: 'Post when a task\'s status is updated' },
                      { key: 'notify_on_task_comment' as const, label: 'Task comment', desc: 'Post when a comment is added to a task' },
                    ].map(ev => (
                      <label key={ev.key} className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-surface-muted/50">
                        <input type="checkbox" checked={slackForm[ev.key]} onChange={e => setSlackForm(f => ({ ...f, [ev.key]: e.target.checked }))}
                          className="rounded border-border bg-surface-muted text-accent focus:ring-accent mt-0.5" />
                        <div>
                          <span className="text-sm text-gray-200 font-medium">{ev.label}</span>
                          <p className="text-xs text-gray-500">{ev.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 p-3 rounded-lg bg-surface-muted/50 border border-border">
                    <h4 className="text-xs font-medium text-gray-400 mb-2">Channel Routing</h4>
                    <ul className="text-xs text-gray-500 space-y-1">
                      <li>1. Project-specific channel (set in Project → Slack channel)</li>
                      <li>2. Contact/company-specific channel (via slack_contact_channels)</li>
                      <li>3. Inbox channel (if set above)</li>
                      <li>4. Default channel (fallback)</li>
                    </ul>
                  </div>
                </div>
              )}

              {slackTab === 'mapping' && (
                <div className="rounded-lg border border-border bg-surface-elevated p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-white">Map users to Slack</h3>
                      <p className="text-xs text-gray-500">Link workspace members to their Slack profiles. Used for @mentions and notifications. Only admins can edit.</p>
                    </div>
                    <button type="button" onClick={loadSlackUsersAndMappings} disabled={slackMappingLoading || !currentOrg?.id}
                      className="px-3 py-1.5 rounded-lg border border-border bg-surface-muted text-gray-200 text-xs font-medium hover:bg-surface-muted/80 disabled:opacity-50 flex items-center gap-1">
                      <RefreshCw className={`w-3.5 h-3.5 ${slackMappingLoading ? 'animate-spin' : ''}`} />
                      {slackMappingLoading ? 'Loading…' : 'Refresh Slack users'}
                    </button>
                  </div>
                  {slackMappingError && <p className="text-xs text-amber-500">{slackMappingError}</p>}
                  {slackMappingLoading ? (
                    <p className="text-sm text-gray-500">Loading…</p>
                  ) : (
                    <div className="space-y-2">
                      {members.length === 0 ? (
                        <p className="text-sm text-gray-500">No workspace members. Add members in Users &amp; Roles.</p>
                      ) : (
                        <div className="rounded-lg border border-border overflow-hidden">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border text-left text-xs text-gray-500">
                                <th className="px-3 py-2 font-medium">Member</th>
                                <th className="px-3 py-2 font-medium">Slack user</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {members.map((m) => {
                                const prof = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
                                const name = (prof as { display_name?: string | null; email?: string | null })?.display_name ?? (prof as { email?: string | null })?.email ?? m.user_id.slice(0, 8)
                                const current = userSlackMappings.find((x) => x.user_id === m.user_id)?.slack_user_id ?? ''
                                return (
                                  <tr key={m.user_id}>
                                    <td className="px-3 py-2 text-gray-200">{name}</td>
                                    <td className="px-3 py-2">
                                      <select
                                        value={current}
                                        onChange={async (e) => {
                                          const slackUserId = e.target.value
                                          if (!currentOrg?.id) return
                                          if (slackUserId === '') {
                                            await supabase.from('user_slack_mappings').delete().eq('org_id', currentOrg.id).eq('user_id', m.user_id)
                                          } else {
                                            await supabase.from('user_slack_mappings').upsert(
                                              { org_id: currentOrg.id, user_id: m.user_id, slack_user_id: slackUserId },
                                              { onConflict: 'org_id,user_id' }
                                            )
                                          }
                                          setUserSlackMappings((prev) => {
                                            const rest = prev.filter((x) => x.user_id !== m.user_id)
                                            if (slackUserId === '') return rest
                                            return [...rest, { user_id: m.user_id, slack_user_id: slackUserId }]
                                          })
                                        }}
                                        className="w-full max-w-xs rounded border border-border bg-surface-muted px-2 py-1.5 text-gray-200 text-xs focus:outline-none focus:ring-1 focus:ring-accent"
                                      >
                                        <option value="">— Not linked</option>
                                        {slackUsers.map((u) => (
                                          <option key={u.id} value={u.id}>{u.label}</option>
                                        ))}
                                      </select>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {slackTab === 'test' && (
                <div className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
                  <h3 className="text-sm font-medium text-white">Slack channel access test</h3>
                  <p className="text-xs text-gray-500">Confirm jolo can retrieve all Slack channels (public and private) for this workspace bot.</p>
                  <button
                    type="button"
                    onClick={handleTestSlackChannels}
                    disabled={slackTestLoading || !currentOrg?.id}
                    className="px-3 py-2 rounded-lg border border-border bg-surface-muted text-gray-200 text-sm font-medium hover:bg-surface-muted/80 disabled:opacity-50"
                  >
                    {slackTestLoading ? 'Testing…' : 'Test Slack Channel Access'}
                  </button>
                  {slackTestMessage && (
                    <p className={`text-sm ${slackTestMessage.startsWith('Retrieved') ? 'text-accent' : 'text-red-400'}`}>{slackTestMessage}</p>
                  )}
                  {slackTestChannels.length > 0 && (
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="max-h-64 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500 border-b border-border">
                              <th className="text-left px-3 py-2 font-medium">Channel</th>
                              <th className="text-left px-3 py-2 font-medium">Type</th>
                              <th className="text-left px-3 py-2 font-medium">Bot Access</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {slackTestChannels.map((c) => (
                              <tr key={c.id}>
                                <td className="px-3 py-2 text-gray-200">#{c.name}</td>
                                <td className="px-3 py-2 text-gray-400">{c.is_private ? 'Private' : 'Public'}</td>
                                <td className={`px-3 py-2 ${c.is_member ? 'text-accent' : 'text-yellow-400'}`}>{c.is_member ? 'Joined' : 'Not joined'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {slackMessage && <p className={`text-sm mt-4 ${slackMessage.includes('Saved') ? 'text-accent' : 'text-red-400'}`}>{slackMessage}</p>}
              {slackTab !== 'test' && slackTab !== 'mapping' && (
                <button type="button" onClick={async () => {
                if (!currentOrg?.id) return
                if (!slackForm.bot_token.trim() || !slackForm.signing_secret.trim() || !slackForm.app_id.trim() || !slackForm.bot_user_id.trim() || !slackForm.client_id.trim() || !slackForm.client_secret.trim()) {
                  setSlackMessage('Please fill all required Slack fields.')
                  return
                }
                setSlackSaving(true); setSlackMessage(null)
                const payload = {
                  org_id: currentOrg.id,
                  bot_token: slackForm.bot_token.trim() || null,
                  default_channel: slackForm.default_channel.trim() || null,
                  inbox_channel: slackForm.inbox_channel.trim() || null,
                  app_id: slackForm.app_id.trim() || null,
                  client_id: slackForm.client_id.trim() || null,
                  client_secret: slackForm.client_secret.trim() || null,
                  signing_secret: slackForm.signing_secret.trim() || null,
                  bot_user_id: slackForm.bot_user_id.trim() || null,
                  is_active: slackForm.is_active,
                  notify_on_new_email: slackForm.notify_on_new_email,
                  notify_on_assignment: slackForm.notify_on_assignment,
                  notify_on_mention: slackForm.notify_on_mention,
                  notify_on_thread_close: slackForm.notify_on_thread_close,
                  notify_on_task_created: slackForm.notify_on_task_created,
                  notify_on_task_status_change: slackForm.notify_on_task_status_change,
                  notify_on_task_comment: slackForm.notify_on_task_comment,
                  updated_at: new Date().toISOString(),
                }
                if (slackConfig) {
                  const { error } = await supabase.from('slack_configs').update(payload).eq('id', slackConfig.id)
                  if (error) setSlackMessage(error.message); else setSlackMessage('Saved.')
                } else {
                  const { data, error } = await supabase.from('slack_configs').insert(payload).select('*').single()
                  if (error) setSlackMessage(error.message); else { setSlackConfig(data as SlackConfig); setSlackMessage('Saved.') }
                }
                setSlackSaving(false)
              }} disabled={slackSaving}
                className="mt-4 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {slackSaving ? 'Saving…' : 'Save Slack Configuration'}
                </button>
              )}
            </>
          )}

          {section === 'settings' && (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Organization settings</h2>
              <p className="text-gray-400 text-sm mb-6">
                Workspace timezone is used for Slack notification timestamps and other dates.
              </p>
              <div className="rounded-lg border border-border bg-surface-elevated p-6 max-w-md">
                <label className="block text-xs font-medium text-gray-500 mb-2">Workspace timezone</label>
                <select value={orgTimezone} onChange={e => setOrgTimezone(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50">
                  <option value="America/New_York">Eastern (EST/EDT)</option>
                  <option value="America/Chicago">Central (CST/CDT)</option>
                  <option value="America/Denver">Mountain (MST/MDT)</option>
                  <option value="America/Los_Angeles">Pacific (PST/PDT)</option>
                  <option value="America/Phoenix">Arizona (MST)</option>
                  <option value="UTC">UTC</option>
                  <option value="Europe/London">London (GMT/BST)</option>
                  <option value="Europe/Paris">Central European (CET/CEST)</option>
                  <option value="Asia/Tokyo">Tokyo (JST)</option>
                </select>
                <p className="text-xs text-gray-500 mt-2">Used for times shown in Slack alerts (e.g. task comments, new emails).</p>
                <button type="button" disabled={!currentOrg?.id || orgTimezoneSaving}
                  onClick={async () => {
                    if (!currentOrg?.id) return
                    setOrgTimezoneSaving(true)
                    setSettingsMessage(null)
                    const { error } = await supabase.from('organizations').update({ timezone: orgTimezone }).eq('id', currentOrg.id)
                    setOrgTimezoneSaving(false)
                    if (error) setSettingsMessage(error.message)
                    else setSettingsMessage('Timezone saved.')
                    setTimeout(() => setSettingsMessage(null), 3000)
                  }}
                  className="mt-4 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                  {orgTimezoneSaving ? 'Saving…' : 'Save timezone'}
                </button>
                {settingsMessage && <p className={`mt-2 text-sm ${settingsMessage.includes('saved') ? 'text-accent' : 'text-red-400'}`}>{settingsMessage}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
