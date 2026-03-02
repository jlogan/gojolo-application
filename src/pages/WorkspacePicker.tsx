import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOrg, type Organization } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { LayoutGrid, Plus } from 'lucide-react'

export default function WorkspacePicker() {
  const { memberships, currentOrg, setCurrentOrg, isPlatformAdmin, allOrganizations, refetch } = useOrg()
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [wsName, setWsName] = useState('')
  const [creating, setCreating] = useState(false)

  const orgsToShow: Organization[] = isPlatformAdmin ? allOrganizations : memberships.map((m) => m.org)
  const sortedOrgs = [...orgsToShow].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  useEffect(() => {
    if (memberships.length === 1 && !isPlatformAdmin) {
      setCurrentOrg(memberships[0].org)
      navigate('/', { replace: true })
    }
  }, [memberships, isPlatformAdmin, setCurrentOrg, navigate])

  const handleSelect = (org: Organization) => { setCurrentOrg(org); navigate('/', { replace: true }) }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!wsName.trim()) return
    setCreating(true)
    const { data, error } = await supabase.rpc('create_workspace', { ws_name: wsName.trim() })
    setCreating(false)
    if (error) { console.error(error); return }
    if (data) {
      await refetch()
      const org = data as Organization
      setCurrentOrg(org)
      navigate('/', { replace: true })
    }
  }

  if (memberships.length === 1 && !isPlatformAdmin) return null

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-surface px-4 py-8" data-testid="workspace-picker-page">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-white mb-1">jolo</h1>
        <p className="text-gray-400 text-sm mb-6">
          {sortedOrgs.length > 0 ? 'Select a workspace to continue, or create a new one.' : 'Create your first workspace to get started.'}
        </p>

        {sortedOrgs.length > 0 && (
          <ul className="space-y-2 mb-4" role="list" data-testid="workspace-list">
            {sortedOrgs.map((org) => (
              <li key={org.id}>
                <button type="button" onClick={() => handleSelect(org)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                    currentOrg?.id === org.id ? 'bg-surface-elevated border-accent text-white' : 'bg-surface-muted border-border text-gray-200 hover:border-gray-500'
                  }`}>
                  <LayoutGrid className={`w-5 h-5 shrink-0 ${currentOrg?.id === org.id ? 'text-accent' : 'text-gray-500'}`} />
                  <span className="font-medium">{org.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!showCreate ? (
          <button type="button" onClick={() => setShowCreate(true)}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-dashed border-border text-gray-400 hover:border-accent/50 hover:text-accent transition-colors text-sm font-medium">
            <Plus className="w-4 h-4" /> Create workspace
          </button>
        ) : (
          <form onSubmit={handleCreate} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
            <h3 className="text-sm font-medium text-white">New workspace</h3>
            <input type="text" value={wsName} onChange={e => setWsName(e.target.value)} placeholder="Workspace name" required autoFocus
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
            <div className="flex gap-2">
              <button type="submit" disabled={creating || !wsName.trim()}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
