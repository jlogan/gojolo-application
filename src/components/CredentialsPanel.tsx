import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Eye, EyeOff, KeyRound, Lock, Pencil, Plus, Trash2, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

type Credential = {
  id: string
  org_id: string
  company_id: string | null
  project_id: string | null
  label: string
  credential_type: string
  username: string | null
  url: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

type CredentialForm = {
  label: string
  username: string
  password: string
  url: string
  notes: string
  credentialType: string
  scope: 'company' | 'project'
}

type CredentialsPanelProps = {
  orgId: string
  companyId?: string | null
  projectId?: string | null
  title?: string
  description?: string
}

const emptyForm = (scope: 'company' | 'project'): CredentialForm => ({
  label: '',
  username: '',
  password: '',
  url: '',
  notes: '',
  credentialType: 'login',
  scope,
})

async function callVault(sessionToken: string, body: Record<string, unknown>) {
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vault-credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.error) throw new Error(data?.error || 'Vault request failed')
  return data
}

export default function CredentialsPanel({ orgId, companyId = null, projectId = null, title = 'Credentials', description }: CredentialsPanelProps) {
  const { user, session } = useAuth()
  const defaultScope = projectId ? 'project' : 'company'
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Credential | null>(null)
  const [form, setForm] = useState<CredentialForm>(() => emptyForm(defaultScope))
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [unlockCredential, setUnlockCredential] = useState<Credential | null>(null)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [copyAfterUnlock, setCopyAfterUnlock] = useState(false)

  const canChooseScope = Boolean(companyId && projectId)
  const authProvider = String(user?.app_metadata?.provider ?? '')
  const needsOAuthUnlock = authProvider && authProvider !== 'email'

  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token || !orgId || (!companyId && !projectId)) return
    setLoading(true)
    setError(null)
    try {
      const data = await callVault(session.access_token, {
        action: 'list',
        orgId,
        companyId,
        projectId,
      })
      setCredentials((data.credentials as Credential[]) ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load credentials')
      setCredentials([])
    } finally {
      setLoading(false)
    }
  }, [companyId, orgId, projectId, session?.access_token])

  useEffect(() => {
    void fetchCredentials()
  }, [fetchCredentials])

  const startNew = () => {
    setEditing(null)
    setForm(emptyForm(defaultScope))
    setShowForm(true)
  }

  const startEdit = (credential: Credential) => {
    setEditing(credential)
    setForm({
      label: credential.label,
      username: credential.username ?? '',
      password: '',
      url: credential.url ?? '',
      notes: credential.notes ?? '',
      credentialType: credential.credential_type || 'login',
      scope: credential.project_id ? 'project' : 'company',
    })
    setShowForm(true)
  }

  const resetForm = () => {
    setShowForm(false)
    setEditing(null)
    setForm(emptyForm(defaultScope))
  }

  const scopeIds = useMemo(() => {
    const saveToProject = form.scope === 'project' && projectId
    return {
      companyId: saveToProject ? null : companyId,
      projectId: saveToProject ? projectId : null,
    }
  }, [companyId, form.scope, projectId])

  const saveCredential = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!session?.access_token) return
    if (!form.label.trim()) return
    setSaving(true)
    setError(null)
    try {
      await callVault(session.access_token, {
        action: 'save',
        orgId,
        credentialId: editing?.id ?? null,
        companyId: scopeIds.companyId,
        projectId: scopeIds.projectId,
        label: form.label,
        credentialType: form.credentialType,
        username: form.username,
        password: form.password || null,
        url: form.url,
        notes: form.notes,
      })
      resetForm()
      await fetchCredentials()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save credential')
    } finally {
      setSaving(false)
    }
  }

  const deleteCredential = async (credential: Credential) => {
    if (!session?.access_token) return
    if (!confirm(`Delete credential "${credential.label}"?`)) return
    setError(null)
    try {
      await callVault(session.access_token, { action: 'delete', orgId, credentialId: credential.id })
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[credential.id]
        return next
      })
      await fetchCredentials()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete credential')
    }
  }

  const openUnlock = (credential: Credential, copy = false) => {
    setUnlockCredential(credential)
    setUnlockPassword('')
    setUnlockError(null)
    setCopyAfterUnlock(copy)
  }

  const revealWithFreshSession = async () => {
    if (!unlockCredential || !user?.email) return
    setUnlocking(true)
    setUnlockError(null)
    try {
      if (needsOAuthUnlock) {
        throw new Error('This account signs in with Google. Please sign out/in with Google again to refresh your session, then reveal the password.')
      }
      const { error: authError } = await supabase.auth.signInWithPassword({ email: user.email, password: unlockPassword })
      if (authError) throw new Error('Password prompt failed. Please check your GoJolo password and try again.')
      const { data: sessionData } = await supabase.auth.getSession()
      const freshToken = sessionData.session?.access_token
      if (!freshToken) throw new Error('Could not refresh your secure session.')
      const data = await callVault(freshToken, { action: 'reveal', orgId, credentialId: unlockCredential.id })
      const password = String(data.password ?? '')
      setRevealed((prev) => ({ ...prev, [unlockCredential.id]: password }))
      if (copyAfterUnlock && password) await navigator.clipboard.writeText(password)
      setUnlockCredential(null)
      setUnlockPassword('')
      setCopyAfterUnlock(false)
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Could not reveal password')
    } finally {
      setUnlocking(false)
    }
  }

  const copyValue = async (value: string) => {
    await navigator.clipboard.writeText(value)
  }

  return (
    <section className="rounded-lg border border-border p-4 bg-surface-elevated mb-6" data-testid="credentials-panel">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <KeyRound className="w-4 h-4" />
            {title} ({credentials.length})
          </h2>
          <p className="text-gray-500 text-xs mt-1">
            {description ?? 'Store site, hosting, and service logins. Passwords stay locked until the user confirms their GoJolo password.'}
          </p>
        </div>
        <button
          type="button"
          onClick={startNew}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" /> Add credential
        </button>
      </div>

      {error && <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}

      {showForm && (
        <form onSubmit={saveCredential} className="mb-4 rounded-lg border border-border bg-surface-muted/40 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-white">{editing ? 'Edit credential' : 'New credential'}</h3>
            <button type="button" onClick={resetForm} className="p-1 rounded text-gray-400 hover:text-white hover:bg-surface-muted" aria-label="Close credential form">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">Label</label>
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} required placeholder="Website admin" className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">Type</label>
              <input value={form.credentialType} onChange={e => setForm(f => ({ ...f, credentialType: e.target.value }))} placeholder="login" className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">Username</label>
              <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="admin@example.com" className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">Password {editing && <span className="text-gray-600">(leave blank to keep current)</span>}</label>
              <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required={!editing} placeholder={editing ? 'Unchanged' : 'Password'} className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[10px] text-gray-500 mb-1">URL / Login page</label>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://example.com/wp-admin" className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[10px] text-gray-500 mb-1">Notes</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Server, path, port, or short description" rows={2} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            {canChooseScope && (
              <div className="sm:col-span-2 flex items-center gap-4 text-sm text-gray-300">
                <label className="inline-flex items-center gap-2"><input type="radio" checked={form.scope === 'project'} onChange={() => setForm(f => ({ ...f, scope: 'project' }))} /> This project only</label>
                <label className="inline-flex items-center gap-2"><input type="radio" checked={form.scope === 'company'} onChange={() => setForm(f => ({ ...f, scope: 'company' }))} /> Linked company</label>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={saving} className="px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
              {saving ? 'Saving…' : editing ? 'Update credential' : 'Save credential'}
            </button>
            <button type="button" onClick={resetForm} className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-surface-muted">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">Loading credentials…</p>
      ) : credentials.length === 0 ? (
        <p className="text-gray-400 text-sm">No credentials saved yet.</p>
      ) : (
        <div className="space-y-2">
          {credentials.map((credential) => {
            const password = revealed[credential.id]
            return (
              <div key={credential.id} className="rounded-lg border border-border bg-surface-muted/30 p-3">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-white truncate">{credential.label}</h3>
                      <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-border rounded px-1.5 py-0.5">{credential.credential_type || 'login'}</span>
                      {credential.project_id && <span className="text-[10px] text-accent border border-accent/30 rounded px-1.5 py-0.5">Project</span>}
                      {!credential.project_id && credential.company_id && <span className="text-[10px] text-gray-400 border border-border rounded px-1.5 py-0.5">Company</span>}
                    </div>
                    {credential.url && <a href={credential.url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline break-all">{credential.url}</a>}
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                      <div className="rounded bg-black/10 border border-border px-2 py-1.5">
                        <span className="text-gray-500 block">Username</span>
                        <div className="flex items-center justify-between gap-2 text-gray-200">
                          <span className="truncate">{credential.username || '—'}</span>
                          {credential.username && <button type="button" onClick={() => copyValue(credential.username!)} className="text-gray-500 hover:text-white" aria-label="Copy username"><Copy className="w-3.5 h-3.5" /></button>}
                        </div>
                      </div>
                      <div className="rounded bg-black/10 border border-border px-2 py-1.5">
                        <span className="text-gray-500 block">Password</span>
                        <div className="flex items-center justify-between gap-2 text-gray-200">
                          <span className="font-mono truncate">{password ? password : '••••••••••••'}</span>
                          <div className="flex items-center gap-1">
                            {password ? (
                              <button type="button" onClick={() => setRevealed(prev => ({ ...prev, [credential.id]: '' }))} className="text-gray-500 hover:text-white" aria-label="Hide password"><EyeOff className="w-3.5 h-3.5" /></button>
                            ) : (
                              <button type="button" onClick={() => openUnlock(credential)} className="text-gray-500 hover:text-white" aria-label="Reveal password"><Eye className="w-3.5 h-3.5" /></button>
                            )}
                            <button type="button" onClick={() => password ? copyValue(password) : openUnlock(credential, true)} className="text-gray-500 hover:text-white" aria-label="Copy password"><Copy className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      </div>
                    </div>
                    {credential.notes && <p className="text-xs text-gray-400 mt-2 whitespace-pre-wrap">{credential.notes}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button type="button" onClick={() => startEdit(credential)} className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-surface-muted" aria-label="Edit credential"><Pencil className="w-4 h-4" /></button>
                    <button type="button" onClick={() => deleteCredential(credential)} className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10" aria-label="Delete credential"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {unlockCredential && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70" role="dialog" aria-modal="true">
          <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center text-accent"><Lock className="w-5 h-5" /></div>
              <div>
                <h2 className="text-lg font-semibold text-white">Unlock credential</h2>
                <p className="text-sm text-gray-400">Confirm your GoJolo password to reveal “{unlockCredential.label}”.</p>
              </div>
            </div>
            {unlockError && <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{unlockError}</div>}
            {needsOAuthUnlock ? (
              <p className="text-sm text-gray-400">Your account uses {authProvider} sign-in, so there is no GoJolo password to enter. Sign out and back in with {authProvider}, then try reveal again.</p>
            ) : (
              <input type="password" value={unlockPassword} onChange={e => setUnlockPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void revealWithFreshSession() }} autoFocus placeholder="GoJolo password" className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setUnlockCredential(null)} disabled={unlocking} className="px-4 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm">Cancel</button>
              {!needsOAuthUnlock && (
                <button type="button" onClick={revealWithFreshSession} disabled={unlocking || !unlockPassword} className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
                  {unlocking ? 'Unlocking…' : copyAfterUnlock ? 'Unlock & copy' : 'Unlock'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
