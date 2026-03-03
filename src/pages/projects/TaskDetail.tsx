import { useEffect, useState, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft, Send, Plus, User, Link as LinkIcon,
  Paperclip, ExternalLink, Key, Mail, MessageSquare, ChevronRight,
} from 'lucide-react'

type Task = {
  id: string; project_id: string; title: string; description: string | null
  status: string; priority: string; due_date: string | null
  assigned_to: string | null; created_at: string; status_changed_at: string | null
}
type TaskComment = { id: string; user_id: string; content: string; created_at: string; display_name?: string | null; avatar_url?: string | null }
type TimeLog = { id: string; user_id: string; hours: number; minutes: number; work_date: string; description: string | null; comment: string | null; billed: boolean; display_name?: string | null }
type Artifact = { id: string; type: string; label: string | null; url: string | null; file_path: string | null; file_name: string | null; created_at: string }
type StatusEntry = { id: string; from_status: string | null; to_status: string; changed_by: string | null; comment: string | null; created_at: string; display_name?: string | null }
type LinkedThread = { thread_id: string; subject: string | null; last_message_at: string }
type SlackMsg = { id: string; user_name: string | null; content: string; received_at: string }
type VaultCred = { id: string; credential_id: string; label: string; url: string | null; username: string | null }
type OrgUser = { user_id: string; display_name: string | null; avatar_url: string | null }
type TaskAssignee = { user_id: string; display_name?: string | null; avatar_url?: string | null }

const STATUS_FLOW = [
  { value: 'open', label: 'Open', color: 'bg-gray-500/20 text-gray-300', step: 0 },
  { value: 'in_progress', label: 'In Progress', color: 'bg-blue-500/20 text-blue-400', step: 1 },
  { value: 'ready_for_testing', label: 'Ready For Testing', color: 'bg-purple-500/20 text-purple-400', step: 2 },
  { value: 'needs_work', label: 'Needs Work', color: 'bg-orange-500/20 text-orange-400', step: 3 },
  { value: 'client_review', label: 'Client Review', color: 'bg-yellow-500/20 text-yellow-400', step: 4 },
  { value: 'complete', label: 'Complete', color: 'bg-green-500/20 text-green-400', step: 5 },
]

const PRIORITY_COLORS: Record<string, string> = { low: 'text-gray-400', medium: 'text-yellow-400', high: 'text-orange-400', urgent: 'text-red-400' }

function isLoomUrl(url: string): boolean { return /loom\.com\/(share|embed)\//.test(url) }
function getLoomEmbedUrl(url: string): string {
  const match = url.match(/loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/)
  return match ? `https://www.loom.com/embed/${match[1]}` : url
}

export default function TaskDetail() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>()
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [task, setTask] = useState<Task | null>(null)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [timeLogs, setTimeLogs] = useState<TimeLog[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [statusHistory, setStatusHistory] = useState<StatusEntry[]>([])
  const [linkedThreads, setLinkedThreads] = useState<LinkedThread[]>([])
  const [slackMessages, setSlackMessages] = useState<SlackMsg[]>([])
  const [vaultCreds, setVaultCreds] = useState<VaultCred[]>([])
  const [assignees, setAssignees] = useState<TaskAssignee[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [loading, setLoading] = useState(true)
  const [projectName, setProjectName] = useState('')
  const [activeTab, setActiveTab] = useState<'comments' | 'time' | 'activity' | 'emails' | 'slack'>('comments')

  // Comment form
  const [commentText, setCommentText] = useState('')

  // Time log form
  const [showTimeForm, setShowTimeForm] = useState(false)
  const [logTime, setLogTime] = useState('')
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0])
  const [logDesc, setLogDesc] = useState('')
  const [logComment, setLogComment] = useState('')
  const [logBillable, setLogBillable] = useState(true)

  // Artifact form
  const [showArtifactForm, setShowArtifactForm] = useState(false)
  const [_artType] = useState<'link' | 'file'>('link')
  const [artLabel, setArtLabel] = useState('')
  const [artUrl, setArtUrl] = useState('')

  // Assignee add
  const [addAssigneeId, setAddAssigneeId] = useState('')

  const fetchAll = useCallback(async () => {
    if (!taskId || !projectId) return
    const [{ data: t }, { data: pn }] = await Promise.all([
      supabase.from('tasks').select('*').eq('id', taskId).single(),
      supabase.from('projects').select('name').eq('id', projectId).single(),
    ])
    setTask(t as Task | null)
    setProjectName((pn as { name: string })?.name ?? '')
    setLoading(false)

    // Parallel fetches
    const [cmtRes, tlRes, artRes, shRes, ttRes, smRes, taRes] = await Promise.all([
      supabase.from('task_comments').select('id, user_id, content, created_at').eq('task_id', taskId).order('created_at'),
      supabase.from('time_logs').select('id, user_id, hours, minutes, work_date, description, comment, billed').eq('task_id', taskId).order('work_date', { ascending: false }),
      supabase.from('task_artifacts').select('*').eq('task_id', taskId).order('created_at'),
      supabase.from('task_status_history').select('id, from_status, to_status, changed_by, comment, created_at').eq('task_id', taskId).order('created_at', { ascending: false }),
      supabase.from('task_threads').select('thread_id, inbox_threads(subject, last_message_at)').eq('task_id', taskId),
      supabase.from('task_slack_messages').select('id, user_name, content, received_at').eq('task_id', taskId).order('received_at'),
      supabase.from('task_assignees').select('user_id').eq('task_id', taskId),
    ])

    // Enrich with profiles
    const allUids = new Set<string>()
    const cmtRows = (cmtRes.data ?? []) as TaskComment[]
    const tlRows = (tlRes.data ?? []) as TimeLog[]
    const shRows = (shRes.data ?? []) as StatusEntry[]
    const taRows = (taRes.data ?? []) as { user_id: string }[]
    cmtRows.forEach(c => allUids.add(c.user_id))
    tlRows.forEach(t => allUids.add(t.user_id))
    shRows.forEach(s => { if (s.changed_by) allUids.add(s.changed_by) })
    taRows.forEach(a => allUids.add(a.user_id))

    let profileMap = new Map<string, { display_name: string | null; avatar_url: string | null }>()
    if (allUids.size > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', [...allUids])
      profileMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => [p.id, p]))
    }

    cmtRows.forEach(c => { const p = profileMap.get(c.user_id); c.display_name = p?.display_name ?? null; c.avatar_url = p?.avatar_url ?? null })
    tlRows.forEach(t => { const p = profileMap.get(t.user_id); t.display_name = p?.display_name ?? null })
    shRows.forEach(s => { if (s.changed_by) { const p = profileMap.get(s.changed_by); s.display_name = p?.display_name ?? null } })

    setComments(cmtRows)
    setTimeLogs(tlRows)
    setArtifacts((artRes.data as Artifact[]) ?? [])
    setStatusHistory(shRows)
    setLinkedThreads((ttRes.data ?? []).map((r: { thread_id: string; inbox_threads: { subject: string | null; last_message_at: string } | { subject: string | null; last_message_at: string }[] | null }) => {
      const th = Array.isArray(r.inbox_threads) ? r.inbox_threads[0] : r.inbox_threads
      return { thread_id: r.thread_id, subject: th?.subject ?? null, last_message_at: th?.last_message_at ?? '' }
    }))
    setSlackMessages((smRes.data as SlackMsg[]) ?? [])
    setAssignees(taRows.map(a => ({ user_id: a.user_id, display_name: profileMap.get(a.user_id)?.display_name ?? null, avatar_url: profileMap.get(a.user_id)?.avatar_url ?? null })))

    // Vault creds
    const { data: tvcData } = await supabase.from('task_vault_credentials').select('id, credential_id, vault_credentials(label, url, username)').eq('task_id', taskId)
    setVaultCreds((tvcData ?? []).map((r: { id: string; credential_id: string; vault_credentials: { label: string; url: string | null; username: string | null } | { label: string; url: string | null; username: string | null }[] | null }) => {
      const v = Array.isArray(r.vault_credentials) ? r.vault_credentials[0] : r.vault_credentials
      return { id: r.id, credential_id: r.credential_id, label: v?.label ?? '', url: v?.url ?? null, username: v?.username ?? null }
    }))
  }, [taskId, projectId])

  useEffect(() => { fetchAll() }, [fetchAll])

  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.from('organization_users').select('user_id').eq('org_id', currentOrg.id)
      .then(async ({ data }) => {
        const uids = (data ?? []).map((r: { user_id: string }) => r.user_id)
        if (!uids.length) return
        const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', uids)
        setOrgUsers((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => ({ user_id: p.id, display_name: p.display_name, avatar_url: p.avatar_url })))
      })
  }, [currentOrg?.id])

  const handleStatusChange = async (status: string) => {
    if (!taskId) return
    await supabase.from('tasks').update({ status, updated_at: new Date().toISOString() }).eq('id', taskId)
    fetchAll()
  }

  const handleAddComment = async () => {
    if (!taskId || !commentText.trim() || !user?.id) return
    await supabase.from('task_comments').insert({ task_id: taskId, user_id: user.id, content: commentText.trim() })
    setCommentText(''); fetchAll()
  }

  const handleLogTime = async () => {
    if (!taskId || !projectId || !user?.id) return
    const parts = logTime.split(':')
    const h = parseInt(parts[0]) || 0
    const m = parseInt(parts[1]) || 0
    if (h === 0 && m === 0) return
    await supabase.from('time_logs').insert({
      task_id: taskId, project_id: projectId, user_id: user.id,
      hours: h, minutes: m, work_date: logDate,
      description: logDesc.trim() || null, comment: logComment.trim() || null, billed: logBillable,
    })
    setLogTime(''); setLogDesc(''); setLogComment(''); setShowTimeForm(false); fetchAll()
  }

  const handleAddArtifact = async () => {
    if (!taskId || !user?.id) return
    if (artUrl.trim()) {
      await supabase.from('task_artifacts').insert({
        task_id: taskId, type: isLoomUrl(artUrl) ? 'loom' : 'link',
        label: artLabel.trim() || null, url: artUrl.trim(), uploaded_by: user.id,
      })
    }
    setArtLabel(''); setArtUrl(''); setShowArtifactForm(false); fetchAll()
  }

  const handleFileUpload = async (file: File) => {
    if (!taskId || !currentOrg?.id || !user?.id) return
    const path = `${currentOrg.id}/${projectId}/${taskId}/${Date.now()}-${file.name}`
    const { error } = await supabase.storage.from('task-artifacts').upload(path, file)
    if (error) return
    await supabase.from('task_artifacts').insert({
      task_id: taskId, type: 'file', label: file.name,
      file_path: path, file_name: file.name, content_type: file.type, uploaded_by: user.id,
    })
    fetchAll()
  }

  const handleAddAssignee = async () => {
    if (!taskId || !addAssigneeId) return
    await supabase.from('task_assignees').insert({ task_id: taskId, user_id: addAssigneeId })
    setAddAssigneeId(''); fetchAll()
  }

  const handleRemoveAssignee = async (uid: string) => {
    if (!taskId) return
    await supabase.from('task_assignees').delete().eq('task_id', taskId).eq('user_id', uid)
    fetchAll()
  }

  const totalMinutes = timeLogs.reduce((sum, t) => sum + (t.hours * 60) + t.minutes, 0)
  const billableMinutes = timeLogs.filter(t => t.billed !== false).reduce((sum, t) => sum + (t.hours * 60) + t.minutes, 0)
  const currentStatusInfo = STATUS_FLOW.find(s => s.value === task?.status) ?? STATUS_FLOW[0]
  const currentStep = currentStatusInfo.step

  if (loading) return <div className="p-4 md:p-6 text-gray-400">Loading…</div>
  if (!task) return <div className="p-4 md:p-6"><p className="text-gray-400">Task not found.</p><Link to={`/projects/${projectId}`} className="text-accent hover:underline">Back to project</Link></div>

  return (
    <div className="p-4 md:p-6" data-testid="task-detail">
      {/* Breadcrumb */}
      <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-4">
        <ArrowLeft className="w-4 h-4" /> {projectName || 'Project'}
      </Link>

      {/* Task header */}
      <div className="rounded-lg border border-border bg-surface-elevated p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-white mb-1">{task.title}</h1>
            <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
              <span className={PRIORITY_COLORS[task.priority]}>{task.priority} priority</span>
              {task.due_date && <span>Due: {task.due_date}</span>}
              <span>Created: {new Date(task.created_at).toLocaleDateString()}</span>
            </div>
          </div>
          <select value={task.status} onChange={e => handleStatusChange(e.target.value)}
            className={`rounded-lg px-3 py-2 text-xs font-medium border-0 focus:outline-none focus:ring-2 focus:ring-accent shrink-0 ${currentStatusInfo.color}`}>
            {STATUS_FLOW.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        {/* Status progress bar */}
        <div className="flex items-center gap-1 mb-4">
          {STATUS_FLOW.map((s, i) => (
            <div key={s.value} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= currentStep ? 'bg-accent' : 'bg-surface-muted'}`} title={s.label} />
          ))}
        </div>

        {/* Description */}
        {task.description && (
          <div className="text-sm text-gray-300 whitespace-pre-wrap mb-4 border-l-2 border-accent/30 pl-4">
            {task.description}
          </div>
        )}

        {/* Loom embeds in description */}
        {task.description && (() => {
          const loomMatches = task.description.match(/https:\/\/www\.loom\.com\/share\/[a-zA-Z0-9]+/g)
          return loomMatches?.map((url, i) => (
            <div key={i} className="mb-4 rounded-lg overflow-hidden border border-border">
              <iframe src={getLoomEmbedUrl(url)} className="w-full aspect-video" allowFullScreen frameBorder="0" />
            </div>
          ))
        })()}

        {/* Artifacts */}
        {artifacts.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Resources</h3>
            <div className="flex flex-wrap gap-2">
              {artifacts.map(a => (
                <a key={a.id} href={a.type === 'loom' ? getLoomEmbedUrl(a.url!) : (a.url ?? supabase.storage.from('task-artifacts').getPublicUrl(a.file_path!).data.publicUrl)}
                  target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-xs text-gray-300 hover:text-accent border border-border hover:border-accent/30">
                  {a.type === 'loom' ? <ExternalLink className="w-3 h-3" /> : a.type === 'file' ? <Paperclip className="w-3 h-3" /> : <LinkIcon className="w-3 h-3" />}
                  {a.label ?? a.file_name ?? a.url?.slice(0, 40)}
                </a>
              ))}
              <button type="button" onClick={() => setShowArtifactForm(!showArtifactForm)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-border text-xs text-gray-500 hover:text-accent hover:border-accent/30">
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
          </div>
        )}

        {showArtifactForm && (
          <div className="rounded-lg border border-border bg-surface-muted p-3 mb-4 space-y-2">
            <div className="flex gap-2">
              <input type="text" value={artLabel} onChange={e => setArtLabel(e.target.value)} placeholder="Label (optional)"
                className="flex-1 rounded border border-border bg-surface-elevated px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              <input type="url" value={artUrl} onChange={e => setArtUrl(e.target.value)} placeholder="URL (Loom, GitHub, etc.)"
                className="flex-1 rounded border border-border bg-surface-elevated px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" onClick={handleAddArtifact} className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium">Add link</button>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">Or upload file:</label>
              <input type="file" onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); e.target.value = '' }}
                className="text-xs text-gray-400" />
            </div>
          </div>
        )}

        {artifacts.length === 0 && !showArtifactForm && (
          <button type="button" onClick={() => setShowArtifactForm(true)}
            className="text-xs text-gray-500 hover:text-accent flex items-center gap-1 mb-4">
            <Plus className="w-3 h-3" /> Add resources (Loom, links, files)
          </button>
        )}

        {/* Vault credentials */}
        {vaultCreds.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-1"><Key className="w-3 h-3" /> Credentials</h3>
            <div className="space-y-1">
              {vaultCreds.map(v => (
                <div key={v.id} className="flex items-center gap-2 text-xs">
                  <Key className="w-3 h-3 text-gray-500" />
                  <span className="text-gray-300">{v.label}</span>
                  {v.username && <span className="text-gray-500">({v.username})</span>}
                  {v.url && <a href={v.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{v.url}</a>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Team */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Team:</span>
          {assignees.map(a => (
            <span key={a.user_id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-muted text-[11px] text-gray-200">
              {a.avatar_url ? <img src={a.avatar_url} alt="" className="w-4 h-4 rounded-full" /> : (
                <span className="w-4 h-4 rounded-full bg-accent/20 flex items-center justify-center text-[8px] font-medium text-accent">{(a.display_name ?? '?')[0].toUpperCase()}</span>
              )}
              {a.display_name ?? 'User'}
              <button type="button" onClick={() => handleRemoveAssignee(a.user_id)} className="text-gray-500 hover:text-red-400">&times;</button>
            </span>
          ))}
          <select value={addAssigneeId} onChange={e => { setAddAssigneeId(e.target.value); if (e.target.value) { handleAddAssignee(); setAddAssigneeId('') } }}
            className="rounded border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="">+ Add</option>
            {orgUsers.filter(u => !assignees.some(a => a.user_id === u.user_id)).map(u => (
              <option key={u.user_id} value={u.user_id}>{u.display_name ?? u.user_id.slice(0, 8)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-4">
        {([
          ['comments', `Comments (${comments.length})`],
          ['time', `Time (${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m)`],
          ['activity', `Activity (${statusHistory.length})`],
          ['emails', `Emails (${linkedThreads.length})`],
          ['slack', `Slack (${slackMessages.length})`],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setActiveTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === id ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'comments' && (
        <div>
          <div className="space-y-3 mb-4">
            {comments.length === 0 ? <p className="text-gray-500 text-sm">No comments yet.</p> : comments.map(c => (
              <div key={c.id} className="flex gap-3">
                {c.avatar_url ? <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full shrink-0 mt-0.5" /> : (
                  <div className="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center shrink-0 mt-0.5"><User className="w-4 h-4 text-gray-500" /></div>
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
          <div className="flex gap-2">
            <textarea value={commentText} onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && commentText.trim()) { e.preventDefault(); handleAddComment() } }}
              placeholder="Add a comment… (Shift+Enter for new line)"
              rows={2}
              className="flex-1 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent resize-y" />
            <button type="button" onClick={handleAddComment} disabled={!commentText.trim()}
              className="px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 self-end">
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {activeTab === 'time' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4 text-sm">
              <span className="text-gray-300">Total: <strong className="text-white">{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m</strong></span>
              <span className="text-gray-400">Billable: <strong className="text-accent">{Math.floor(billableMinutes / 60)}h {billableMinutes % 60}m</strong></span>
            </div>
            <button type="button" onClick={() => setShowTimeForm(!showTimeForm)}
              className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> Log time</button>
          </div>

          {showTimeForm && (
            <div className="rounded-lg border border-border bg-surface-elevated p-4 mb-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Time (HH:MM)</label>
                  <input type="text" value={logTime} onChange={e => setLogTime(e.target.value)} placeholder="01:30"
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Date</label>
                  <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)}
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[10px] text-gray-500 mb-0.5">What did you work on?</label>
                  <input type="text" value={logDesc} onChange={e => setLogDesc(e.target.value)} placeholder="Description"
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>
              <input type="text" value={logComment} onChange={e => setLogComment(e.target.value)} placeholder="Additional notes (optional)"
                className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={logBillable} onChange={e => setLogBillable(e.target.checked)}
                    className="rounded border-border bg-surface-muted text-accent focus:ring-accent" />
                  <span className="text-sm text-gray-300">Billable</span>
                </label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowTimeForm(false)} className="px-3 py-1.5 rounded border border-border text-xs text-gray-300">Cancel</button>
                  <button type="button" onClick={handleLogTime} className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium">Save</button>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border overflow-hidden">
            {timeLogs.length === 0 ? <p className="p-4 text-gray-500 text-sm">No time logged yet.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-xs text-gray-500">
                  <th className="text-left px-4 py-2">Date</th>
                  <th className="text-left px-4 py-2">Time</th>
                  <th className="text-left px-4 py-2">Who</th>
                  <th className="text-left px-4 py-2">Description</th>
                  <th className="text-center px-4 py-2">Billable</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {timeLogs.map(t => (
                    <tr key={t.id} className="hover:bg-surface-muted/30">
                      <td className="px-4 py-2 text-gray-300">{t.work_date}</td>
                      <td className="px-4 py-2 text-white font-medium">{String(t.hours).padStart(2, '0')}:{String(t.minutes).padStart(2, '0')}</td>
                      <td className="px-4 py-2 text-gray-400">{t.display_name ?? 'User'}</td>
                      <td className="px-4 py-2 text-gray-300">
                        {t.description}
                        {t.comment && <p className="text-xs text-gray-500 mt-0.5">{t.comment}</p>}
                      </td>
                      <td className="px-4 py-2 text-center">{t.billed !== false ? <span className="text-accent">✓</span> : <span className="text-gray-600">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="space-y-3">
          {statusHistory.length === 0 ? <p className="text-gray-500 text-sm">No activity yet.</p> : statusHistory.map(s => (
            <div key={s.id} className="flex items-center gap-3 text-sm">
              <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
              <div>
                <span className="text-gray-400">{s.display_name ?? 'System'}</span>
                <span className="text-gray-500"> changed status from </span>
                <span className="text-gray-300">{STATUS_FLOW.find(f => f.value === s.from_status)?.label ?? s.from_status ?? 'none'}</span>
                <span className="text-gray-500"> to </span>
                <span className="text-white font-medium">{STATUS_FLOW.find(f => f.value === s.to_status)?.label ?? s.to_status}</span>
                <span className="text-gray-600 text-xs ml-2">{new Date(s.created_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'emails' && (
        <div className="space-y-2">
          {linkedThreads.length === 0 ? <p className="text-gray-500 text-sm">No email threads linked. Link threads from the Inbox.</p> : linkedThreads.map(t => (
            <Link key={t.thread_id} to={`/inbox/${t.thread_id}`} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-accent/30 hover:bg-surface-muted/30">
              <Mail className="w-4 h-4 text-gray-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{t.subject || '(No subject)'}</p>
                <p className="text-xs text-gray-500">{new Date(t.last_message_at).toLocaleString()}</p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {activeTab === 'slack' && (
        <div className="space-y-3">
          {slackMessages.length === 0 ? <p className="text-gray-500 text-sm">No Slack messages linked to this task.</p> : slackMessages.map(s => (
            <div key={s.id} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center shrink-0 mt-0.5"><MessageSquare className="w-4 h-4 text-gray-500" /></div>
              <div className="flex-1 rounded-lg border border-border bg-surface-muted/50 px-4 py-2.5">
                <div className="flex items-baseline gap-2 text-[11px] mb-1">
                  <span className="text-white font-medium">{s.user_name ?? 'Slack user'}</span>
                  <span className="text-gray-500">{new Date(s.received_at).toLocaleString()}</span>
                </div>
                <p className="text-sm text-gray-200">{s.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
