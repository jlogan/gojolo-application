import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft, Send, Plus, User,
  Paperclip, Key, Mail, ChevronRight,
  FileText, Pencil, Trash2,
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

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg)(\?|$)/i
const TASK_ARTIFACTS_PATH_RE = /\/storage\/v1\/object\/public\/task-artifacts\/(.+?)(?:\?|$)/
const PAPERCLIP_EMOJI = /\u{1F4CE}\s*/gu
function isImageUrl(url: string): boolean { return IMAGE_EXT_RE.test(url) }
function getTaskArtifactsPath(url: string): string | null {
  const m = url.match(TASK_ARTIFACTS_PATH_RE)
  return m ? m[1] : null
}

type ParsedComment = { text: string; attachments: { href: string; label: string; isImage: boolean }[] }
function parseCommentContent(content: string): ParsedComment {
  const attachments: { href: string; label: string; isImage: boolean }[] = []
  let text = content.replace(PAPERCLIP_EMOJI, '')
  text = text.replace(MARKDOWN_LINK_RE, (_, label: string, url: string) => {
    const href = url.trim()
    const displayLabel = (label || href.split('/').pop() || 'attachment').trim()
    attachments.push({ href, label: displayLabel, isImage: isImageUrl(href) })
    return ''
  })
  text = text.trim()
  return { text, attachments }
}

const THUMB_SIZE = 72

function CommentAttachmentCard({ href, label, isImage }: { href: string; label: string; isImage: boolean }) {
  const path = getTaskArtifactsPath(href)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!path) {
      setSignedUrl(href)
      return
    }
    supabase.storage.from('task-artifacts').createSignedUrl(path, 3600).then(({ data, error }) => {
      if (error) setFailed(true)
      else if (data?.signedUrl) setSignedUrl(data.signedUrl)
    })
  }, [path, href])
  const downloadUrl = signedUrl ?? href
  const imgSrc = path ? signedUrl : (isImage ? href : null)
  const canPreview = isImage && imgSrc && !failed
  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <a
        href={downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
        download={label}
        className="flex items-center justify-center rounded-lg border border-border bg-surface-elevated overflow-hidden hover:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent shrink-0"
        style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
      >
        {canPreview ? (
          <img src={imgSrc} alt="" className="w-full h-full object-cover" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <div className="flex items-center justify-center w-full h-full text-gray-500">
            <FileText className="w-8 h-8" />
          </div>
        )}
      </a>
      <a href={downloadUrl} target="_blank" rel="noopener noreferrer" download={label} className="text-xs text-gray-500 hover:text-accent truncate max-w-[72px]">
        Download
      </a>
    </div>
  )
}

function CommentContent({ content }: { content: string }) {
  const { text, attachments } = parseCommentContent(content)
  return (
    <span>
      {text && <span className="whitespace-pre-wrap">{text}</span>}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-2">
          {attachments.map((a, i) => (
            <CommentAttachmentCard key={i} href={a.href} label={a.label} isImage={a.isImage} />
          ))}
        </div>
      )}
    </span>
  )
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
  const [_slackMessages, setSlackMessages] = useState<SlackMsg[]>([])
  const [vaultCreds, setVaultCreds] = useState<VaultCred[]>([])
  const [assignees, setAssignees] = useState<TaskAssignee[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [loading, setLoading] = useState(true)
  const [projectName, setProjectName] = useState('')
  const [activeTab, setActiveTab] = useState<'comments' | 'time' | 'activity' | 'emails'>('comments')

  // Editing
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPriority, setEditPriority] = useState('')
  const [editDue, setEditDue] = useState('')

  // Comment form
  const [commentText, setCommentText] = useState('')
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [commentFile, setCommentFile] = useState<File | null>(null)

  const [loomModalUrl, setLoomModalUrl] = useState<string | null>(null)

  // Time log form
  const [showTimeForm, setShowTimeForm] = useState(false)
  const [logTime, setLogTime] = useState('')
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0])
  const [logNotes, setLogNotes] = useState('')
  const [logBillable, setLogBillable] = useState(true)
  const [canEditBillable, setCanEditBillable] = useState(false)

  // Artifact form
  const [showArtifactForm, setShowArtifactForm] = useState(false)
  const [showAttachmentForm, setShowAttachmentForm] = useState(false)
  const [showTeamForm, setShowTeamForm] = useState(false)
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
    if (!currentOrg?.id || !user?.id) return
    supabase.rpc('user_has_permission', { p_org_id: currentOrg.id, p_permission: 'timesheets.billable_status' })
      .then(({ data }) => setCanEditBillable(data === true))
  }, [currentOrg?.id, user?.id])

  useEffect(() => {
    if (showTimeForm && !canEditBillable) setLogBillable(false)
  }, [showTimeForm, canEditBillable])

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

  const handleStartEdit = () => {
    if (!task) return
    setEditTitle(task.title); setEditDesc(task.description ?? ''); setEditPriority(task.priority); setEditDue(task.due_date ?? '')
    setEditing(true)
  }

  const handleSaveEdit = async () => {
    if (!taskId) return
    await supabase.from('tasks').update({
      title: editTitle.trim(), description: editDesc.trim() || null,
      priority: editPriority, due_date: editDue || null, updated_at: new Date().toISOString(),
    }).eq('id', taskId)
    setEditing(false); fetchAll()
  }

  const handleAddComment = async () => {
    if (!taskId || (!commentText.trim() && !commentFile) || !user?.id) return
    let fileUrl: string | null = null
    let fileName: string | null = null
    if (commentFile && currentOrg?.id) {
      const path = `${currentOrg.id}/${projectId}/${taskId}/comments/${Date.now()}-${commentFile.name}`
      const { error } = await supabase.storage.from('task-artifacts').upload(path, commentFile)
      if (!error) {
        const { data: signed } = await supabase.storage.from('task-artifacts').createSignedUrl(path, 3600)
        fileUrl = signed?.signedUrl ?? supabase.storage.from('task-artifacts').getPublicUrl(path).data.publicUrl
        fileName = commentFile.name
      }
    }
    const content = commentText.trim() + (fileUrl && fileName ? `\n\n📎 [${fileName}](${fileUrl})` : '')
    if (!content.trim()) return
    const { data: newComment } = await supabase.from('task_comments').insert({ task_id: taskId, user_id: user.id, content }).select('id').single()
    setCommentText('')
    setCommentFile(null)
    await fetchAll()
    if (newComment && projectId) {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          const preview = commentText.trim().slice(0, 200) + (fileName ? ' [attachment]' : '')
          await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/notify-task-comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
            body: JSON.stringify({ taskId, projectId, commentId: (newComment as { id: string }).id, contentPreview: preview, authorName: orgUsers.find(u => u.user_id === user?.id)?.display_name ?? user?.email ?? 'Someone' }),
          })
        }
      } catch (_) { /* ignore */ }
    }
  }

  const handleEditComment = (c: TaskComment) => {
    setEditingCommentId(c.id)
    setEditDraft(c.content)
  }

  const handleSaveComment = async () => {
    if (!editingCommentId || !editDraft.trim()) return
    await supabase.from('task_comments').update({ content: editDraft.trim() }).eq('id', editingCommentId).eq('user_id', user!.id)
    setEditingCommentId(null)
    setEditDraft('')
    fetchAll()
  }

  const handleDeleteComment = async (c: TaskComment) => {
    if (!window.confirm('Delete this comment?')) return
    await supabase.from('task_comments').delete().eq('id', c.id).eq('user_id', user!.id)
    fetchAll()
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
      description: logNotes.trim() || null, comment: null, billed: logBillable,
    })
    setLogTime(''); setLogNotes(''); setShowTimeForm(false); fetchAll()
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
    setShowAttachmentForm(false)
    fetchAll()
  }

  const handleAddAssignee = async (uid?: string) => {
    const assignUid = uid ?? addAssigneeId
    if (!taskId || !assignUid) return
    await supabase.from('task_assignees').insert({ task_id: taskId, user_id: assignUid })
    setAddAssigneeId('')
    setShowTeamForm(false)
    fetchAll()
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

  type ActivityItem = { type: 'status'; id: string; created_at: string; display_name?: string | null; from_status: string | null; to_status: string } | { type: 'comment'; id: string; created_at: string; display_name?: string | null; content: string }
  const activityItems: ActivityItem[] = useMemo(() => {
    const statusItems: ActivityItem[] = statusHistory.map(s => ({ type: 'status' as const, id: s.id, created_at: s.created_at, display_name: s.display_name, from_status: s.from_status, to_status: s.to_status }))
    const commentItems: ActivityItem[] = comments.map(c => ({ type: 'comment' as const, id: c.id, created_at: c.created_at, display_name: c.display_name, content: c.content }))
    return [...statusItems, ...commentItems].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [statusHistory, comments])

  if (loading) return <div className="p-4 md:p-6 text-gray-400">Loading…</div>
  if (!task) return <div className="p-4 md:p-6"><p className="text-gray-400">Task not found.</p><Link to={`/projects/${projectId}`} className="text-accent hover:underline">Back to project</Link></div>

  return (
    <div className="p-4 md:p-6" data-testid="task-detail">
      {/* Breadcrumb */}
      <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-4">
        <ArrowLeft className="w-4 h-4" /> {projectName || 'Project'}
      </Link>

      {/* Loom modal */}
      {loomModalUrl && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setLoomModalUrl(null)}>
          <div className="w-full max-w-4xl" onClick={e => e.stopPropagation()}>
            <iframe src={getLoomEmbedUrl(loomModalUrl)} className="w-full aspect-video rounded-lg" allowFullScreen frameBorder="0" />
            <button type="button" onClick={() => setLoomModalUrl(null)} className="mt-2 text-sm text-gray-400 hover:text-white">Close</button>
          </div>
        </div>
      )}

      {/* Task header */}
      <div className="rounded-lg border border-border bg-surface-elevated p-6 mb-6">
        {editing ? (
          <div className="space-y-3 mb-4">
            <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-lg text-white font-semibold focus:outline-none focus:ring-2 focus:ring-accent" />
            <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={6} placeholder="Task description… (paste Loom links to auto-embed)"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent resize-y" />
            <div className="grid grid-cols-3 gap-3">
              <select value={editPriority} onChange={e => setEditPriority(e.target.value)}
                className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select>
              <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)}
                className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent" />
              <div className="flex gap-2">
                <button type="button" onClick={handleSaveEdit} className="flex-1 px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90">Save</button>
                <button type="button" onClick={() => setEditing(false)} className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex-1 min-w-0 cursor-pointer" onClick={handleStartEdit} title="Click to edit">
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

            {/* Description (click to edit) */}
            {task.description ? (
              <div className="text-sm text-gray-300 whitespace-pre-wrap mb-4 border-l-2 border-accent/30 pl-4 cursor-pointer hover:border-accent/60" onClick={handleStartEdit} title="Click to edit">
                {task.description}
              </div>
            ) : (
              <button type="button" onClick={handleStartEdit} className="text-sm text-gray-500 hover:text-accent mb-4">+ Add description</button>
            )}

            {/* Loom embeds in description — inline, clickable to modal */}
            {task.description && (() => {
              const loomMatches = task.description.match(/https:\/\/www\.loom\.com\/share\/[a-zA-Z0-9]+/g)
              return loomMatches?.map((url, i) => (
                <div key={i} className="mb-4 rounded-lg overflow-hidden border border-border cursor-pointer hover:border-accent/30" onClick={() => setLoomModalUrl(url)}>
                  <div className="relative">
                    <iframe src={getLoomEmbedUrl(url)} className="w-full aspect-video pointer-events-none" frameBorder="0" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/10 transition-colors">
                      <span className="px-3 py-1.5 rounded-lg bg-black/60 text-white text-sm">▶ Click to expand</span>
                    </div>
                  </div>
                </div>
              ))
            })()}
          </>
        )}

        {/* Artifacts */}
        {/* Resources (links) */}
        <div className="mb-4">
          <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Resources</h3>
          <div className="flex flex-wrap gap-2">
            {artifacts.filter(a => a.type !== 'file').map(a => {
              const isLoom = a.type === 'loom' || isLoomUrl(a.url ?? '')
              const isSlack = a.url?.includes('slack.com')
              const isGithub = a.url?.includes('github.com')
              const icon = isLoom ? '🎥' : isSlack ? '💬' : isGithub ? '🔗' : '🌐'
              return isLoom ? (
                <button key={a.id} type="button" onClick={() => setLoomModalUrl(a.url!)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-xs text-gray-300 hover:text-accent border border-border hover:border-accent/30">
                  <span>{icon}</span> {a.label ?? 'Loom video'}
                </button>
              ) : (
                <a key={a.id} href={a.url!} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-xs text-gray-300 hover:text-accent border border-border hover:border-accent/30">
                  <span>{icon}</span> {a.label ?? a.url?.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}
                </a>
              )
            })}
            <button type="button" onClick={() => setShowArtifactForm(!showArtifactForm)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-border text-xs text-gray-500 hover:text-accent hover:border-accent/30">
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
        </div>

        {/* Add resource (link) form - links only */}
        {showArtifactForm && (
          <div className="rounded-lg border border-border bg-surface-muted p-3 mb-4">
            <div className="flex flex-wrap gap-2 items-center">
              <input type="text" value={artLabel} onChange={e => setArtLabel(e.target.value)} placeholder="Label (optional)"
                className="min-w-[120px] flex-1 rounded border border-border bg-surface-elevated px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              <input type="url" value={artUrl} onChange={e => setArtUrl(e.target.value)} placeholder="URL (Loom, GitHub, etc.)"
                className="min-w-[160px] flex-1 rounded border border-border bg-surface-elevated px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" onClick={handleAddArtifact} className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium">Add link</button>
            </div>
          </div>
        )}

        {artifacts.filter(a => a.type !== 'file').length === 0 && !showArtifactForm && (
          <button type="button" onClick={() => setShowArtifactForm(true)}
            className="text-xs text-gray-500 hover:text-accent flex items-center gap-1 mb-4">
            <Plus className="w-3 h-3" /> Add resources (Loom, links)
          </button>
        )}

        {/* Attachments: file list + Add button to show upload form */}
        <div className="mb-4">
          <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Attachments</h3>
          <div className="flex flex-wrap gap-2 items-center">
            {artifacts.filter(a => a.type === 'file').map(a => (
              <a key={a.id} href={supabase.storage.from('task-artifacts').getPublicUrl(a.file_path!).data.publicUrl}
                target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-xs text-gray-300 hover:text-accent border border-border hover:border-accent/30">
                <Paperclip className="w-3 h-3" /> {a.file_name ?? a.label}
              </a>
            ))}
            {!showAttachmentForm && (
              <button type="button" onClick={() => setShowAttachmentForm(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-border text-xs text-gray-500 hover:text-accent hover:border-accent/30">
                <Plus className="w-3 h-3" /> Add
              </button>
            )}
          </div>
          {showAttachmentForm && (
            <div className="rounded-lg border border-border bg-surface-muted p-3 mt-2 flex flex-wrap items-center gap-2">
              <label className="text-xs text-gray-500">Upload file</label>
              <input type="file" onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); e.target.value = '' }}
                className="text-xs text-gray-400 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-accent file:text-white file:cursor-pointer hover:file:opacity-90" />
              <button type="button" onClick={() => setShowAttachmentForm(false)} className="px-3 py-1.5 rounded border border-border text-xs text-gray-300 hover:bg-surface-elevated">Cancel</button>
            </div>
          )}
        </div>

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
        <div className="mb-4">
          <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Team</h3>
          <div className="flex flex-wrap gap-2 items-center">
            {assignees.map(a => (
              <span key={a.user_id} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-xs text-gray-300 border border-border hover:border-accent/30">
                {a.avatar_url ? <img src={a.avatar_url} alt="" className="w-4 h-4 rounded-full shrink-0" /> : (
                  <span className="w-4 h-4 rounded-full bg-accent/20 flex items-center justify-center text-[8px] font-medium text-accent shrink-0">{(a.display_name ?? '?')[0].toUpperCase()}</span>
                )}
                {a.display_name ?? 'User'}
                <button type="button" onClick={() => handleRemoveAssignee(a.user_id)} className="text-gray-500 hover:text-red-400 ml-0.5" aria-label="Remove">&times;</button>
              </span>
            ))}
            {!showTeamForm && (
              <button type="button" onClick={() => setShowTeamForm(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-border text-xs text-gray-500 hover:text-accent hover:border-accent/30">
                <Plus className="w-3 h-3" /> Add
              </button>
            )}
          </div>
          {showTeamForm && (
            <div className="rounded-lg border border-border bg-surface-muted p-3 mt-2 flex flex-wrap items-center gap-2">
              <select value={addAssigneeId} onChange={e => setAddAssigneeId(e.target.value)}
                className="rounded border border-border bg-surface-elevated px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent min-w-[160px]">
                <option value="">Select member…</option>
                {orgUsers.filter(u => !assignees.some(a => a.user_id === u.user_id)).map(u => (
                  <option key={u.user_id} value={u.user_id}>{u.display_name ?? u.user_id.slice(0, 8)}</option>
                ))}
              </select>
              <button type="button" onClick={() => handleAddAssignee()} disabled={!addAssigneeId} className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-50">Add</button>
              <button type="button" onClick={() => { setShowTeamForm(false); setAddAssigneeId('') }} className="px-3 py-1.5 rounded border border-border text-xs text-gray-300 hover:bg-surface-elevated">Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-4">
        {([
          ['comments', `Comments (${comments.length})`],
          ['time', `Time (${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m)`],
          ['activity', `Activity (${activityItems.length})`],
          ['emails', `Emails (${linkedThreads.length})`],
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
                <div className="flex-1 rounded-lg border border-border bg-surface-muted/50 px-4 py-2.5 min-w-0">
                  <div className="flex items-baseline gap-2 text-[11px] mb-1 flex-wrap">
                    <span className="text-white font-medium">{c.display_name ?? 'User'}</span>
                    <span className="text-gray-500">{new Date(c.created_at).toLocaleString()}</span>
                    {user?.id === c.user_id && editingCommentId !== c.id && (
                      <span className="ml-auto flex items-center gap-1">
                        <button type="button" onClick={() => handleEditComment(c)} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted" title="Edit"><Pencil className="w-3 h-3" /></button>
                        <button type="button" onClick={() => handleDeleteComment(c)} className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-surface-muted" title="Delete"><Trash2 className="w-3 h-3" /></button>
                      </span>
                    )}
                  </div>
                  {editingCommentId === c.id ? (
                    <div className="space-y-2">
                      <textarea value={editDraft} onChange={e => setEditDraft(e.target.value)} rows={3} className="w-full rounded border border-border bg-surface-elevated px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent resize-y" />
                      <div className="flex gap-2">
                        <button type="button" onClick={handleSaveComment} className="px-2 py-1 rounded bg-accent text-white text-xs font-medium">Save</button>
                        <button type="button" onClick={() => { setEditingCommentId(null); setEditDraft('') }} className="px-2 py-1 rounded border border-border text-xs text-gray-300">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-200">
                      <CommentContent content={c.content} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <textarea value={commentText} onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && (commentText.trim() || commentFile)) { e.preventDefault(); handleAddComment() } }}
              placeholder="Add a comment… (Shift+Enter for new line)"
              rows={2}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent resize-y" />
            {commentFile && (
              <span className="text-xs text-gray-400 flex items-center gap-1">
                <Paperclip className="w-3 h-3" /> {commentFile.name}
                <button type="button" onClick={() => setCommentFile(null)} className="text-gray-500 hover:text-red-400" aria-label="Remove attachment">&times;</button>
              </span>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={handleAddComment} disabled={!commentText.trim() && !commentFile}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                <Send className="w-4 h-4 inline mr-1" /> Comment
              </button>
              <label className="px-3 py-2 rounded-lg border border-border text-sm text-gray-400 hover:text-white hover:bg-surface-muted cursor-pointer">
                <Paperclip className="w-4 h-4 inline mr-1" /> Attach
                <input type="file" className="hidden" onChange={e => { if (e.target.files?.[0]) setCommentFile(e.target.files[0]); e.target.value = '' }} />
              </label>
            </div>
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Time (HH:MM)</label>
                  <input type="text" value={logTime} onChange={e => setLogTime(e.target.value)} placeholder="1:30"
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Date</label>
                  <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)}
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Billable / Non billable</label>
                  <select
                    value={logBillable ? 'billable' : 'non_billable'}
                    onChange={e => setLogBillable(e.target.value === 'billable')}
                    disabled={!canEditBillable}
                    className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <option value="billable">Billable</option>
                    <option value="non_billable">Non billable</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Notes</label>
                <input type="text" value={logNotes} onChange={e => setLogNotes(e.target.value)} placeholder="What did you work on? (optional)"
                  className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowTimeForm(false)} className="px-3 py-1.5 rounded border border-border text-xs text-gray-300">Cancel</button>
                <button type="button" onClick={handleLogTime} className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium">Save</button>
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
          {activityItems.length === 0 ? <p className="text-gray-500 text-sm">No activity yet.</p> : activityItems.map(item => (
            <div key={`${item.type}-${item.id}`} className="flex items-center gap-3 text-sm">
              <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
              <div>
                {item.type === 'status' ? (
                  <>
                    <span className="text-gray-400">{item.display_name ?? 'System'}</span>
                    <span className="text-gray-500"> changed status from </span>
                    <span className="text-gray-300">{STATUS_FLOW.find(f => f.value === item.from_status)?.label ?? item.from_status ?? 'none'}</span>
                    <span className="text-gray-500"> to </span>
                    <span className="text-white font-medium">{STATUS_FLOW.find(f => f.value === item.to_status)?.label ?? item.to_status}</span>
                  </>
                ) : (
                  <>
                    <span className="text-gray-400">{item.display_name ?? 'User'}</span>
                    <span className="text-gray-500"> added a comment: </span>
                    <span className="text-gray-300">{(item.content || '').replace(/\[[^\]]*\]\([^)]+\)/g, '').trim().slice(0, 80)}{(item.content || '').length > 80 ? '…' : ''}</span>
                  </>
                )}
                <span className="text-gray-600 text-xs ml-2">{new Date(item.created_at).toLocaleString()}</span>
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

    </div>
  )
}
