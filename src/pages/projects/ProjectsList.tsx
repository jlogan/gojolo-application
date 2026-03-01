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
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-accent/20 text-accent',
  completed: 'bg-green-500/20 text-green-400',
  on_hold: 'bg-yellow-500/20 text-yellow-400',
  cancelled: 'bg-red-500/20 text-red-400',
}

export default function ProjectsList() {
  const { currentOrg, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'mine'>('all')

  useEffect(() => {
    if (!currentOrg?.id || !user?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      if (filter === 'mine' && !isOrgAdmin) {
        const { data: memberRows } = await supabase
          .from('project_members')
          .select('project_id')
          .eq('user_id', user.id)
        const ids = (memberRows ?? []).map((r: { project_id: string }) => r.project_id)
        if (ids.length === 0) {
          if (!cancelled) { setProjects([]); setLoading(false) }
          return
        }
        const { data, error } = await supabase
          .from('projects')
          .select('*')
          .eq('org_id', currentOrg.id)
          .in('id', ids)
          .order('updated_at', { ascending: false })
        if (!cancelled) {
          setProjects(error ? [] : (data as Project[]) ?? [])
          setLoading(false)
        }
      } else {
        const { data, error } = await supabase
          .from('projects')
          .select('*')
          .eq('org_id', currentOrg.id)
          .order('updated_at', { ascending: false })
        if (!cancelled) {
          setProjects(error ? [] : (data as Project[]) ?? [])
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentOrg?.id, user?.id, filter, isOrgAdmin])

  return (
    <div className="p-4 md:p-6" data-testid="projects-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Projects</h1>
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'all' ? 'bg-surface-muted text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setFilter('mine')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'mine' ? 'bg-surface-muted text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              My projects
            </button>
          </div>
        </div>
        <Link
          to="/projects/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
          data-testid="project-create"
        >
          <Plus className="w-4 h-4" />
          New project
        </Link>
      </div>

      {loading ? (
        <div className="text-surface-muted text-sm">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <FolderKanban className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No projects yet</p>
          <p className="text-sm mt-1">Create a project to get started.</p>
          <Link to="/projects/new" className="inline-block mt-4 text-accent hover:underline">
            New project
          </Link>
        </div>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden" data-testid="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="flex items-center gap-3 p-4 hover:bg-surface-muted transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-surface-muted flex items-center justify-center shrink-0 hidden sm:flex">
                  <FolderKanban className="w-5 h-5 text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-white truncate">{p.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${STATUS_COLORS[p.status] ?? 'text-gray-400'}`}>
                      {p.status.replace('_', ' ')}
                    </span>
                  </div>
                  {p.description && (
                    <p className="text-sm text-gray-400 truncate mt-0.5">{p.description}</p>
                  )}
                  {p.due_date && (
                    <p className="text-xs text-gray-500 mt-1 sm:hidden">{p.due_date}</p>
                  )}
                </div>
                {p.due_date && (
                  <span className="text-xs text-gray-500 shrink-0 hidden sm:block">{p.due_date}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
