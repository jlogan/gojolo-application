import { useEffect, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft } from 'lucide-react'

export default function ProjectForm() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const isEdit = Boolean(id)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState('active')
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    supabase
      .from('projects')
      .select('name, description, status, due_date')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
      .then(({ data }) => {
        if (data) {
          const d = data as { name: string; description: string | null; status: string; due_date: string | null }
          setName(d.name ?? '')
          setDescription(d.description ?? '')
          setStatus(d.status ?? 'active')
          setDueDate(d.due_date ?? '')
        }
      })
  }, [id, currentOrg?.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id) return
    setSaving(true)
    const payload = {
      org_id: currentOrg.id,
      name: name.trim(),
      description: description.trim() || null,
      status,
      due_date: dueDate || null,
      updated_at: new Date().toISOString(),
    }
    if (isEdit && id) {
      const { error } = await supabase.from('projects').update(payload).eq('id', id).eq('org_id', currentOrg.id)
      if (error) console.error(error)
      else navigate(`/projects/${id}`)
    } else {
      const { data, error } = await supabase
        .from('projects')
        .insert({ ...payload, created_by: user?.id ?? null })
        .select('id')
        .single()
      if (error) console.error(error)
      else if (data) {
        const newId = (data as { id: string }).id
        if (user?.id) {
          await supabase.from('project_members').insert({ project_id: newId, user_id: user.id, role: 'owner' })
        }
        navigate(`/projects/${newId}`)
      }
    }
    setSaving(false)
  }

  return (
    <div className="p-4 md:p-6 max-w-xl" data-testid="project-form">
      <Link
        to={isEdit ? `/projects/${id}` : '/projects'}
        className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        {isEdit ? 'Back to project' : 'Projects'}
      </Link>
      <h1 className="text-xl font-semibold text-white mb-6">
        {isEdit ? 'Edit project' : 'New project'}
      </h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="project-name" className="block text-sm font-medium text-gray-300 mb-1">Name</label>
          <input
            id="project-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Project name"
          />
        </div>
        <div>
          <label htmlFor="project-desc" className="block text-sm font-medium text-gray-300 mb-1">Description</label>
          <textarea
            id="project-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent resize-y"
            placeholder="Brief description…"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="project-status" className="block text-sm font-medium text-gray-300 mb-1">Status</label>
            <select
              id="project-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label htmlFor="project-due" className="block text-sm font-medium text-gray-300 mb-1">Due date</label>
            <input
              id="project-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </button>
          <Link
            to={isEdit ? `/projects/${id}` : '/projects'}
            className="px-4 py-2.5 rounded-lg border border-border hover:bg-surface-muted"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
