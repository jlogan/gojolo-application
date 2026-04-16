import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ChevronDown, ChevronUp, Plus, X, FileText } from 'lucide-react'

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
type UserOption = { id: string; display_name: string }

export default function Timesheets() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [entries, setEntries] = useState<TimeLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'date' | 'project' | 'user'>('date')
  const [sortDesc, setSortDesc] = useState(true)
  const [billedFilter, setBilledFilter] = useState<'all' | 'billed' | 'unbilled'>('all')
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // Filters
  const [filterProjectId, setFilterProjectId] = useState('')
  const [filterUserId, setFilterUserId] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [allUsers, setAllUsers] = useState<UserOption[]>([])

  // Selection + invoice
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creatingInvoice, setCreatingInvoice] = useState(false)

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

    // Build unique users list for filter
    const seen = new Set<string>()
    const users: UserOption[] = []
    mapped.forEach((e) => {
      if (!seen.has(e.user_id)) {
        seen.add(e.user_id)
        users.push({ id: e.user_id, display_name: e.display_name ?? e.user_id })
      }
    })
    setAllUsers(users)

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
    const action = entry.billed ? 'mark as unbilled' : 'mark as billed'
    const confirmed = window.confirm(
      `${entry.billed ? 'Unbill' : 'Bill'} this time log?\n\n` +
      `${entry.project_name ?? 'Unknown project'} / ${entry.task_title ?? 'Unknown task'}\n` +
      `${entry.work_date} · ${entry.hours}h ${entry.minutes}m · ${entry.display_name ?? 'Unknown'}\n\n` +
      `Are you sure you want to ${action}?`
    )
    if (!confirmed) return
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

  /* ---------- Selection ---------- */
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === sorted.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(sorted.map((t) => t.id)))
    }
  }

  /* ---------- Create invoice from selection ---------- */
  const handleCreateInvoice = async () => {
    if (selected.size === 0 || !currentOrg?.id || !user?.id) return
    setCreatingInvoice(true)

    const selectedLogs = entries.filter((e) => selected.has(e.id))

    // Group by task to build line items
    const taskMap = new Map<string, { task_id: string; task_title: string; logs: TimeLogRow[]; totalHours: number; rate: number }>()
    selectedLogs.forEach((log) => {
      let g = taskMap.get(log.task_id)
      if (!g) {
        g = { task_id: log.task_id, task_title: log.task_title ?? 'Untitled Task', logs: [], totalHours: 0, rate: 0 }
        taskMap.set(log.task_id, g)
      }
      g.logs.push(log)
      g.totalHours += log.hours + log.minutes / 60
      if (log.hourly_rate != null && log.hourly_rate > 0) g.rate = log.hourly_rate
    })

    const lineItems = Array.from(taskMap.values()).map((g) => ({
      description: g.task_title,
      long_description: g.logs.map((l) => `${l.work_date}: ${l.hours}h ${l.minutes}m${l.description ? ' — ' + l.description : ''}`).join('\n'),
      quantity: Math.round(g.totalHours * 100) / 100,
      unit_price: g.rate,
      unit: 'hours',
      sort_order: 0,
      time_log_ids: g.logs.map((l) => l.id),
    }))

    const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unit_price, 0)

    // Create the invoice
    const { data: inv, error } = await supabase.from('invoices').insert({
      org_id: currentOrg.id,
      direction: 'outbound',
      prefix: 'INV-',
      status: 'draft',
      issue_date: new Date().toISOString().split('T')[0],
      subtotal,
      tax_total: 0,
      discount_type: 'percent',
      discount_value: 0,
      discount_total: 0,
      adjustment: 0,
      total: subtotal,
      amount_due: subtotal,
      created_by: user.id,
    }).select('id').single()

    if (error || !inv) {
      setCreatingInvoice(false)
      return
    }

    // Insert line items
    if (lineItems.length > 0) {
      await supabase.from('invoice_items').insert(
        lineItems.map((item, i) => ({
          invoice_id: inv.id,
          ...item,
          tax_rate_id: null,
          tax_amount: 0,
          subtotal: item.quantity * item.unit_price,
          total: item.quantity * item.unit_price,
          sort_order: i,
        }))
      )
    }

    // Mark selected logs as billed
    await supabase.from('time_logs').update({ billed: true }).in('id', Array.from(selected))

    setCreatingInvoice(false)
    navigate(`/invoices/${inv.id}/edit`)
  }

  /* ---------- Filtering + sorting ---------- */
  const allProjectOptions = useMemo(() => {
    const seen = new Set<string>()
    const opts: ProjectOption[] = []
    entries.forEach((e) => {
      if (e.project_id && !seen.has(e.project_id)) {
        seen.add(e.project_id)
        opts.push({ id: e.project_id, name: e.project_name ?? e.project_id })
      }
    })
    return opts.sort((a, b) => a.name.localeCompare(b.name))
  }, [entries])

  const sorted = useMemo(() => {
    const list = entries.filter((t) => {
      if (billedFilter === 'billed' && !t.billed) return false
      if (billedFilter === 'unbilled' && t.billed) return false
      if (filterProjectId && t.project_id !== filterProjectId) return false
      if (filterUserId && t.user_id !== filterUserId) return false
      if (filterDateFrom && t.work_date < filterDateFrom) return false
      if (filterDateTo && t.work_date > filterDateTo) return false
      return true
    })
    const mult = sortDesc ? -1 : 1
    list.sort((a, b) => {
      if (sortBy === 'date') return mult * (new Date(b.work_date).getTime() - new Date(a.work_date).getTime())
      if (sortBy === 'project') return mult * ((a.project_name ?? '').localeCompare(b.project_name ?? ''))
      return mult * ((a.display_name ?? '').localeCompare(b.display_name ?? ''))
    })
    return list
  }, [entries, sortBy, sortDesc, billedFilter, filterProjectId, filterUserId, filterDateFrom, filterDateTo])

  const totalMinutes = entries.reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const billedMinutes = entries.filter((t) => t.billed === true).reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const unbilledMinutes = entries.filter((t) => t.billed === false).reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0)
  const hasRates = entries.some(t => t.hourly_rate != null)
  const selectedLogs = entries.filter((e) => selected.has(e.id))
  const selectedMinutes = selectedLogs.reduce((s, t) => s + t.hours * 60 + t.minutes, 0)

  const toggleSort = (key: 'date' | 'project' | 'user') => {
    if (sortBy === key) setSortDesc((d) => !d)
    else setSortBy(key)
  }

  const hasFilters = filterProjectId || filterUserId || filterDateFrom || filterDateTo

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

      {/* ── Filter bar ── */}
      <div className="rounded-lg border border-border bg-surface-muted/30 p-3 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Project */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Project</label>
          <select value={filterProjectId} onChange={e => setFilterProjectId(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="">All projects</option>
            {allProjectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {/* Developer / Designer */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Developer / Designer</label>
          <select value={filterUserId} onChange={e => setFilterUserId(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="">All people</option>
            {allUsers.map(u => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
        </div>

        {/* Date from */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>

        {/* Date to */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <div className="flex gap-2">
            <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
              className="flex-1 rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent" />
            {hasFilters && (
              <button type="button" onClick={() => { setFilterProjectId(''); setFilterUserId(''); setFilterDateFrom(''); setFilterDateTo('') }}
                className="px-2 rounded-lg border border-border text-gray-400 hover:text-white hover:bg-surface-muted text-xs">
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stats + billed filter row */}
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
        <div className="flex rounded-lg border border-border overflow-hidden text-xs">
          {(['all', 'unbilled', 'billed'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setBilledFilter(f)}
              className={`px-3 py-1.5 transition-colors ${billedFilter === f ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface-muted'}`}>
              {f === 'all' ? 'All' : f === 'billed' ? '✓ Billed' : '○ Unbilled'}
            </button>
          ))}
        </div>
      </div>

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 rounded-lg border border-accent/30 bg-accent/10">
          <span className="text-sm text-accent font-medium">
            {selected.size} {selected.size === 1 ? 'entry' : 'entries'} selected
            {selectedMinutes > 0 && <span className="text-gray-400 font-normal ml-2">· {Math.floor(selectedMinutes / 60)}h {selectedMinutes % 60}m</span>}
          </span>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={() => setSelected(new Set())}
              className="px-3 py-1 rounded-lg border border-border text-xs text-gray-400 hover:text-white hover:bg-surface-muted">
              Clear
            </button>
            <button type="button" onClick={handleCreateInvoice} disabled={creatingInvoice}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-50">
              <FileText className="w-3.5 h-3.5" />
              {creatingInvoice ? 'Creating…' : 'Create Invoice'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-gray-500 text-sm">
          {billedFilter !== 'all' || hasFilters
            ? 'No time entries match your filters.'
            : 'No time entries yet. Use the "Log Time" button above or log time from a task.'}
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-gray-500 bg-surface-muted/50">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox"
                    checked={sorted.length > 0 && selected.size === sorted.length}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < sorted.length }}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-600 bg-surface-muted text-accent focus:ring-accent" />
                </th>
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
                <tr key={t.id} className={`hover:bg-surface-muted/30 ${selected.has(t.id) ? 'bg-accent/5' : ''}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)}
                      className="rounded border-gray-600 bg-surface-muted text-accent focus:ring-accent" />
                  </td>
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
                    <button type="button" onClick={() => toggleBilled(t)} disabled={togglingId === t.id}
                      title={t.billed ? 'Mark as unbilled' : 'Mark as billed'}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors disabled:opacity-50 ${
                        t.billed
                          ? 'bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400'
                          : 'bg-gray-500/20 text-gray-500 hover:bg-green-500/20 hover:text-green-400'
                      }`}>
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
