import { useEffect, useState, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Clock, Send, Plus, User } from 'lucide-react'

type Task = {
  id: string; project_id: string; title: string; description: string | null
  status: string; priority: string; due_date: string | null
  assigned_to: string | null; created_at: string
}
type TaskComment = { id: string; user_id: string; content: string; created_at: string; display_name?: string | null; avatar_url?: string | null }
type TimeLog = { id: string; user_id: string; hours: number; minutes: number; work_date: string; description: string | null; display_name?: string | null }
type OrgUser = { user_id: string; display_name: string | null; avatar_url: string | null }

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open', color: 'bg-gray-500/20 text-gray-300' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-accent/20 text-accent' },
  { value: 'needs_work', label: 'Needs Work', color: 'bg-orange-500/20 text-orange-400' },
  { value: 'testing', label: 'To Be Tested', color: 'bg-purple-500/20 text-purple-400' },
  { value: 'closed', label: 'Closed', color: 'bg-green-500/20 text-green-400' },
]

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-gray-400', medium: 'text-yellow-400', high: 'text-orange-400', urgent: 'text-red-400',
}

export default function TaskDetail() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>()
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [task, setTask] = useState<Task | null>(null)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [timeLogs, setTimeLogs] = useState<TimeLog[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [loading, setLoading] = useState(true)
  const [commentText, setCommentText] = useState('')
  const [projectName, setProjectName] = useState('')

  // Time log form
  const [logHours, setLogHours] = useState('')
  const [logMinutes, setLogMinutes] = useState('')
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0])
  const [logDesc, setLogDesc] = useState('')
  const [showTimeForm, setShowTimeForm] = useState(false)

  const fetchTask = useCallback(async () => {
    if (!taskId) return
    const { data } = await supabase.from('tasks').select('*').eq('id', taskId).single()
    setTask(data as Task | null)
    setLoading(false)
  }, [taskId])

  const fetchComments = useCallback(async () => {
    if (!taskId) return
    const { data } = await supabase.from('task_comments').select('id, user_id, content, created_at').eq('task_id', taskId).order('created_at', { ascending: true })
    const rows = (data ?? []) as TaskComment[]
    if (rows.length > 0) {
      const uids = [...new Set(rows.map(c => c.user_id))]
      const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', uids)
      const map = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => [p.id, p]))
      rows.forEach(c => { const p = map.get(c.user_id); c.display_name = p?.display_name ?? null; c.avatar_url = p?.avatar_url ?? null })
    }
    setComments(rows)
  }, [taskId])

  const fetchTimeLogs = useCallback(async () => {
    if (!taskId) return
    const { data } = await supabase.from('time_logs').select('id, user_id, hours, minutes, work_date, description').eq('task_id', taskId).order('work_date', { ascending: false })
    const rows = (data ?? []) as TimeLog[]
    if (rows.length > 0) {
      const uids = [...new Set(rows.map(t => t.user_id))]
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', uids)
      const map = new Map((profiles ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]))
      rows.forEach(t => { t.display_name = map.get(t.user_id) ?? null })
    }
    setTimeLogs(rows)
  }, [taskId])

  useEffect(() => { fetchTask() }, [fetchTask])
  useEffect(() => { fetchComments() }, [fetchComments])
  useEffect(() => { fetchTimeLogs() }, [fetchTimeLogs])

  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.from('organization_users').select('user_id').eq('org_id', currentOrg.id)
      .then(async ({ data }) => {
        const uids = (data ?? []).map((r: { user_id: string }) => r.user_id)
        if (uids.length === 0) return
        const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', uids)
        setOrgUsers((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => ({ user_id: p.id, display_name: p.display_name, avatar_url: p.avatar_url })))
      })
  }, [currentOrg?.id])

  useEffect(() => {
    if (!projectId) return
    supabase.from('projects').select('name').eq('id', projectId).single().then(({ data }) => setProjectName((data as { name: string })?.name ?? ''))
  }, [projectId])

  const handleStatusChange = async (status: string) => {
    if (!taskId) return
    await supabase.from('tasks').update({ status, updated_at: new Date().toISOString() }).eq('id', taskId)
    fetchTask()
  }

  const handleAddComment = async () => {
    if (!taskId || !commentText.trim() || !user?.id) return
    await supabase.from('task_comments').insert({ task_id: taskId, user_id: user.id, content: commentText.trim() })
    setCommentText('')
    fetchComments()
  }

  const handleLogTime = async () => {
    if (!taskId || !projectId || !user?.id) return
    const h = parseFloat(logHours) || 0
    const m = parseInt(logMinutes) || 0
    if (h === 0 && m === 0) return
    await supabase.from('time_logs').insert({
      task_id: taskId, project_id: projectId, user_id: user.id,
      hours: h, minutes: m, work_date: logDate, description: logDesc.trim() || null,
    })
    setLogHours(''); setLogMinutes(''); setLogDesc(''); setShowTimeForm(false)
    fetchTimeLogs()
  }

  const totalMinutes = timeLogs.reduce((sum, t) => sum + (t.hours * 60) + t.minutes, 0)
  const totalHrs = Math.floor(totalMinutes / 60)
  const totalMins = totalMinutes % 60

  if (loading) return <div className="p-4 md:p-6 text-gray-400">Loading…</div>
  if (!task) return <div className="p-4 md:p-6"><p className="text-gray-400">Task not found.</p><Link to={`/projects/${projectId}`} className="text-accent hover:underline">Back to project</Link></div>

  const statusInfo = STATUS_OPTIONS.find(s => s.value === task.status) ?? STATUS_OPTIONS[0]

  return (
    <div className="p-4 md:p-6 max-w-3xl" data-testid="task-detail">
      <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-4">
        <ArrowLeft className="w-4 h-4" /> {projectName || 'Project'}
      </Link>

      {/* Task header */}
      <div className="rounded-lg border border-border bg-surface-elevated p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h1 className="text-xl font-semibold text-white">{task.title}</h1>
          <select value={task.status} onChange={e => handleStatusChange(e.target.value)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium border-0 focus:outline-none focus:ring-2 focus:ring-accent ${statusInfo.color}`}>
            {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        {task.description && <p className="text-sm text-gray-300 mb-4 whitespace-pre-wrap">{task.description}</p>}

        <div className="flex flex-wrap gap-4 text-xs text-gray-400">
          <span className={PRIORITY_COLORS[task.priority] ?? 'text-gray-400'}>Priority: {task.priority}</span>
          {task.due_date && <span>Due: {task.due_date}</span>}
          {task.assigned_to && <span>Assigned: {orgUsers.find(u => u.user_id === task.assigned_to)?.display_name ?? task.assigned_to.slice(0, 8)}</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Comments thread (2/3) */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Comments ({comments.length})</h2>
          <div className="space-y-3 mb-4">
            {comments.length === 0 ? (
              <p className="text-gray-500 text-sm">No comments yet. Start the conversation.</p>
            ) : comments.map(c => (
              <div key={c.id} className="flex gap-3">
                {c.avatar_url ? (
                  <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full shrink-0 mt-0.5" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center shrink-0 mt-0.5">
                    <User className="w-4 h-4 text-gray-500" />
                  </div>
                )}
                <div className="flex-1 rounded-lg border border-border bg-surface-muted/50 px-4 py-2.5">
                  <div className="flex items-baseline gap-2 text-[11px] mb-1">
                    <span className="text-white font-medium">{c.display_name ?? 'User'}</span>
                    <span className="text-gray-500">{new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <p className="text-sm text-gray-200 whitespace-pre-wrap">{c.content}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Comment input */}
          <div className="flex gap-2">
            <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && commentText.trim()) handleAddComment() }}
              placeholder="Add a comment…"
              className="flex-1 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
            <button type="button" onClick={handleAddComment} disabled={!commentText.trim()}
              className="px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Time logs (1/3) */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-1.5"><Clock className="w-4 h-4" /> Time ({totalHrs}h {totalMins}m)</h2>
            <button type="button" onClick={() => setShowTimeForm(!showTimeForm)}
              className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> Log time</button>
          </div>

          {showTimeForm && (
            <div className="rounded-lg border border-border bg-surface-elevated p-3 mb-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Hours</label>
                  <input type="number" min="0" value={logHours} onChange={e => setLogHours(e.target.value)} placeholder="0"
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Minutes</label>
                  <input type="number" min="0" max="59" value={logMinutes} onChange={e => setLogMinutes(e.target.value)} placeholder="0"
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Date</label>
                <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)}
                  className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <input type="text" value={logDesc} onChange={e => setLogDesc(e.target.value)} placeholder="What did you work on?"
                className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              <div className="flex gap-2">
                <button type="button" onClick={handleLogTime} className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:opacity-90">Save</button>
                <button type="button" onClick={() => setShowTimeForm(false)} className="px-3 py-1.5 rounded border border-border text-xs text-gray-300 hover:bg-surface-muted">Cancel</button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border bg-surface-elevated overflow-hidden">
            {timeLogs.length === 0 ? (
              <p className="p-3 text-gray-500 text-xs">No time logged yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border text-gray-500">
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Time</th>
                  <th className="text-left px-3 py-2">Who</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {timeLogs.map(t => (
                    <tr key={t.id} className="hover:bg-surface-muted/30">
                      <td className="px-3 py-2 text-gray-300">{t.work_date}</td>
                      <td className="px-3 py-2 text-white">{t.hours}h {t.minutes}m</td>
                      <td className="px-3 py-2 text-gray-400">{t.display_name ?? 'User'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
