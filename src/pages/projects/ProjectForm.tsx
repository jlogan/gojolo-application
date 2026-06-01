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
  const [status, setStatus] = useState('not_started')
  const [dueDate, setDueDate] = useState('')
  const [billingType, setBillingType] = useState('fixed')
  const [projectCost, setProjectCost] = useState('')
  const [hourlyRate, setHourlyRate] = useState('')
  const [estimatedHours, setEstimatedHours] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    supabase
      .from('projects')
      .select('name, description, status, due_date, billing_type, project_cost, hourly_rate, estimated_hours')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
      .then(({ data }) => {
        if (data) {
          const d = data as { name: string; description: string | null; status: string; due_date: string | null; billing_type: string | null; project_cost: number | null; hourly_rate: number | null; estimated_hours: number | null }
          setName(d.name ?? '')
          setDescription(d.description ?? '')
          setStatus(d.status ?? 'not_started')
          setDueDate(d.due_date ?? '')
          setBillingType(d.billing_type ?? 'fixed')
          setProjectCost(d.project_cost != null ? String(d.project_cost) : '')
          setHourlyRate(d.hourly_rate != null ? String(d.hourly_rate) : '')
          setEstimatedHours(d.estimated_hours != null ? String(d.estimated_hours) : '')
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
      billing_type: billingType,
      project_cost: billingType === 'fixed' && projectCost ? parseFloat(projectCost) : null,
      hourly_rate: billingType !== 'fixed' && hourlyRate ? parseFloat(hourlyRate) : null,
      estimated_hours: estimatedHours ? parseFloat(estimatedHours) : null,
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
        <div>
          <label htmlFor="project-status" className="block text-sm font-medium text-gray-300 mb-1">Status</label>
          <select
            id="project-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="not_started">Not Started</option>
            <option value="in_progress">In Progress</option>
            <option value="on_hold">On Hold</option>
            <option value="finished">Finished</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div>
          <label htmlFor="project-billing-type" className="block text-sm font-medium text-gray-300 mb-1">Billing Type</label>
          <select
            id="project-billing-type"
            value={billingType}
            onChange={(e) => setBillingType(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="fixed">Fixed Rate</option>
            <option value="project_hours">Project Hours</option>
            <option value="task_hours">Task Hours</option>
          </select>
        </div>
        {billingType === 'fixed' && (
          <div>
            <label htmlFor="project-cost" className="block text-sm font-medium text-gray-300 mb-1">Project Cost ($)</label>
            <input
              id="project-cost"
              type="number"
              step="0.01"
              min="0"
              value={projectCost}
              onChange={(e) => setProjectCost(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="0.00"
            />
          </div>
        )}
        {billingType !== 'fixed' && (
          <div>
            <label htmlFor="hourly-rate" className="block text-sm font-medium text-gray-300 mb-1">Hourly Rate ($)</label>
            <input
              id="hourly-rate"
              type="number"
              step="0.01"
              min="0"
              value={hourlyRate}
              onChange={(e) => setHourlyRate(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="0.00"
            />
          </div>
        )}
        <div>
          <label htmlFor="estimated-hours" className="block text-sm font-medium text-gray-300 mb-1">Estimated Hours</label>
          <input
            id="estimated-hours"
            type="number"
            step="0.5"
            min="0"
            value={estimatedHours}
            onChange={(e) => setEstimatedHours(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="0"
          />
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
