import { useEffect, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft } from 'lucide-react'

export default function CompanyForm() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const isEdit = Boolean(id)
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    supabase
      .from('companies')
      .select('name, industry')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setName((data as { name: string }).name ?? '')
          setIndustry((data as { industry: string }).industry ?? '')
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
      industry: industry.trim() || null,
    }
    if (isEdit && id) {
      const { error } = await supabase.from('companies').update(payload).eq('id', id).eq('org_id', currentOrg.id)
      if (error) console.error(error)
      else navigate(`/companies/${id}`)
    } else {
      const { data, error } = await supabase.from('companies').insert(payload).select('id').single()
      if (error) console.error(error)
      else if (data) navigate(`/companies/${(data as { id: string }).id}`)
    }
    setSaving(false)
  }

  return (
    <div className="p-4 md:p-6 max-w-xl" data-testid="company-form">
      <Link
        to={isEdit ? `/companies/${id}` : '/companies'}
        className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-6"
        data-testid="company-form-back"
      >
        <ArrowLeft className="w-4 h-4" />
        {isEdit ? 'Back to company' : 'Companies'}
      </Link>
      <h1 className="text-xl font-semibold text-white mb-6">
        {isEdit ? 'Edit company' : 'New company'}
      </h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="company-name" className="block text-sm font-medium text-gray-300 mb-1">
            Name
          </label>
          <input
            id="company-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Company name"
            data-testid="company-name-input"
          />
        </div>
        <div>
          <label htmlFor="company-industry" className="block text-sm font-medium text-gray-300 mb-1">
            Industry
          </label>
          <input
            id="company-industry"
            type="text"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="e.g. Technology, Healthcare"
            data-testid="company-industry-input"
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 disabled:opacity-50"
            data-testid="company-submit"
          >
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </button>
          <Link
            to={isEdit ? `/companies/${id}` : '/companies'}
            className="px-4 py-2.5 rounded-lg border border-border hover:bg-surface-muted"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
