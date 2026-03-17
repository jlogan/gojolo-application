import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { ChevronDown, ChevronUp } from 'lucide-react'

type TimeLogRow = {
  id: string
  task_id: string
  project_id: string
  user_id: string
  hours: number
  minutes: number
  work_date: string
  description: string | null
  billed: boolean
  created_at: string
  project_name?: string | null
  task_title?: string | null
  display_name?: string | null
}

export default function Timesheets() {
  const { currentOrg } = useOrg()
  const [entries, setEntries] = useState<TimeLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'date' | 'project' | 'user'>('date')
  const [sortDesc, setSortDesc] = useState(true)

  useEffect(() => {
    if (!currentOrg?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      const { data: projects } = await supabase.from('projects').select('id').eq('org_id', currentOrg.id)
      const projectIds = (projects ?? []).map((p: { id: string }) => p.id)
      if (projectIds.length === 0) {
        if (!cancelled) setEntries([])
        setLoading(false)
        return
      }

      const { data: rows, error } = await supabase
        .from('time_logs')
        .select('id, task_id, project_id, user_id, hours, minutes, work_date, description, billed, created_at, projects(name), tasks(title)')
        .in('project_id', projectIds)
        .order('work_date', { ascending: false })

      if (cancelled) return
      if (error) {
        setEntries([])
        setLoading(false)
        return
      }

      const rawRows = (rows ?? []) as unknown[]
      const userIds = [...new Set((rawRows as { user_id: string }[]).map((r) => r.user_id))]
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', userIds)
      const profileMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]))

      const mapped: TimeLogRow[] = rawRows.map((r) => {
        const row = r as TimeLogRow & { projects?: { name?: string } | null; tasks?: { title?: string } | null }
        const proj = row.projects
        const tsk = row.tasks
        const projectName = proj && typeof proj === 'object' && 'name' in proj ? (proj.name ?? null) : null
        const taskTitle = tsk && typeof tsk === 'object' && 'title' in tsk ? (tsk.title ?? null) : null
        return {
          ...row,
          project_name: projectName,
          task_title: taskTitle,
          display_name: profileMap.get(row.user_id) ?? null,
        }
      })

      setEntries(mapped)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [currentOrg?.id])

  const sorted = useMemo(() => {
    const list = [...entries]
    const mult = sortDesc ? -1 : 1
    list.sort((a, b) => {
      if (sortBy === 'date') return mult * (new Date(b.work_date).getTime() - new Date(a.work_date).getTime())
      if (sortBy === 'project') return mult * ((a.project_name ?? '').localeCompare(b.project_name ?? ''))
      return mult * ((a.display_name ?? '').localeCompare(b.display_name ?? ''))
    })
    return list
  }, [entries, sortBy, sortDesc])

  const totalMinutes = entries.reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const billableMinutes = entries.filter((t) => t.billed !== false).reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)

  const toggleSort = (key: 'date' | 'project' | 'user') => {
    if (sortBy === key) setSortDesc((d) => !d)
    else setSortBy(key)
  }

  return (
    <div className="p-4 md:p-6" data-testid="timesheets-page">
      <h1 className="text-xl font-semibold text-white mb-4">Timesheets</h1>

      <div className="flex flex-wrap items-center gap-4 mb-4 text-sm">
        <span className="text-gray-300">
          Total: <strong className="text-white">{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m</strong>
        </span>
        <span className="text-gray-400">
          Billable: <strong className="text-accent">{Math.floor(billableMinutes / 60)}h {billableMinutes % 60}m</strong>
        </span>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-gray-500 text-sm">No time entries yet. Log time from a task’s Time tab.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-gray-500 bg-surface-muted/50">
                <th className="text-left px-4 py-2">
                  <button type="button" onClick={() => toggleSort('date')} className="flex items-center gap-1 hover:text-white">
                    Date {sortBy === 'date' && (sortDesc ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
                  </button>
                </th>
                <th className="text-left px-4 py-2">
                  <button type="button" onClick={() => toggleSort('project')} className="flex items-center gap-1 hover:text-white">
                    Project / Task {sortBy === 'project' && (sortDesc ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
                  </button>
                </th>
                <th className="text-left px-4 py-2">
                  <button type="button" onClick={() => toggleSort('user')} className="flex items-center gap-1 hover:text-white">
                    Who {sortBy === 'user' && (sortDesc ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
                  </button>
                </th>
                <th className="text-left px-4 py-2">Time</th>
                <th className="text-left px-4 py-2">Notes</th>
                <th className="text-center px-4 py-2">Billable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((t) => (
                <tr key={t.id} className="hover:bg-surface-muted/30">
                  <td className="px-4 py-2 text-gray-300">{t.work_date}</td>
                  <td className="px-4 py-2">
                    <Link to={`/projects/${t.project_id}`} className="text-accent hover:underline">
                      {t.project_name ?? '—'}
                    </Link>
                    {t.task_id && (
                      <>
                        <span className="text-gray-600 mx-1">/</span>
                        <Link to={`/projects/${t.project_id}/tasks/${t.task_id}`} className="text-gray-300 hover:underline">
                          {t.task_title ?? 'Task'}
                        </Link>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-400">{t.display_name ?? 'User'}</td>
                  <td className="px-4 py-2 text-white font-medium">
                    {String(t.hours).padStart(2, '0')}:{String(t.minutes).padStart(2, '0')}
                  </td>
                  <td className="px-4 py-2 text-gray-400 max-w-[200px] truncate" title={t.description ?? undefined}>
                    {t.description ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-center">{t.billed !== false ? <span className="text-accent">✓</span> : <span className="text-gray-600">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
