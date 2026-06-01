import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { Plus, FolderKanban } from 'lucide-react'

export type Project = {
  id: string
  org_id: string
  name: string
  description: string | null
  status: string
  due_date: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  billing_type: string | null
  project_cost: number | null
  hourly_rate: number | null
  estimated_hours: number | null
}


export default function ProjectsList() {
  const { currentOrg, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'active' | 'archived'>('active')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!currentOrg?.id || !user?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      let query = supabase.from('projects').select('*').eq('org_id', currentOrg.id).order('updated_at', { ascending: false })
      if (filter === 'active') query = query.in('status', ['not_started', 'in_progress', 'on_hold'])
      else query = query.in('status', ['finished', 'cancelled'])
      const { data, error } = await query
      if (!cancelled) {
        setProjects(error ? [] : (data as Project[]) ?? [])
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentOrg?.id, user?.id, filter, isOrgAdmin])

  return (
    <div className="p-4 md:p-6" data-testid="projects-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold text-white">Projects</h1>
        <Link
          to="/projects/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
          data-testid="project-create"
        >
          <Plus className="w-4 h-4" />
          Add project
        </Link>
      </div>
      <div className="flex gap-1 mb-4 border-b border-border">
        <button type="button" onClick={() => setFilter('active')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${filter === 'active' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
          Active
        </button>
        <button type="button" onClick={() => setFilter('archived')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${filter === 'archived' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
          Archive
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects…"
          className="w-full rounded-lg border border-border bg-surface-muted pl-4 pr-4 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>

      {loading ? (
        <div className="text-surface-muted text-sm">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <FolderKanban className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No projects yet</p>
          <p className="text-sm mt-1">Create a project to get started.</p>
          <Link to="/projects/new" className="inline-block mt-4 text-accent hover:underline">
            Add project
          </Link>
        </div>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden" data-testid="project-list">
          {projects.filter(p => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) || p.description?.toLowerCase().includes(search.toLowerCase())).map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="flex items-center gap-3 p-4 hover:bg-surface-muted transition-colors">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white truncate">{p.name}</p>
                  {p.description && <p className="text-sm text-gray-400 truncate mt-0.5">{p.description}</p>}
                </div>
                <StatusBadge status={p.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  not_started: { label: 'Not Started', classes: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
  in_progress: { label: 'In Progress', classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  on_hold: { label: 'On Hold', classes: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  finished: { label: 'Finished', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
  cancelled: { label: 'Cancelled', classes: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
}

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.not_started
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 ${config.classes}`}>
      {config.label}
    </span>
  )
}