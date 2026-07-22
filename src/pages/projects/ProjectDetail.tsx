import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  FolderKanban, Pencil, ArrowLeft, Plus, Trash2, Users, Building2, User,
  CheckCircle2, Circle, Clock, Upload, Paperclip, X, Lock, Hash, DollarSign, Timer, Filter, LayoutList,
} from 'lucide-react'
import { type Project, StatusBadge } from './ProjectsList'
import RichTextEditor from '@/components/inbox/RichTextEditor'
import DateInput from '@/components/DateInput'
import LinkedInvoices from '@/components/LinkedInvoices'
import CredentialsPanel from '@/components/CredentialsPanel'

type Task = {
  id: string; title: string; status: string; priority: string;
  due_date: string | null; assigned_to: string | null; description: string | null
}
type Member = { user_id: string; role: string; display_name: string | null; avatar_url: string | null }
type CompanyRow = { company_id: string; name: string }
type ContactRow = { contact_id: string; name: string; email: string | null }
type OrgUser = { user_id: string; display_name: string | null; avatar_url: string | null }
type Attachment = { id: string; task_id: string; file_name: string | null; file_path: string | null; label: string | null; created_at: string }
type TaskAssigneeRow = { task_id: string; user_id: string }
type ProjectTimeLog = {
  id: string; task_id: string; user_id: string; hours: number; minutes: number
  work_date: string; description: string | null; billed: boolean; hourly_rate: number | null
  task_title?: string | null; display_name?: string | null
}

const STATUS_ICON: Record<string, typeof Circle> = { todo: Circle, in_progress: Clock, done: CheckCircle2 }
const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-gray-400', medium: 'text-yellow-400', high: 'text-orange-400', urgent: 'text-red-400',
}

const TASK_STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  open: { label: 'Open', classes: 'bg-gray-500/20 text-gray-300 border-gray-500/30' },
  todo: { label: 'Open', classes: 'bg-gray-500/20 text-gray-300 border-gray-500/30' },
  in_progress: { label: 'In Progress', classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  ready_for_testing: { label: 'Ready For Testing', classes: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  testing: { label: 'To Be Tested', classes: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  needs_work: { label: 'Needs Work', classes: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  client_review: { label: 'Client Review', classes: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  complete: { label: 'Complete', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
  done: { label: 'Complete', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
  closed: { label: 'Closed', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
}

function taskStatusLabel(status: string): string {
  return TASK_STATUS_CONFIG[status]?.label ?? status.replace(/_/g, ' ')
}

function toLocalISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfWeek(date: Date): Date {
  const start = startOfWeek(date)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return end
}

function isTaskOverdue(dueDate: string): boolean {
  const today = toLocalISODate(new Date())
  return dueDate < today
}

function isTaskDueThisWeek(dueDate: string, today = new Date()): boolean {
  const from = toLocalISODate(startOfWeek(today))
  const to = toLocalISODate(endOfWeek(today))
  return dueDate >= from && dueDate <= to
}

const COMPLETED_STATUSES = new Set(['complete', 'done', 'closed'])
const OPEN_STATUSES = new Set(['open', 'todo'])

type TaskStatusFilter = '' | 'open' | 'in_progress' | 'completed' | 'overdue'
type TaskPriorityFilter = '' | 'high' | 'medium' | 'low'
type TaskDuePreset = 'all' | 'overdue' | 'this_week' | 'no_due_date'

function isTaskCompleted(status: string): boolean {
  return COMPLETED_STATUSES.has(status)
}

function isTaskOpen(status: string): boolean {
  return OPEN_STATUSES.has(status)
}

function isTaskInProgress(status: string): boolean {
  return !isTaskCompleted(status) && !isTaskOpen(status)
}

function isTaskOverdueActive(task: Pick<Task, 'due_date' | 'status'>): boolean {
  return !!task.due_date && isTaskOverdue(task.due_date) && !isTaskCompleted(task.status)
}

function taskMatchesPriorityFilter(priority: string, filter: TaskPriorityFilter): boolean {
  if (!filter) return true
  if (filter === 'high') return priority === 'high' || priority === 'urgent'
  return priority === filter
}

function getTaskAssigneeUserIds(
  task: Pick<Task, 'id' | 'assigned_to'>,
  assigneeRows: TaskAssigneeRow[],
): string[] {
  const fromJoin = assigneeRows.filter(a => a.task_id === task.id).map(a => a.user_id)
  if (fromJoin.length > 0) return fromJoin
  if (task.assigned_to) return [task.assigned_to]
  return []
}

type TaskPresentationView = 'list' | 'kanban'

/** Canonical Kanban column ids (matches TaskDetail STATUS_FLOW). */
const TASK_KANBAN_STATUS_ORDER = [
  'open',
  'in_progress',
  'ready_for_testing',
  'needs_work',
  'client_review',
  'complete',
] as const

/** Workflow stages always shown as Kanban columns (even when empty). */
const TASK_WORKFLOW_STATUSES = new Set(TASK_KANBAN_STATUS_ORDER)

/** Legacy/raw statuses grouped under a canonical Kanban column (display only). */
const TASK_KANBAN_STATUS_ALIASES: Record<string, string> = {
  todo: 'open',
  testing: 'ready_for_testing',
  done: 'complete',
  closed: 'complete',
}

function taskKanbanColumnId(status: string): string {
  return TASK_KANBAN_STATUS_ALIASES[status] ?? status
}

function taskKanbanHeaderClasses(status: string): string {
  const classes = TASK_STATUS_CONFIG[status]?.classes ?? 'bg-gray-500/20 text-gray-300 border-gray-500/30'
  return classes.replace(/\sborder-[^\s]+/g, '')
}

function formatTaskTimeLogged(totalMinutes: number): string | null {
  if (totalMinutes <= 0) return null
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [project, setProject] = useState<Project | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [loading, setLoading] = useState(true)

  // Task form
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  const [taskStatus, setTaskStatus] = useState('todo')
  const [taskPriority, setTaskPriority] = useState('medium')
  const [taskDue, setTaskDue] = useState('')
  const [taskAssigneeIds, setTaskAssigneeIds] = useState<string[]>([])
  const [taskSaving, setTaskSaving] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskFiles, setTaskFiles] = useState<File[]>([])

  // Add member
  const [addMemberUserId, setAddMemberUserId] = useState('')

  // Add company / contact
  const [allCompanies, setAllCompanies] = useState<{ id: string; name: string }[]>([])
  const [allContacts, setAllContacts] = useState<{ id: string; name: string; email: string | null; company_id: string | null }[]>([])
  const [addCompanyId, setAddCompanyId] = useState('')
  const [addContactId, setAddContactId] = useState('')

  // Attachments
  const [taskAssignees, setTaskAssignees] = useState<TaskAssigneeRow[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [selectedTaskForUpload, setSelectedTaskForUpload] = useState<string | null>(null)

  // Task filters + project view tab
  const [searchParams, setSearchParams] = useSearchParams()
  const activeView = searchParams.get('tab') === 'time' ? 'time' : 'tasks'
  const setActiveView = (view: 'tasks' | 'time') => {
    const next = new URLSearchParams(searchParams)
    if (view === 'time') next.set('tab', 'time')
    else next.delete('tab')
    setSearchParams(next, { replace: true })
  }
  const [filterStatus, setFilterStatus] = useState<TaskStatusFilter>('')
  const [filterPriority, setFilterPriority] = useState<TaskPriorityFilter>('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterDuePreset, setFilterDuePreset] = useState<TaskDuePreset>('all')
  const [taskPresentationView, setTaskPresentationView] = useState<TaskPresentationView>('list')
  const [showTaskFilters, setShowTaskFilters] = useState(false)

  // Project time logs
  const [timeLogs, setTimeLogs] = useState<ProjectTimeLog[]>([])
  const [timeLogsLoading, setTimeLogsLoading] = useState(false)

  const fetchProject = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    const { data } = await supabase.from('projects').select('*').eq('id', id).eq('org_id', currentOrg.id).single()
    setProject(data as Project | null)
    setLoading(false)
  }, [id, currentOrg?.id])

  const fetchTasks = useCallback(async () => {
    if (!id) return
    const { data } = await supabase.from('tasks').select('id, title, status, priority, due_date, assigned_to, description').eq('project_id', id).order('created_at', { ascending: false })
    setTasks((data as Task[]) ?? [])
  }, [id])

  const fetchMembers = useCallback(async () => {
    if (!id) return
    const { data } = await supabase.from('project_members').select('user_id, role').eq('project_id', id)
    const rows = (data ?? []) as { user_id: string; role: string }[]
    if (rows.length === 0) { setMembers([]); return }
    const uids = rows.map(r => r.user_id)
    const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', uids)
    const profileMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => [p.id, p]))
    setMembers(rows.map(r => { const p = profileMap.get(r.user_id); return { ...r, display_name: p?.display_name ?? null, avatar_url: p?.avatar_url ?? null } }))
  }, [id])

  const fetchLinked = useCallback(async () => {
    if (!id) return
    const { data: pcData } = await supabase.from('project_companies').select('company_id, companies(name)').eq('project_id', id)
    setCompanies((pcData ?? []).map((r: { company_id: string; companies: { name: string } | { name: string }[] | null }) => {
      const c = Array.isArray(r.companies) ? r.companies[0] : r.companies
      return { company_id: r.company_id, name: c?.name ?? '' }
    }))
    const { data: pconData } = await supabase.from('project_contacts').select('contact_id, contacts(name, email)').eq('project_id', id)
    setContacts((pconData ?? []).map((r: { contact_id: string; contacts: { name: string; email: string | null } | { name: string; email: string | null }[] | null }) => {
      const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
      return { contact_id: r.contact_id, name: c?.name ?? '', email: c?.email ?? null }
    }))
  }, [id])

  const fetchOrgUsers = useCallback(async () => {
    if (!currentOrg?.id) return
    const { data: ouData } = await supabase.from('organization_users').select('user_id').eq('org_id', currentOrg.id)
    const uids = (ouData ?? []).map((r: { user_id: string }) => r.user_id)
    if (uids.length === 0) { setOrgUsers([]); return }
    const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', uids)
    const profileMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => [p.id, p]))
    setOrgUsers(
      uids
        .map(uid => {
          const p = profileMap.get(uid)
          return { user_id: uid, display_name: p?.display_name ?? null, avatar_url: p?.avatar_url ?? null }
        })
        .sort((a, b) => (a.display_name ?? a.user_id).localeCompare(b.display_name ?? b.user_id))
    )
  }, [currentOrg?.id])

  const fetchAllCompaniesContacts = useCallback(async () => {
    if (!currentOrg?.id) return
    const [{ data: cos }, { data: cons }] = await Promise.all([
      supabase.from('companies').select('id, name').eq('org_id', currentOrg.id).order('name'),
      supabase.from('contacts').select('id, name, email, company_id').eq('org_id', currentOrg.id).order('name'),
    ])
    setAllCompanies((cos as { id: string; name: string }[]) ?? [])
    setAllContacts((cons as { id: string; name: string; email: string | null; company_id: string | null }[]) ?? [])
  }, [currentOrg?.id])
  // Contacts filtered to the linked company (or all if no company linked)
  const linkedCompanyId = companies[0]?.company_id ?? null
  const filteredContactOptions = allContacts.filter(c => {
    if (contacts.some(pc => pc.contact_id === c.id)) return false // already linked
    if (linkedCompanyId) return c.company_id === linkedCompanyId
    return true
  })

  const fetchAttachments = useCallback(async () => {
    if (!id) return
    const taskIds = tasks.map(t => t.id)
    if (taskIds.length === 0) { setAttachments([]); return }
    const [attRes, taRes] = await Promise.all([
      supabase.from('task_artifacts').select('id, task_id, label, file_name, file_path, created_at').eq('type', 'file').in('task_id', taskIds).order('created_at', { ascending: false }),
      supabase.from('task_assignees').select('task_id, user_id').in('task_id', taskIds),
    ])
    setAttachments((attRes.data as Attachment[]) ?? [])
    setTaskAssignees((taRes.data as TaskAssigneeRow[]) ?? [])
  }, [id, tasks])

  const fetchTimeLogs = useCallback(async () => {
    if (!id) return
    setTimeLogsLoading(true)
    const { data: rows, error } = await supabase
      .from('time_logs')
      .select('id, task_id, user_id, hours, minutes, work_date, description, billed, hourly_rate, tasks(title)')
      .eq('project_id', id)
      .order('work_date', { ascending: false })

    if (error || !rows) {
      setTimeLogs([])
      setTimeLogsLoading(false)
      return
    }

    const rawRows = rows as unknown[]
    const userIds = [...new Set((rawRows as { user_id: string }[]).map(r => r.user_id))]
    const { data: profiles } = userIds.length > 0
      ? await supabase.from('profiles').select('id, display_name').in('id', userIds)
      : { data: [] }
    const profileMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]))

    const mapped: ProjectTimeLog[] = rawRows.map(r => {
      const row = r as ProjectTimeLog & { tasks?: { title?: string } | { title?: string }[] | null }
      const tsk = row.tasks
      const taskTitle = tsk && typeof tsk === 'object'
        ? (Array.isArray(tsk) ? tsk[0]?.title : tsk.title) ?? null
        : null
      return {
        ...row,
        task_title: taskTitle,
        display_name: profileMap.get(row.user_id) ?? null,
      }
    })

    const allLogIds = mapped.map(t => t.id)
    const actuallyBilledIds = new Set<string>()
    if (allLogIds.length > 0) {
      const { data: billedItems } = await supabase
        .from('invoice_items')
        .select('time_log_ids, invoices!inner(direction)')
        .eq('invoices.direction', 'outbound')
        .overlaps('time_log_ids', allLogIds)
      ;((billedItems ?? []) as { time_log_ids: string[] | null }[]).forEach(item => {
        ;(item.time_log_ids ?? []).forEach(logId => actuallyBilledIds.add(logId))
      })
    }

    setTimeLogs(mapped.map(t => ({ ...t, billed: actuallyBilledIds.has(t.id) })))
    setTimeLogsLoading(false)
  }, [id])

  useEffect(() => { fetchProject() }, [fetchProject])
  useEffect(() => { fetchTasks() }, [fetchTasks])
  useEffect(() => { fetchMembers() }, [fetchMembers])
  useEffect(() => { fetchLinked() }, [fetchLinked])
  useEffect(() => { fetchOrgUsers() }, [fetchOrgUsers])
  useEffect(() => { fetchAllCompaniesContacts() }, [fetchAllCompaniesContacts])
  useEffect(() => { fetchAttachments() }, [fetchAttachments])
  useEffect(() => { fetchTimeLogs() }, [fetchTimeLogs])

  const taskFilterCounts = useMemo(() => ({
    open: tasks.filter(t => isTaskOpen(t.status)).length,
    in_progress: tasks.filter(t => isTaskInProgress(t.status)).length,
    completed: tasks.filter(t => isTaskCompleted(t.status)).length,
    overdue: tasks.filter(t => isTaskOverdueActive(t)).length,
    high: tasks.filter(t => taskMatchesPriorityFilter(t.priority, 'high')).length,
    medium: tasks.filter(t => t.priority === 'medium').length,
    low: tasks.filter(t => t.priority === 'low').length,
    due_overdue: tasks.filter(t => isTaskOverdueActive(t)).length,
    due_this_week: tasks.filter(t => t.due_date && isTaskDueThisWeek(t.due_date)).length,
    no_due_date: tasks.filter(t => !t.due_date).length,
    unassigned: tasks.filter(t => getTaskAssigneeUserIds(t, taskAssignees).length === 0).length,
  }), [tasks, taskAssignees])

  const assigneeFilterOptions = useMemo(() => {
    const userIds = new Set<string>()
    for (const m of members) userIds.add(m.user_id)
    for (const a of taskAssignees) userIds.add(a.user_id)
    for (const t of tasks) {
      if (t.assigned_to) userIds.add(t.assigned_to)
    }
    return [...userIds]
      .map(uid => {
        const member = members.find(m => m.user_id === uid)
        const orgUser = orgUsers.find(u => u.user_id === uid)
        const display_name = member?.display_name ?? orgUser?.display_name ?? uid.slice(0, 8)
        const count = tasks.filter(t => getTaskAssigneeUserIds(t, taskAssignees).includes(uid)).length
        return { user_id: uid, display_name, count }
      })
      .filter(o => o.count > 0)
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
  }, [members, taskAssignees, tasks, orgUsers])

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => {
      if (filterStatus === 'open' && !isTaskOpen(t.status)) return false
      if (filterStatus === 'in_progress' && !isTaskInProgress(t.status)) return false
      if (filterStatus === 'completed' && !isTaskCompleted(t.status)) return false
      if (filterStatus === 'overdue' && !isTaskOverdueActive(t)) return false
      if (!taskMatchesPriorityFilter(t.priority, filterPriority)) return false
      if (filterAssignee === 'unassigned') {
        if (getTaskAssigneeUserIds(t, taskAssignees).length > 0) return false
      } else if (filterAssignee && !getTaskAssigneeUserIds(t, taskAssignees).includes(filterAssignee)) {
        return false
      }
      if (filterDuePreset === 'no_due_date' && t.due_date) return false
      if (filterDuePreset === 'overdue' && !isTaskOverdueActive(t)) return false
      if (filterDuePreset === 'this_week' && (!t.due_date || !isTaskDueThisWeek(t.due_date))) return false
      return true
    })
  }, [tasks, filterStatus, filterPriority, filterAssignee, filterDuePreset, taskAssignees])

  const taskTimeMinutesByTaskId = useMemo(() => {
    const map = new Map<string, number>()
    for (const log of timeLogs) {
      map.set(log.task_id, (map.get(log.task_id) ?? 0) + log.hours * 60 + log.minutes)
    }
    return map
  }, [timeLogs])

  const kanbanColumns = useMemo(() => {
    const columnIdsInTasks = new Set(filteredTasks.map(t => taskKanbanColumnId(t.status)))
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const columnId of TASK_KANBAN_STATUS_ORDER) {
      if (TASK_WORKFLOW_STATUSES.has(columnId) || columnIdsInTasks.has(columnId)) {
        if (!seen.has(columnId)) {
          ordered.push(columnId)
          seen.add(columnId)
        }
      }
    }
    for (const task of filteredTasks) {
      const columnId = taskKanbanColumnId(task.status)
      if (!seen.has(columnId)) {
        ordered.push(columnId)
        seen.add(columnId)
      }
    }
    return ordered.map(columnId => ({
      id: columnId,
      label: taskStatusLabel(columnId),
      headerClasses: taskKanbanHeaderClasses(columnId),
    }))
  }, [filteredTasks])

  const kanbanTasksByColumn = useMemo(() => {
    const grouped: Record<string, Task[]> = {}
    for (const col of kanbanColumns) {
      grouped[col.id] = []
    }
    for (const task of filteredTasks) {
      const columnId = taskKanbanColumnId(task.status)
      if (!grouped[columnId]) grouped[columnId] = []
      grouped[columnId].push(task)
    }
    return grouped
  }, [filteredTasks, kanbanColumns])

  const timeLogTotalMinutes = useMemo(
    () => timeLogs.reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0),
    [timeLogs],
  )
  const timeLogBilledMinutes = useMemo(
    () => timeLogs.filter(t => t.billed).reduce((sum, t) => sum + t.hours * 60 + t.minutes, 0),
    [timeLogs],
  )

  const hasTaskFilters = filterStatus !== '' || filterPriority !== '' || filterAssignee !== '' || filterDuePreset !== 'all'
  const activeTaskFilterCount = [
    filterStatus !== '',
    filterPriority !== '',
    filterAssignee !== '',
    filterDuePreset !== 'all',
  ].filter(Boolean).length

  const clearTaskFilters = () => {
    setFilterStatus('')
    setFilterPriority('')
    setFilterAssignee('')
    setFilterDuePreset('all')
  }

  const resetTaskForm = () => {
    setTaskTitle(''); setTaskDesc(''); setTaskStatus('todo'); setTaskPriority('medium'); setTaskDue(''); setTaskAssigneeIds([])
    setEditingTaskId(null); setShowTaskForm(false); setTaskFiles([])
  }

  const toggleTaskAssignee = (userId: string) => {
    setTaskAssigneeIds(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    )
  }

  const syncTaskAssignees = async (taskId: string, selectedIds: string[]) => {
    const existingIds = taskAssignees.filter(a => a.task_id === taskId).map(a => a.user_id)
    const toRemove = existingIds.filter(id => !selectedIds.includes(id))
    const toAdd = selectedIds.filter(id => !existingIds.includes(id))
    if (toRemove.length > 0) {
      await supabase.from('task_assignees').delete().eq('task_id', taskId).in('user_id', toRemove)
    }
    if (toAdd.length > 0) {
      await supabase.from('task_assignees').insert(toAdd.map(user_id => ({ task_id: taskId, user_id })))
    }
  }

  const handleTaskSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !currentOrg?.id) return
    setTaskSaving(true)
    const primaryAssignee = taskAssigneeIds[0] ?? null
    const payload = {
      project_id: id, org_id: currentOrg.id, title: taskTitle.trim(),
      description: taskDesc.trim() || null, status: taskStatus, priority: taskPriority,
      due_date: taskDue || null, assigned_to: primaryAssignee, updated_at: new Date().toISOString(),
    }
    let newTaskId: string | null = null
    if (editingTaskId) {
      await supabase.from('tasks').update(payload).eq('id', editingTaskId)
      newTaskId = editingTaskId
      await syncTaskAssignees(editingTaskId, taskAssigneeIds)
    } else {
      const { data: insertedTask } = await supabase.from('tasks').insert({ ...payload, created_by: user?.id ?? null }).select('id').single()
      newTaskId = (insertedTask as { id: string } | null)?.id ?? null
      if (newTaskId && taskAssigneeIds.length > 0) {
        await supabase.from('task_assignees').insert(
          taskAssigneeIds.map(user_id => ({ task_id: newTaskId!, user_id }))
        )
      }
    }
    // Upload any attached files
    if (newTaskId && taskFiles.length > 0) {
      for (const file of taskFiles) {
        const path = `${currentOrg!.id}/${id}/${newTaskId}/${Date.now()}-${file.name}`
        const { error: upErr } = await supabase.storage.from('task-artifacts').upload(path, file)
        if (!upErr) {
          await supabase.from('task_artifacts').insert({
            task_id: newTaskId, type: 'file', label: file.name, file_name: file.name,
            file_path: path, content_type: file.type, uploaded_by: user?.id ?? null,
          })
        }
      }
    }
    resetTaskForm()
    setTaskSaving(false)
    fetchTasks()
    fetchAttachments()
  }

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Delete this task?')) return
    await supabase.from('tasks').delete().eq('id', taskId)
    fetchTasks()
  }

  const startEditTask = (t: Task) => {
    setEditingTaskId(t.id); setTaskTitle(t.title); setTaskDesc(t.description ?? '')
    setTaskStatus(t.status); setTaskPriority(t.priority); setTaskDue(t.due_date ?? '')
    const fromJoin = taskAssignees.filter(a => a.task_id === t.id).map(a => a.user_id)
    setTaskAssigneeIds(fromJoin.length > 0 ? fromJoin : (t.assigned_to ? [t.assigned_to] : []))
    setTaskFiles([]); setShowTaskForm(true)
  }

  const handleAddMember = async () => {
    if (!id || !addMemberUserId) return
    await supabase.from('project_members').insert({ project_id: id, user_id: addMemberUserId, role: 'member' })
    setAddMemberUserId('')
    fetchMembers()
  }

  const handleRemoveMember = async (userId: string) => {
    if (!id) return
    await supabase.from('project_members').delete().eq('project_id', id).eq('user_id', userId)
    fetchMembers()
  }

  const handleAddCompany = async () => {
    if (!id || !addCompanyId) return
    // One company per project: remove existing first
    if (companies.length > 0) {
      for (const c of companies) await supabase.from('project_companies').delete().eq('project_id', id).eq('company_id', c.company_id)
    }
    await supabase.from('project_companies').insert({ project_id: id, company_id: addCompanyId })
    // Auto-link all contacts from this company
    if (currentOrg?.id) {
      const { data: companyContacts } = await supabase.from('contacts').select('id').eq('company_id', addCompanyId).eq('org_id', currentOrg.id)
      for (const c of companyContacts ?? []) {
        await supabase.from('project_contacts').upsert({ project_id: id, contact_id: (c as { id: string }).id }, { onConflict: 'project_id,contact_id' })
      }
    }
    setAddCompanyId('')
    fetchLinked()
  }

  const handleRemoveCompany = async (companyId: string) => {
    if (!id) return
    await supabase.from('project_companies').delete().eq('project_id', id).eq('company_id', companyId)
    fetchLinked()
  }

  const handleAddContact = async () => {
    if (!id || !addContactId) return
    await supabase.from('project_contacts').insert({ project_id: id, contact_id: addContactId })
    setAddContactId('')
    fetchLinked()
  }

  const handleRemoveContact = async (contactId: string) => {
    if (!id) return
    await supabase.from('project_contacts').delete().eq('project_id', id).eq('contact_id', contactId)
    fetchLinked()
  }

  const handleFileUpload = async (taskId: string, file: File) => {
    setUploading(true)
    const path = `${currentOrg!.id}/${id}/${taskId}/${Date.now()}-${file.name}`
    const { error: upErr } = await supabase.storage.from('task-artifacts').upload(path, file)
    if (upErr) { console.error(upErr); setUploading(false); return }
    await supabase.from('task_artifacts').insert({
      task_id: taskId, type: 'file', label: file.name, file_name: file.name,
      file_path: path, content_type: file.type, uploaded_by: user?.id ?? null,
    })
    setUploading(false)
    setSelectedTaskForUpload(null)
    fetchAttachments()
  }

  const handleDeleteAttachment = async (att: Attachment) => {
    if (att.file_path) await supabase.storage.from('task-artifacts').remove([att.file_path])
    await supabase.from('task_artifacts').delete().eq('id', att.id)
    fetchAttachments()
  }

  const openAttachment = async (path: string) => {
    const { data, error } = await supabase.storage.from('task-artifacts').createSignedUrl(path, 60 * 60)
    if (error || !data?.signedUrl) { alert('Could not generate download link. Please try again.'); return }
    window.open(data.signedUrl, '_blank', 'noreferrer')
  }

  const getUserName = (uid: string | null) => {
    if (!uid) return 'Unassigned'
    return orgUsers.find(u => u.user_id === uid)?.display_name ?? uid.slice(0, 8)
  }

  const getTaskAssigneeDisplay = (task: Task): string | null => {
    const assigneeIds = getTaskAssigneeUserIds(task, taskAssignees)
    const names = assigneeIds.map(uid => orgUsers.find(u => u.user_id === uid)?.display_name ?? uid.slice(0, 8))
    if (names.length > 0) return names.join(', ')
    if (task.assigned_to) return getUserName(task.assigned_to)
    return null
  }

  if (loading) return <div className="p-4 md:p-6 text-surface-muted">Loading…</div>
  if (!project) return (
    <div className="p-4 md:p-6">
      <p className="text-surface-muted">Project not found.</p>
      <Link to="/projects" className="text-accent hover:underline mt-2 inline-block">Back to projects</Link>
    </div>
  )

  const availableUsersForMember = orgUsers.filter(u => !members.some(m => m.user_id === u.user_id))
  // Assignee list limited to project team members only
  const assignableMembers = members

  return (
    <div className="p-4 md:p-6 min-w-0 max-w-full overflow-x-hidden" data-testid="project-detail">
      {/* Header */}
      <div className="mb-6">
        <Link to="/projects" className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-4">
          <ArrowLeft className="w-4 h-4" /> Projects
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-lg bg-surface-muted flex items-center justify-center shrink-0">
              <FolderKanban className="w-7 h-7 text-accent" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">{project.name}</h1>
              {project.description && <p className="text-gray-400 text-sm mt-0.5">{project.description}</p>}
              <div className="mt-2"><StatusBadge status={project.status} /></div>
            </div>
          </div>
          <button type="button" onClick={() => navigate(`/projects/${project.id}/edit`)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-surface-muted">
            <Pencil className="w-4 h-4" /> Edit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 min-w-0">
        {/* Tasks column (2/3) */}
        <div className="xl:col-span-2 space-y-4 min-w-0">
          <div className="flex flex-wrap gap-1 border-b border-border -mx-1 px-1">
            <button type="button" onClick={() => setActiveView('tasks')}
              className={`shrink-0 px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeView === 'tasks' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
              Tasks ({tasks.length})
            </button>
            <button type="button" onClick={() => setActiveView('time')}
              className={`inline-flex items-center gap-1.5 shrink-0 px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeView === 'time' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
              <Timer className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">Time ({Math.floor(timeLogTotalMinutes / 60)}h {timeLogTotalMinutes % 60}m)</span>
            </button>
          </div>

          {activeView === 'tasks' && (
            <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-gray-300 min-w-0">
              {hasTaskFilters ? `${filteredTasks.length} of ${tasks.length} tasks` : `${tasks.length} tasks`}
            </h2>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {tasks.length > 0 && (
                <>
                  <div
                    role="group"
                    aria-label="Task view"
                    className="inline-flex rounded-lg border border-border overflow-hidden shrink-0"
                  >
                    <button
                      type="button"
                      onClick={() => setTaskPresentationView('list')}
                      aria-pressed={taskPresentationView === 'list'}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                        taskPresentationView === 'list'
                          ? 'bg-accent/10 text-white'
                          : 'text-gray-300 hover:text-white hover:bg-surface-muted'
                      }`}
                    >
                      <LayoutList className="w-3.5 h-3.5 shrink-0" />
                      <span>List</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTaskPresentationView('kanban')}
                      aria-pressed={taskPresentationView === 'kanban'}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border-l border-border transition-colors ${
                        taskPresentationView === 'kanban'
                          ? 'bg-accent/10 text-white'
                          : 'text-gray-300 hover:text-white hover:bg-surface-muted'
                      }`}
                    >
                      <FolderKanban className="w-3.5 h-3.5 shrink-0" />
                      <span>Kanban</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowTaskFilters(v => !v)}
                    aria-expanded={showTaskFilters}
                    aria-controls="project-task-filters"
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                      showTaskFilters || activeTaskFilterCount > 0
                        ? 'border-accent bg-accent/10 text-white'
                        : 'border-border text-gray-300 hover:text-white hover:bg-surface-muted'
                    }`}
                  >
                    <Filter className="w-3.5 h-3.5 shrink-0" />
                    <span>Filters</span>
                    {activeTaskFilterCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-accent text-accent-foreground text-[10px] font-semibold">
                        {activeTaskFilterCount}
                      </span>
                    )}
                  </button>
                  {hasTaskFilters && !showTaskFilters && (
                    <button
                      type="button"
                      onClick={clearTaskFilters}
                      className="px-2.5 py-1.5 rounded-lg border border-border text-gray-400 hover:text-white hover:bg-surface-muted text-xs shrink-0"
                    >
                      Clear filters
                    </button>
                  )}
                </>
              )}
              <button type="button" onClick={() => { resetTaskForm(); setShowTaskForm(true) }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 shrink-0">
                <Plus className="w-3.5 h-3.5" /> Add task
              </button>
            </div>
          </div>

          {hasTaskFilters && !showTaskFilters && (
            <p className="text-xs text-gray-500">
              {activeTaskFilterCount} filter{activeTaskFilterCount === 1 ? '' : 's'} active
              {' — open Filters to adjust, or use Clear filters.'}
            </p>
          )}

          {tasks.length > 0 && showTaskFilters && (
            <div id="project-task-filters" className="rounded-lg border border-border bg-surface-muted/30 p-3 min-w-0 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-gray-500">Filter tasks</p>
                {hasTaskFilters && (
                  <button type="button" onClick={clearTaskFilters}
                    className="px-2 py-1 rounded-lg border border-border text-gray-400 hover:text-white hover:bg-surface-muted text-xs shrink-0">
                    Clear filters
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Status</label>
                  <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as TaskStatusFilter)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
                    <option value="">All statuses</option>
                    <option value="open">Open ({taskFilterCounts.open})</option>
                    <option value="in_progress">In Progress ({taskFilterCounts.in_progress})</option>
                    <option value="completed">Completed ({taskFilterCounts.completed})</option>
                    <option value="overdue">Overdue ({taskFilterCounts.overdue})</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Priority</label>
                  <select value={filterPriority} onChange={e => setFilterPriority(e.target.value as TaskPriorityFilter)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
                    <option value="">All priorities</option>
                    <option value="high">High ({taskFilterCounts.high})</option>
                    <option value="medium">Medium ({taskFilterCounts.medium})</option>
                    <option value="low">Low ({taskFilterCounts.low})</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Assignee</label>
                  <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
                    <option value="">All assignees</option>
                    <option value="unassigned">Unassigned ({taskFilterCounts.unassigned})</option>
                    {assigneeFilterOptions.map(u => (
                      <option key={u.user_id} value={u.user_id}>{u.display_name} ({u.count})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Due date</label>
                  <select value={filterDuePreset} onChange={e => setFilterDuePreset(e.target.value as TaskDuePreset)}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent">
                    <option value="all">All due dates</option>
                    <option value="overdue">Overdue ({taskFilterCounts.due_overdue})</option>
                    <option value="this_week">Due this week ({taskFilterCounts.due_this_week})</option>
                    <option value="no_due_date">No due date ({taskFilterCounts.no_due_date})</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {showTaskForm && (
            <form onSubmit={handleTaskSubmit} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
              <input type="text" required value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task title"
                className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">Description</label>
                <RichTextEditor
                  key={editingTaskId ?? 'new'}
                  content={taskDesc}
                  placeholder="Description (optional)"
                  onChange={html => setTaskDesc(html === '<p></p>' ? '' : html)}
                  minHeight="min-h-[120px]"
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Status</label>
                  <select value={taskStatus} onChange={e => setTaskStatus(e.target.value)}
                    className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent appearance-none">
                    <option value="open">Open</option><option value="in_progress">In Progress</option><option value="needs_work">Needs Work</option><option value="testing">To Be Tested</option><option value="closed">Closed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Priority</label>
                  <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}
                    className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent appearance-none">
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Due Date</label>
                  <DateInput value={taskDue} onChange={e => setTaskDue(e.target.value)}
                    className="w-full h-10 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[10px] text-gray-500 mb-0.5">Assignees</label>
                  {assignableMembers.length === 0 ? (
                    <p className="text-xs text-gray-500 py-2">Add project team members to assign tasks.</p>
                  ) : (
                    <div className="max-h-28 overflow-y-auto rounded-lg border border-border bg-surface-muted px-2 py-1.5 space-y-1">
                      {assignableMembers.map(u => (
                        <label key={u.user_id} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white py-0.5">
                          <input
                            type="checkbox"
                            checked={taskAssigneeIds.includes(u.user_id)}
                            onChange={() => toggleTaskAssignee(u.user_id)}
                            className="rounded border-border bg-surface-elevated text-accent focus:ring-accent"
                          />
                          <span className="truncate">{u.display_name ?? u.user_id.slice(0, 8)}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* Attachments */}
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">Attachments</label>
                <div className="space-y-1.5">
                  {taskFiles.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-gray-400 bg-surface-elevated rounded px-2 py-1">
                      <Paperclip className="w-3 h-3 shrink-0 text-gray-500" />
                      <span className="truncate flex-1">{f.name}</span>
                      <span className="text-gray-600 shrink-0">{f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : `${Math.round(f.size / 1024)}KB`}</span>
                      <button type="button" onClick={() => setTaskFiles(prev => prev.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 shrink-0"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                  <input
                    type="file"
                    key={taskFiles.length}
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) setTaskFiles(prev => [...prev, file])
                    }}
                    className="w-full text-sm text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:text-gray-300 hover:file:bg-accent/10 file:cursor-pointer"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={taskSaving}
                  className="px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
                  {taskSaving ? 'Saving…' : editingTaskId ? 'Update' : 'Add'}
                </button>
                <button type="button" onClick={resetTaskForm} className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-surface-muted">Cancel</button>
              </div>
            </form>
          )}

          {tasks.length === 0 && !showTaskForm ? (
            <p className="text-gray-400 text-sm py-4">No tasks yet. Add one above.</p>
          ) : filteredTasks.length === 0 && !showTaskForm ? (
            <p className="text-gray-400 text-sm py-4">No tasks match your filters.</p>
          ) : taskPresentationView === 'kanban' ? (
            <ProjectTaskKanban
              projectId={id!}
              columns={kanbanColumns}
              tasksByColumn={kanbanTasksByColumn}
              taskTimeMinutesByTaskId={taskTimeMinutesByTaskId}
              getAssigneeDisplay={getTaskAssigneeDisplay}
              onEditTask={startEditTask}
              onDeleteTask={handleDeleteTask}
            />
          ) : (
            <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden min-w-0">
              {filteredTasks.map(t => {
                const Icon = STATUS_ICON[t.status] ?? Circle
                const taskAtts = attachments.filter(a => a.task_id === t.id)
                const timeLogged = formatTaskTimeLogged(taskTimeMinutesByTaskId.get(t.id) ?? 0)
                const assigneeDisplay = getTaskAssigneeDisplay(t)
                return (
                  <li key={t.id} className="p-3 hover:bg-surface-muted/50 transition-colors min-w-0">
                    <div className="flex items-start gap-2 sm:gap-3 min-w-0">
                      <button type="button" title="Toggle status" onClick={async () => {
                        const next = t.status === 'todo' ? 'in_progress' : t.status === 'in_progress' ? 'done' : 'todo'
                        await supabase.from('tasks').update({ status: next }).eq('id', t.id)
                        fetchTasks()
                      }} className="mt-0.5 shrink-0">
                        <Icon className={`w-5 h-5 ${t.status === 'done' ? 'text-green-400' : t.status === 'in_progress' ? 'text-accent' : 'text-gray-500'}`} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <Link to={`/projects/${id}/tasks/${t.id}`} className={`font-medium text-sm hover:text-accent ${t.status === 'closed' ? 'line-through text-gray-500' : 'text-white'}`}>{t.title}</Link>
                        {t.description && (
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">
                            {t.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] ${TASK_STATUS_CONFIG[t.status]?.classes ?? 'bg-gray-500/20 text-gray-300 border-gray-500/30'}`}>
                            {taskStatusLabel(t.status)}
                          </span>
                          <span className={PRIORITY_COLORS[t.priority] ?? 'text-gray-400'}>{t.priority}</span>
                          {t.due_date && (
                            <span className={isTaskOverdue(t.due_date) && !['complete', 'done', 'closed'].includes(t.status) ? 'text-red-400' : 'text-gray-500'}>
                              {t.due_date}
                            </span>
                          )}
                          {assigneeDisplay && <span className="text-gray-400">{assigneeDisplay}</span>}
                          {timeLogged && (
                            <span className="text-gray-500 inline-flex items-center gap-0.5">
                              <Timer className="w-3 h-3" />{timeLogged}
                            </span>
                          )}
                          {taskAtts.length > 0 && <span className="text-gray-500 flex items-center gap-0.5"><Paperclip className="w-3 h-3" />{taskAtts.length}</span>}
                        </div>
                        {/* Attachments for this task */}
                        {taskAtts.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {taskAtts.map(a => (
                              <div key={a.id} className="flex items-center gap-2 text-xs">
                                <Paperclip className="w-3 h-3 text-gray-500" />
                                <button type="button" onClick={() => a.file_path && openAttachment(a.file_path)} className="text-accent hover:underline truncate text-left">{a.file_name ?? a.label}</button>
                                <button type="button" onClick={() => handleDeleteAttachment(a)} className="text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                              </div>
                            ))}
                          </div>
                        )}
                        {selectedTaskForUpload === t.id && (
                          <div className="mt-2">
                            <input type="file" onChange={e => { if (e.target.files?.[0]) handleFileUpload(t.id, e.target.files[0]) }}
                              className="text-xs text-gray-400" disabled={uploading} />
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button type="button" title="Upload file" onClick={() => setSelectedTaskForUpload(selectedTaskForUpload === t.id ? null : t.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted"><Upload className="w-3.5 h-3.5" /></button>
                        <button type="button" title="Edit task" onClick={() => startEditTask(t)}
                          className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted"><Pencil className="w-3.5 h-3.5" /></button>
                        <button type="button" title="Delete task" onClick={() => handleDeleteTask(t.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-surface-muted"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
            </>
          )}

          {activeView === 'time' && (
            <ProjectTimeLogsPanel
              projectId={id!}
              logs={timeLogs}
              loading={timeLogsLoading}
              totalMinutes={timeLogTotalMinutes}
              billedMinutes={timeLogBilledMinutes}
              onRefresh={fetchTimeLogs}
            />
          )}
        </div>

        {/* Sidebar (1/3) */}
        <div className="space-y-6 min-w-0">
          {/* Billing Summary */}
          <section className="rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><DollarSign className="w-4 h-4" /> Billing</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Type</span>
                <span className="text-white">{project.billing_type === 'fixed' ? 'Fixed Rate' : project.billing_type === 'project_hours' ? 'Project Hours' : project.billing_type === 'task_hours' ? 'Task Hours' : 'Fixed Rate'}</span>
              </div>
              {project.billing_type === 'fixed' && project.project_cost != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Project Cost</span>
                  <span className="text-white">${Number(project.project_cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
              {project.billing_type !== 'fixed' && project.hourly_rate != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Hourly Rate</span>
                  <span className="text-white">${Number(project.hourly_rate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/hr</span>
                </div>
              )}
              {project.estimated_hours != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Estimated Hours</span>
                  <span className="text-white">{project.estimated_hours}h</span>
                </div>
              )}
            </div>
          </section>

          {/* Team */}
          <section className="rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><Users className="w-4 h-4" /> Team ({members.length})</h2>
            {members.map(m => (
              <div key={m.user_id} className="flex items-center justify-between py-1.5 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  {m.avatar_url ? (
                    <img src={m.avatar_url} alt="" className="w-6 h-6 rounded-full shrink-0" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center shrink-0 text-[10px] font-medium text-accent">
                      {(m.display_name ?? '?')[0].toUpperCase()}
                    </div>
                  )}
                  <span className="text-white truncate">{m.display_name ?? m.user_id.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-xs text-gray-500">{m.role}</span>
                  <button type="button" onClick={() => handleRemoveMember(m.user_id)} className="p-1 text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                </div>
              </div>
            ))}
            {availableUsersForMember.length > 0 && (
              <div className="flex gap-2 mt-2">
                <select value={addMemberUserId} onChange={e => setAddMemberUserId(e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">Add member…</option>
                  {availableUsersForMember.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name ?? u.user_id.slice(0, 8)}</option>)}
                </select>
                <button type="button" onClick={handleAddMember} disabled={!addMemberUserId}
                  className="px-2 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50">Add</button>
              </div>
            )}
          </section>

          <CredentialsPanel
            orgId={currentOrg!.id}
            projectId={project.id}
            companyId={linkedCompanyId}
            title="Credentials"
            description="Project-specific credentials plus credentials inherited from the linked company. Reveal/copy requires identity confirmation."
          />

          {/* Company (single) */}
          <section className="rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><Building2 className="w-4 h-4" /> Company</h2>
            {companies.length > 0 ? (
              <div className="flex items-center justify-between py-1.5 text-sm">
                <Link to={`/companies/${companies[0].company_id}`} className="text-accent hover:underline truncate">{companies[0].name}</Link>
                <button type="button" onClick={() => handleRemoveCompany(companies[0].company_id)} className="p-1 text-gray-500 hover:text-red-400" title="Remove company"><X className="w-3 h-3" /></button>
              </div>
            ) : (
              <div className="flex gap-2">
                <select value={addCompanyId} onChange={e => setAddCompanyId(e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">Link company…</option>
                  {allCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" onClick={handleAddCompany} disabled={!addCompanyId}
                  className="px-2 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50">Add</button>
              </div>
            )}
          </section>

          {/* Contacts */}
          <section className="rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><User className="w-4 h-4" /> Contacts ({contacts.length})</h2>
            {contacts.map(c => (
              <div key={c.contact_id} className="flex items-center justify-between py-1.5 text-sm">
                <Link to={`/contacts/${c.contact_id}`} className="text-accent hover:underline truncate">{c.name}</Link>
                <button type="button" onClick={() => handleRemoveContact(c.contact_id)} className="p-1 text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <select value={addContactId} onChange={e => setAddContactId(e.target.value)}
                className="flex-1 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="">Link contact…</option>
                {filteredContactOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={handleAddContact} disabled={!addContactId}
                className="px-2 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50">Add</button>
            </div>
          </section>
          {/* Invoices */}
          <LinkedInvoices projectId={id!} />
          {/* Slack channel */}
          <SlackChannelPicker projectId={id!} orgId={currentOrg?.id ?? ''} />
        </div>
      </div>
    </div>
  )
}

function ProjectTaskKanban({
  projectId,
  columns,
  tasksByColumn,
  taskTimeMinutesByTaskId,
  getAssigneeDisplay,
  onEditTask,
  onDeleteTask,
}: {
  projectId: string
  columns: { id: string; label: string; headerClasses: string }[]
  tasksByColumn: Record<string, Task[]>
  taskTimeMinutesByTaskId: Map<string, number>
  getAssigneeDisplay: (task: Task) => string | null
  onEditTask: (task: Task) => void
  onDeleteTask: (taskId: string) => void
}) {
  return (
    <div className="overflow-x-auto -mx-1 px-1 pb-1 min-w-0">
      <div
        className="flex gap-3 min-w-max lg:min-w-0 lg:grid lg:gap-3"
        style={columns.length > 0 ? { gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` } : undefined}
      >
        {columns.map(col => {
          const columnTasks = tasksByColumn[col.id] ?? []
          return (
            <div key={col.id} className="w-[260px] shrink-0 lg:w-auto lg:min-w-[200px] flex flex-col min-h-[120px] rounded-lg border border-border bg-surface-muted/20">
              <div className={`px-3 py-2 border-b border-border rounded-t-lg flex items-center justify-between gap-2 ${col.headerClasses}`}>
                <span className="text-xs font-medium">{col.label}</span>
                <span className="text-[10px] opacity-80">{columnTasks.length}</span>
              </div>
              <div className="p-2 space-y-2 flex-1 min-h-0">
                {columnTasks.length === 0 ? (
                  <p className="text-[11px] text-gray-600 px-1 py-2">No tasks</p>
                ) : (
                  columnTasks.map(task => {
                    const assigneeDisplay = getAssigneeDisplay(task)
                    const timeLogged = formatTaskTimeLogged(taskTimeMinutesByTaskId.get(task.id) ?? 0)
                    const isCompleted = isTaskCompleted(task.status)
                    return (
                      <article
                        key={task.id}
                        className="rounded-lg border border-border bg-surface-elevated p-2.5 hover:border-accent/40 transition-colors group"
                      >
                        <div className="flex items-start gap-1.5 min-w-0">
                          <Link
                            to={`/projects/${projectId}/tasks/${task.id}`}
                            className={`flex-1 min-w-0 text-sm font-medium hover:text-accent leading-snug ${isCompleted ? 'line-through text-gray-500' : 'text-white'}`}
                          >
                            {task.title}
                          </Link>
                          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            <button
                              type="button"
                              title="Edit task"
                              onClick={() => onEditTask(task)}
                              className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              title="Delete task"
                              onClick={() => onDeleteTask(task.id)}
                              className="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-surface-muted"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 space-y-1 text-[11px]">
                          {assigneeDisplay && (
                            <p className="text-gray-400 truncate" title={assigneeDisplay}>
                              {assigneeDisplay}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className={`capitalize ${PRIORITY_COLORS[task.priority] ?? 'text-gray-400'}`}>
                              {task.priority}
                            </span>
                            {task.due_date && (
                              <span className={isTaskOverdueActive(task) ? 'text-red-400' : 'text-gray-500'}>
                                {task.due_date}
                              </span>
                            )}
                            {timeLogged && (
                              <span className="text-gray-500 inline-flex items-center gap-0.5">
                                <Timer className="w-3 h-3 shrink-0" />
                                {timeLogged}
                              </span>
                            )}
                          </div>
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ProjectTimeLogsPanel({
  projectId,
  logs,
  loading,
  totalMinutes,
  billedMinutes,
  onRefresh,
}: {
  projectId: string
  logs: ProjectTimeLog[]
  loading: boolean
  totalMinutes: number
  billedMinutes: number
  onRefresh: () => void
}) {
  const unbilledMinutes = totalMinutes - billedMinutes
  const hasRates = logs.some(t => t.hourly_rate != null)

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm min-w-0">
          <span className="text-gray-300 whitespace-nowrap">
            Total: <strong className="text-white">{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m</strong>
          </span>
          <span className="text-gray-400 whitespace-nowrap">
            Billed: <strong className="text-green-400">{Math.floor(billedMinutes / 60)}h {billedMinutes % 60}m</strong>
          </span>
          <span className="text-gray-400 whitespace-nowrap">
            Unbilled: <strong className="text-yellow-400">{Math.floor(unbilledMinutes / 60)}h {unbilledMinutes % 60}m</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Link to={`/timesheets?project=${projectId}`} className="text-xs text-accent hover:underline whitespace-nowrap">View all timesheets</Link>
          <button type="button" onClick={onRefresh} disabled={loading}
            className="px-2 py-1.5 rounded-lg border border-border text-xs text-gray-400 hover:text-white hover:bg-surface-muted disabled:opacity-50 shrink-0">
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading time logs…</p>
      ) : logs.length === 0 ? (
        <p className="text-gray-500 text-sm">No time logged on this project yet. Log time from a task or the timesheets page.</p>
      ) : (
        <>
          <div className="md:hidden space-y-3">
            {logs.map(t => (
              <div key={t.id} className="rounded-lg border border-border bg-surface-elevated p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/projects/${projectId}/tasks/${t.task_id}`} className="text-sm font-medium text-accent hover:underline break-words">
                      {t.task_title ?? 'Task'}
                    </Link>
                    <p className="text-xs text-gray-500 mt-0.5">{t.work_date}</p>
                  </div>
                  <span className="text-sm text-white font-medium shrink-0">
                    {String(t.hours).padStart(2, '0')}:{String(t.minutes).padStart(2, '0')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-gray-400">{t.display_name ?? 'User'}</span>
                  {hasRates && t.hourly_rate != null && (
                    <span className="text-gray-500">${Number(t.hourly_rate).toFixed(2)}/hr</span>
                  )}
                  {t.billed
                    ? <span className="inline-flex px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ Billed</span>
                    : <span className="inline-flex px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-500">○ Unbilled</span>}
                </div>
                {t.description && (
                  <p className="text-xs text-gray-400 break-words">{t.description}</p>
                )}
              </div>
            ))}
          </div>

          <div className="hidden md:block rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="border-b border-border text-xs text-gray-500 bg-surface-muted/50">
                  <th className="text-left px-4 py-2 whitespace-nowrap">Date</th>
                  <th className="text-left px-4 py-2">Task</th>
                  <th className="text-left px-4 py-2 whitespace-nowrap">Who</th>
                  <th className="text-left px-4 py-2 whitespace-nowrap">Time</th>
                  <th className="text-left px-4 py-2">Notes</th>
                  {hasRates && <th className="text-right px-4 py-2 whitespace-nowrap">Rate</th>}
                  <th className="text-center px-4 py-2 whitespace-nowrap">Billed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {logs.map(t => (
                  <tr key={t.id} className="hover:bg-surface-muted/30">
                    <td className="px-4 py-2 text-gray-300 whitespace-nowrap">{t.work_date}</td>
                    <td className="px-4 py-2 max-w-[180px]">
                      <Link to={`/projects/${projectId}/tasks/${t.task_id}`} className="text-accent hover:underline truncate block">
                        {t.task_title ?? 'Task'}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{t.display_name ?? 'User'}</td>
                    <td className="px-4 py-2 text-white font-medium whitespace-nowrap">
                      {String(t.hours).padStart(2, '0')}:{String(t.minutes).padStart(2, '0')}
                    </td>
                    <td className="px-4 py-2 text-gray-400 max-w-[200px] truncate" title={t.description ?? undefined}>
                      {t.description ?? '—'}
                    </td>
                    {hasRates && (
                      <td className="px-4 py-2 text-right text-gray-400 whitespace-nowrap">
                        {t.hourly_rate != null ? `$${Number(t.hourly_rate).toFixed(2)}/hr` : '—'}
                      </td>
                    )}
                    <td className="px-4 py-2 text-center whitespace-nowrap">
                      {t.billed
                        ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-green-500/20 text-green-400">✓ Billed</span>
                        : <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-500/20 text-gray-500">○ Unbilled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function SlackChannelPicker({ projectId, orgId }: { projectId: string; orgId: string }) {
  const [channel, setChannel] = useState<{
    channel_id: string
    channel_name: string
    workspace_domain: string | null
    is_private: boolean
  } | null>(null)
  const [channels, setChannels] = useState<{ id: string; name: string; is_private: boolean; is_member: boolean }[]>([])
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(null)
  const [channelQuery, setChannelQuery] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  const loadChannel = useCallback(async () => {
    if (!projectId) return
    const { data } = await supabase
      .from('slack_project_channels')
      .select('channel_id, channel_name, workspace_domain, is_private')
      .eq('project_id', projectId)
      .limit(1)
    const row = data?.[0] as {
      channel_id: string
      channel_name: string | null
      workspace_domain: string | null
      is_private: boolean | null
    } | undefined
    if (row?.channel_id) {
      setChannel({
        channel_id: row.channel_id,
        channel_name: row.channel_name ?? row.channel_id,
        workspace_domain: row.workspace_domain ?? null,
        is_private: row.is_private ?? false,
      })
      setChannelQuery((row.channel_name ?? '').replace(/^#/, ''))
    } else {
      setChannel(null)
      setChannelQuery('')
    }
  }, [projectId])

  const loadSlackChannels = useCallback(async () => {
    if (!orgId) return
    setLoadingChannels(true)
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/slack-channels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ orgId }),
    })
    const data = await res.json().catch(() => ({})) as {
      error?: string
      workspaceDomain?: string | null
      channels?: { id: string; name: string; is_private: boolean; is_member: boolean }[]
    }
    if (!res.ok || data.error) {
      setMessage({ type: 'error', text: data.error || 'Unable to load Slack channels.' })
      setChannels([])
      setWorkspaceDomain(null)
      setLoadingChannels(false)
      return
    }
    setChannels(data.channels ?? [])
    setWorkspaceDomain(data.workspaceDomain ?? null)
    setLoadingChannels(false)
  }, [orgId])

  useEffect(() => { loadChannel(); loadSlackChannels() }, [loadChannel, loadSlackChannels])

  const handleAdd = async () => {
    setMessage(null)
    const normalizedQuery = channelQuery.trim().toLowerCase().replace(/^#/, '')
    if (!normalizedQuery) return
    const selected = channels.find((c) => c.name.toLowerCase() === normalizedQuery)
    if (!selected) {
      setMessage({ type: 'error', text: 'Please choose a Slack channel.' })
      return
    }
    if (!selected.is_member) {
      setMessage({ type: 'error', text: 'jolo does not have access to this channel.' })
      return
    }
    setSaving(true)
    try {
      const channelLabel = `#${selected.name.toLowerCase().replace(/\s+/g, '')}`
      await supabase.from('slack_project_channels').delete().eq('project_id', projectId)
      const { error } = await supabase.from('slack_project_channels').insert({
        project_id: projectId,
        channel_id: selected.id,
        channel_name: channelLabel,
        workspace_domain: workspaceDomain ? workspaceDomain.toLowerCase() : null,
        is_private: selected.is_private,
      })
      if (error) {
        setMessage({ type: 'error', text: error.message || 'Failed to save Slack channel.' })
        return
      }

      setShowPicker(false)
      setChannelQuery(selected.name)
      setMessage({ type: 'success', text: 'Slack channel linked successfully.' })
      loadChannel()
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    setSaving(true)
    await supabase.from('slack_project_channels').delete().eq('project_id', projectId)
    setSaving(false)
    setChannel(null)
    setChannelQuery('')
    setShowPicker(true)
    setMessage(null)
  }

  const handleTest = async () => {
    if (!channel || !projectId) return
    setMessage(null)
    setTestLoading(true)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/slack-test-project-channel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ projectId }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string; msg?: string }
      if (!res.ok) {
        const err = data.error || data.message || data.msg
        if (res.status === 401) {
          setMessage({ type: 'error', text: err || 'Session expired. Sign out and back in, then try again.' })
        } else if (res.status === 404) {
          setMessage({ type: 'error', text: err || 'Slack test function not found. Deploy it: supabase functions deploy slack-test-project-channel' })
        } else {
          setMessage({ type: 'error', text: err || `Test failed (${res.status}).` })
        }
        setTestLoading(false)
        return
      }
      if (data.error) {
        setMessage({ type: 'error', text: data.error })
        setTestLoading(false)
        return
      }
      setMessage({ type: 'success', text: data.message || 'Test message sent. Check the Slack channel.' })
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message || 'Failed to send test.' })
    } finally {
      setTestLoading(false)
    }
  }

  const channelListId = `project-slack-channels-${projectId}`
  const channelDisplayName = (channel?.channel_name ?? '').replace(/^#/, '')
  const slackUrl = channel?.workspace_domain && channel?.channel_id
    ? `https://${channel.workspace_domain}.slack.com/archives/${channel.channel_id}`
    : null

  return (
    <section className="rounded-lg border border-border bg-surface-elevated p-4">
      <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3">Slack channel</h2>
      <p className="text-xs text-gray-500 mb-2">New emails from linked contacts and task updates will be posted here.</p>
      {message && (
        <p className={`text-xs mb-2 ${message.type === 'error' ? 'text-red-400' : 'text-accent'}`}>{message.text}</p>
      )}
      {channel ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between py-1.5 text-sm">
            {slackUrl ? (
              <a href={slackUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline truncate inline-flex items-center gap-1.5">
                {channel.is_private ? <Lock className="w-3.5 h-3.5 shrink-0" /> : <Hash className="w-3.5 h-3.5 shrink-0" />}
                <span>{channelDisplayName}</span>
              </a>
            ) : (
              <span className="text-white truncate inline-flex items-center gap-1.5">
                {channel.is_private ? <Lock className="w-3.5 h-3.5 shrink-0" /> : <Hash className="w-3.5 h-3.5 shrink-0" />}
                <span>{channelDisplayName}</span>
              </span>
            )}
            <button type="button" onClick={handleRemove} disabled={saving} className="p-1 text-gray-500 hover:text-red-400" title="Remove channel"><X className="w-3 h-3" /></button>
          </div>
          <button
            type="button"
            onClick={handleTest}
            disabled={testLoading}
            className="px-2 py-1.5 rounded-lg border border-border text-xs text-gray-300 hover:bg-surface-muted hover:text-white disabled:opacity-50"
          >
            {testLoading ? 'Sending…' : 'Test'}
          </button>
        </div>
      ) : (
        null
      )}
      {(!channel || showPicker) && (
        <div className="space-y-2">
          <input
            type="text"
            list={channelListId}
            value={channelQuery}
            onChange={(e) => setChannelQuery(e.target.value.toLowerCase().replace(/\s+/g, ''))}
            placeholder="Select or type channel name…"
            className="w-full rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-xs placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <datalist id={channelListId}>
            {channels.map((c) => (
              <option
                key={c.id}
                value={c.name}
                label={`${c.is_private ? 'private (lock)' : 'public (#)'}${c.is_member ? '' : ' - no access'}`}
              />
            ))}
          </datalist>
          {loadingChannels && <p className="text-xs text-gray-500">Loading channels…</p>}
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !channelQuery.trim() || loadingChannels}
            className="px-2 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50 shrink-0"
          >
            {saving ? 'Saving…' : channel ? 'Update' : 'Add'}
          </button>
        </div>
      )}
    </section>
  )
}
