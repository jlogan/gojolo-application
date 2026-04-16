import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'

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
  hourly_rate: number | null
  created_at: string
  project_name?: string | null
  task_title?: string | null
  display_name?: string | null
}

type ProjectOption = { id: string; name: string }
type TaskOption = { id: string; title: string }

export default function Timesheets() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [entries, setEntries] = useState<TimeLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'date' | 'project' | 'user'>('date')
  const [sortDesc, setSortDesc] = useState(true)
  const [billedFilter, setBilledFilter] = useState<'all' | 'billed' | 'unbilled'>('all')
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // Log time modal
  const [showLogForm, setShowLogForm] = useState(false)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [tasks, setTasks] = useState<TaskOption[]>([])
  const [formProjectId, setFormProjectId] = useState('')
  const [formTaskId, setFormTaskId] = useState('')
  const [formHours, setFormHours] = useState('')
  const [formMinutes, setFormMinutes] = useState('')
  const [formDate, setFormDate] = useState(new Date().toISOString().split('T')[0])
  const [formDescription, setFormDescription] = useState('')
  const [formHourlyRate, setFormHourlyRate] = useState('')
  const [formSubmitting, setFormSubmitting] = useState(false)

  const loadEntries = useCallback(async () => {
    if (!currentOrg?.id) return
    setLoading(true)

    const { data: projectRows } = await supabase.from('projects').select('id').eq('org_id', currentOrg.id)
    const projectIds = (projectRows ?? []).map((p: { id: string }) => p.id)
    if (projectIds.length === 0) {
      setEntries([])
      setLoading(false)
      return
    }

    const { data: rows, error } = await supabase
      .from('time_logs')
      .select('id, task_id, project_id, user_id, hours, minutes, work_date, description, billed, hourly_rate, created_at, projects(name), tasks(title)')
      .in('project_id', projectIds)
      .order('work_date', { ascending: false })

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
  }, [currentOrg?.id])

  useEffect(() => { loadEntries() }, [loadEntries])

  // Load projects for form
  useEffect(() => {
    if (!currentOrg?.id || !showLogForm) return
    supabase.from('projects').select('id, name').eq('org_id', currentOrg.id).order('name')
      .then(({ data }) => setProjects((data ?? []) as ProjectOption[]))
  }, [currentOrg?.id, showLogForm])

  // Load tasks when project selected
  useEffect(() => {
    if (!formProjectId) { setTasks([]); return }
    supabase.from('tasks').select('id, title').eq('project_id', formProjectId).order('title')
      .then(({ data }) => setTasks((data ?? []) as TaskOption[]))
  }, [formProjectId])

  const handleLogTime = async () => {
    if (!formProjectId || !formTaskId || !user?.id) return
    const h = parseInt(formHours) || 0
    const m = parseInt(formMinutes) || 0
    if (h === 0 && m === 0) return
    setFormSubmitting(true)
    await supabase.from('time_logs').insert({
      task_id: formTaskId,
      project_id: formProjectId,
      user_id: user.id,
      hours: h,
      minutes: m,
      work_date: formDate,
      description: formDescription.trim() || null,
      hourly_rate: formHourlyRate ? parseFloat(formHourlyRate) : null,
      billed: false,
    })
    setFormSubmitting(false)
    setShowLogForm(false)
    setFormProjectId(''); setFormTaskId(''); setFormHours(''); setFormMinutes('')
    setFormDate(new Date().toISOString().split('T')[0]); setFormDescription(''); setFormHourlyRate('')
    loadEntries()
  }

  /* ---------- Toggle billed status ---------- */
  const toggleBilled = async (entry: TimeLogRow) => {
    if (togglingId === entry.id) return
    setTogglingId(entry.id)
    const newBilled = !entry.billed
    const { error } = await supabase
      .from('time_logs')
      .update({ billed: newBilled })
      .eq('id', entry.id)
    if (!error) {
      setEntries((prev) => prev.map((e) => e.id === entry.id ? { ...e, billed: newBilled } : e))
    }
    setTogglingId(null)
  }

  const sorted = useMemo(() => {
    const list = [...entries].filter((t) => {
      if (billedFilter === 'billed') return t.billed === true
      if (billedFilter === 'unbilled') return t.billed === false
      return true
    })
    const mult = sortDesc ? -1 : 1
    list.sort((a, b) => {
      if (sortBy === 'date') return mult * (new Date(b.work_date).getTime() - new Date(a.work_date).getTime())
      if (sortBy === 'project') return mult * ((a.project_name ?? '').localeCompare(b.project_name ?? ''))
      return mult * ((a.display_name ?? '').localeCompare(b.display_name ?? ''))
    })
    return list
  }, [entries, sortBy, sortDesc, billedFilter])

  const totalMinutes = entries.reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const billedMinutes = entries.filter((t) => t.billed === true).reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const unbilledMinutes = entries.filter((t) => t.billed === false).reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const hasRates = entries.some(t => t.hourly_rate != null)

  const toggleSort = (key: 'date' | 'project' | 'user') => {
    if (sortBy === key) setSortDesc((d) => !d)
    else setSortBy(key)
  }

  return (
    <div className="p-4 md:p-6" data-testid="timesheets-page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Timesheets</h1>
        <button type="button" onClick={() => setShowLogForm(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90">
          <Plus className="w-4 h-4" /> Log Time
        </button>
      </div>

      {/* Log Time Modal */}
      {showLogForm && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowLogForm(false)}>
          <div className="w-full max-w-lg rounded-lg border border-border bg-surface-elevated p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Log Time</h2>
              <button type="button" onClick={() => setShowLogForm(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Project</label>
                <select value={formProjectId} onChange={e => { setFormProjectId(e.target.value); setFormTaskId('') }}
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">Select project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Task</label>
                <select value={formTaskId} onChange={e => setFormTaskId(e.target.value)} disabled={!formProjectId}
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
                  <option value="">{formProjectId ? 'Select task…' : 'Select a project first'}</option>
                  {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Hours</label>
                  <input type="number" min="0" value={formHours} onChange={e => setFormHours(e.target.value)} placeholder="0"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Minutes</label>
                  <input type="number" min="0" max="59" value={formMinutes} onChange={e => setFormMinutes(e.target.value)} placeholder="0"
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Description</label>
                <input type="text" value={formDescription} onChange={e => setFormDescription(e.target.value)} placeholder="What did you work on?"
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Hourly Rate (optional)</label>
                <input type="number" step="0.01" min="0" value={formHourlyRate} onChange={e => setFormHourlyRate(e.target.value)} placeholder="0.00"
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowLogForm(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
              <button type="button" onClick={handleLogTime}
                disabled={!formProjectId || !formTaskId || formSubmitting || ((parseInt(formHours) || 0) === 0 && (parseInt(formMinutes) || 0) === 0)}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {formSubmitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats + filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-4 text-sm flex-1">
          <span className="text-gray-300">
            Total: <strong className="text-white">{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m</strong>
          </span>
          <span className="text-gray-400">
            Billed: <strong className="text-green-400">{Math.floor(billedMinutes / 60)}h {billedMinutes % 60}m</strong>
          </span>
          <span className="text-gray-400">
            Unbilled: <strong className="text-yellow-400">{Math.floor(unbilledMinutes / 60)}h {unbilledMinutes % 60}m</strong>
          </span>
        </div>

        {/* Billed status filter */}
        <div className="flex rounded-lg border border-border overflow-hidden text-xs">
          {(['all', 'unbilled', 'billed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setBilledFilter(f)}
              className={`px-3 py-1.5 capitalize transition-colors ${
                billedFilter === f
                  ? 'bg-accent text-white'
                  : 'text-gray-400 hover:text-white hover:bg-surface-muted'
              }`}
            >
              {f === 'all' ? 'All' : f === 'billed' ? '✓ Billed' : '○ Unbilled'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-gray-500 text-sm">
          {billedFilter !== 'all'
            ? `No ${billedFilter} time entries.`
            : 'No time entries yet. Use the "Log Time" button above or log time from a task.'}
        </p>
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
                {hasRates && <th className="text-right px-4 py-2">Rate</th>}
                <th className="text-center px-4 py-2">Billed</th>
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
                  {hasRates && (
                    <td className="px-4 py-2 text-right text-gray-400">
                      {t.hourly_rate != null ? `$${Number(t.hourly_rate).toFixed(2)}/hr` : '—'}
                    </td>
                  )}
                  <td className="px-4 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => toggleBilled(t)}
                      disabled={togglingId === t.id}
                      title={t.billed ? 'Mark as unbilled' : 'Mark as billed'}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors disabled:opacity-50 ${
                        t.billed
                          ? 'bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400'
                          : 'bg-gray-500/20 text-gray-500 hover:bg-green-500/20 hover:text-green-400'
                      }`}
                    >
                      {togglingId === t.id ? '…' : t.billed ? '✓ Billed' : '○ Unbilled'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
