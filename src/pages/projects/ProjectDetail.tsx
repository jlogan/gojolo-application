import { useEffect, useState, useCallback } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  FolderKanban, Pencil, ArrowLeft, Plus, Trash2, Users, Building2, User,
  CheckCircle2, Circle, Clock, Upload, Paperclip, X,
} from 'lucide-react'
import type { Project } from './ProjectsList'

type Task = {
  id: string; title: string; status: string; priority: string;
  due_date: string | null; assigned_to: string | null; description: string | null
}
type Member = { user_id: string; role: string; display_name: string | null }
type CompanyRow = { company_id: string; name: string }
type ContactRow = { contact_id: string; name: string; email: string | null }
type OrgUser = { user_id: string; display_name: string | null }
type Attachment = { id: string; task_id: string; file_name: string; file_path: string; file_size: number | null; created_at: string }

const STATUS_ICON: Record<string, typeof Circle> = { todo: Circle, in_progress: Clock, done: CheckCircle2 }
const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-gray-400', medium: 'text-yellow-400', high: 'text-orange-400', urgent: 'text-red-400',
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
  const [taskAssigned, setTaskAssigned] = useState('')
  const [taskSaving, setTaskSaving] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)

  // Add member
  const [addMemberUserId, setAddMemberUserId] = useState('')

  // Add company / contact
  const [allCompanies, setAllCompanies] = useState<{ id: string; name: string }[]>([])
  const [allContacts, setAllContacts] = useState<{ id: string; name: string; email: string | null }[]>([])
  const [addCompanyId, setAddCompanyId] = useState('')
  const [addContactId, setAddContactId] = useState('')

  // Attachments
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [selectedTaskForUpload, setSelectedTaskForUpload] = useState<string | null>(null)

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
    const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', uids)
    const profileMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]))
    setMembers(rows.map(r => ({ ...r, display_name: profileMap.get(r.user_id) ?? null })))
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
    const { data } = await supabase.from('organization_users').select('user_id, profiles(display_name)').eq('org_id', currentOrg.id)
    setOrgUsers((data ?? []).map((r: { user_id: string; profiles: { display_name: string | null } | { display_name: string | null }[] | null }) => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
      return { user_id: r.user_id, display_name: p?.display_name ?? null }
    }))
  }, [currentOrg?.id])

  const fetchAllCompaniesContacts = useCallback(async () => {
    if (!currentOrg?.id) return
    const [{ data: cos }, { data: cons }] = await Promise.all([
      supabase.from('companies').select('id, name').eq('org_id', currentOrg.id).order('name'),
      supabase.from('contacts').select('id, name, email').eq('org_id', currentOrg.id).order('name'),
    ])
    setAllCompanies((cos as { id: string; name: string }[]) ?? [])
    setAllContacts((cons as { id: string; name: string; email: string | null }[]) ?? [])
  }, [currentOrg?.id])

  const fetchAttachments = useCallback(async () => {
    if (!id) return
    const taskIds = tasks.map(t => t.id)
    if (taskIds.length === 0) { setAttachments([]); return }
    const { data } = await supabase.from('task_attachments').select('*').in('task_id', taskIds).order('created_at', { ascending: false })
    setAttachments((data as Attachment[]) ?? [])
  }, [id, tasks])

  useEffect(() => { fetchProject() }, [fetchProject])
  useEffect(() => { fetchTasks() }, [fetchTasks])
  useEffect(() => { fetchMembers() }, [fetchMembers])
  useEffect(() => { fetchLinked() }, [fetchLinked])
  useEffect(() => { fetchOrgUsers() }, [fetchOrgUsers])
  useEffect(() => { fetchAllCompaniesContacts() }, [fetchAllCompaniesContacts])
  useEffect(() => { fetchAttachments() }, [fetchAttachments])

  const resetTaskForm = () => {
    setTaskTitle(''); setTaskDesc(''); setTaskStatus('todo'); setTaskPriority('medium'); setTaskDue(''); setTaskAssigned('')
    setEditingTaskId(null); setShowTaskForm(false)
  }

  const handleTaskSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !currentOrg?.id) return
    setTaskSaving(true)
    const payload = {
      project_id: id, org_id: currentOrg.id, title: taskTitle.trim(),
      description: taskDesc.trim() || null, status: taskStatus, priority: taskPriority,
      due_date: taskDue || null, assigned_to: taskAssigned || null, updated_at: new Date().toISOString(),
    }
    if (editingTaskId) {
      await supabase.from('tasks').update(payload).eq('id', editingTaskId)
    } else {
      await supabase.from('tasks').insert({ ...payload, created_by: user?.id ?? null })
    }
    resetTaskForm()
    setTaskSaving(false)
    fetchTasks()
  }

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Delete this task?')) return
    await supabase.from('tasks').delete().eq('id', taskId)
    fetchTasks()
  }

  const startEditTask = (t: Task) => {
    setEditingTaskId(t.id); setTaskTitle(t.title); setTaskDesc(t.description ?? '')
    setTaskStatus(t.status); setTaskPriority(t.priority); setTaskDue(t.due_date ?? '')
    setTaskAssigned(t.assigned_to ?? ''); setShowTaskForm(true)
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
    await supabase.from('project_companies').insert({ project_id: id, company_id: addCompanyId })
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
    const { error: upErr } = await supabase.storage.from('task-attachments').upload(path, file)
    if (upErr) { console.error(upErr); setUploading(false); return }
    await supabase.from('task_attachments').insert({
      task_id: taskId, file_name: file.name, file_path: path,
      file_size: file.size, content_type: file.type, uploaded_by: user?.id ?? null,
    })
    setUploading(false)
    setSelectedTaskForUpload(null)
    fetchAttachments()
  }

  const handleDeleteAttachment = async (att: Attachment) => {
    await supabase.storage.from('task-attachments').remove([att.file_path])
    await supabase.from('task_attachments').delete().eq('id', att.id)
    fetchAttachments()
  }

  const getDownloadUrl = (path: string) => {
    const { data } = supabase.storage.from('task-attachments').getPublicUrl(path)
    return data.publicUrl
  }

  const getUserName = (uid: string | null) => {
    if (!uid) return 'Unassigned'
    return orgUsers.find(u => u.user_id === uid)?.display_name ?? uid.slice(0, 8)
  }

  if (loading) return <div className="p-4 md:p-6 text-surface-muted">Loading…</div>
  if (!project) return (
    <div className="p-4 md:p-6">
      <p className="text-surface-muted">Project not found.</p>
      <Link to="/projects" className="text-accent hover:underline mt-2 inline-block">Back to projects</Link>
    </div>
  )

  const availableUsersForMember = orgUsers.filter(u => !members.some(m => m.user_id === u.user_id))

  return (
    <div className="p-4 md:p-6" data-testid="project-detail">
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
            </div>
          </div>
          <button type="button" onClick={() => navigate(`/projects/${project.id}/edit`)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-surface-muted">
            <Pencil className="w-4 h-4" /> Edit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tasks column (2/3) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Tasks ({tasks.length})</h2>
            <button type="button" onClick={() => { resetTaskForm(); setShowTaskForm(true) }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90">
              <Plus className="w-3.5 h-3.5" /> Add task
            </button>
          </div>

          {showTaskForm && (
            <form onSubmit={handleTaskSubmit} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
              <input type="text" required value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task title"
                className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
              <textarea value={taskDesc} onChange={e => setTaskDesc(e.target.value)} rows={2} placeholder="Description (optional)"
                className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent resize-y" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <select value={taskStatus} onChange={e => setTaskStatus(e.target.value)}
                  className="rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
                </select>
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}
                  className="rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select>
                <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)}
                  className="rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                <select value={taskAssigned} onChange={e => setTaskAssigned(e.target.value)}
                  className="rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">Unassigned</option>
                  {orgUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name ?? u.user_id.slice(0, 8)}</option>)}
                </select>
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
          ) : (
            <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden">
              {tasks.map(t => {
                const Icon = STATUS_ICON[t.status] ?? Circle
                const taskAtts = attachments.filter(a => a.task_id === t.id)
                return (
                  <li key={t.id} className="p-3 hover:bg-surface-muted/50 transition-colors">
                    <div className="flex items-start gap-3">
                      <button type="button" title="Toggle status" onClick={async () => {
                        const next = t.status === 'todo' ? 'in_progress' : t.status === 'in_progress' ? 'done' : 'todo'
                        await supabase.from('tasks').update({ status: next }).eq('id', t.id)
                        fetchTasks()
                      }} className="mt-0.5 shrink-0">
                        <Icon className={`w-5 h-5 ${t.status === 'done' ? 'text-green-400' : t.status === 'in_progress' ? 'text-accent' : 'text-gray-500'}`} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`font-medium text-sm ${t.status === 'done' ? 'line-through text-gray-500' : 'text-white'}`}>{t.title}</p>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button type="button" title="Upload file" onClick={() => setSelectedTaskForUpload(selectedTaskForUpload === t.id ? null : t.id)}
                              className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted"><Upload className="w-3.5 h-3.5" /></button>
                            <button type="button" title="Edit task" onClick={() => startEditTask(t)}
                              className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-muted"><Pencil className="w-3.5 h-3.5" /></button>
                            <button type="button" title="Delete task" onClick={() => handleDeleteTask(t.id)}
                              className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-surface-muted"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                        {t.description && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{t.description}</p>}
                        <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
                          <span className={PRIORITY_COLORS[t.priority] ?? 'text-gray-400'}>{t.priority}</span>
                          {t.due_date && <span className="text-gray-500">{t.due_date}</span>}
                          {t.assigned_to && <span className="text-gray-400">{getUserName(t.assigned_to)}</span>}
                          {taskAtts.length > 0 && <span className="text-gray-500 flex items-center gap-0.5"><Paperclip className="w-3 h-3" />{taskAtts.length}</span>}
                        </div>
                        {taskAtts.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {taskAtts.map(a => (
                              <div key={a.id} className="flex items-center gap-2 text-xs">
                                <Paperclip className="w-3 h-3 text-gray-500" />
                                <a href={getDownloadUrl(a.file_path)} target="_blank" rel="noreferrer" className="text-accent hover:underline truncate">{a.file_name}</a>
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
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Sidebar (1/3) */}
        <div className="space-y-6">
          {/* Team */}
          <section className="rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><Users className="w-4 h-4" /> Team ({members.length})</h2>
            {members.map(m => (
              <div key={m.user_id} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-white truncate">{m.display_name ?? m.user_id.slice(0, 8)}</span>
                <div className="flex items-center gap-1">
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

          {/* Companies */}
          <section className="rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><Building2 className="w-4 h-4" /> Companies ({companies.length})</h2>
            {companies.map(c => (
              <div key={c.company_id} className="flex items-center justify-between py-1.5 text-sm">
                <Link to={`/companies/${c.company_id}`} className="text-accent hover:underline truncate">{c.name}</Link>
                <button type="button" onClick={() => handleRemoveCompany(c.company_id)} className="p-1 text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <select value={addCompanyId} onChange={e => setAddCompanyId(e.target.value)}
                className="flex-1 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="">Link company…</option>
                {allCompanies.filter(c => !companies.some(pc => pc.company_id === c.id)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={handleAddCompany} disabled={!addCompanyId}
                className="px-2 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50">Add</button>
            </div>
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
                {allContacts.filter(c => !contacts.some(pc => pc.contact_id === c.id)).map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ''}</option>)}
              </select>
              <button type="button" onClick={handleAddContact} disabled={!addContactId}
                className="px-2 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50">Add</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
