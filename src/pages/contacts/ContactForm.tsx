import { useEffect, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft } from 'lucide-react'

export default function ContactForm() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const isEdit = Boolean(id)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [type, setType] = useState('primary')
  const [companyId, setCompanyId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    if (!currentOrg?.id) return
    supabase
      .from('companies')
      .select('id, name')
      .eq('org_id', currentOrg.id)
      .order('name')
      .then(({ data }) => setCompanies((data as { id: string; name: string }[]) ?? []))
  }, [currentOrg?.id])

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    supabase
      .from('contacts')
      .select('name, email, phone, type, company_id')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setName((data as { name: string }).name ?? '')
          setEmail((data as { email: string }).email ?? '')
          setPhone((data as { phone: string }).phone ?? '')
          setType((data as { type: string }).type ?? 'primary')
          setCompanyId((data as { company_id: string }).company_id ?? '')
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
      email: email.trim() || null,
      phone: phone.trim() || null,
      type: type || 'primary',
      company_id: companyId || null,
    }
    if (isEdit && id) {
      const { error } = await supabase.from('contacts').update(payload).eq('id', id).eq('org_id', currentOrg.id)
      if (error) console.error(error)
      else navigate(`/contacts/${id}`)
    } else {
      const { data, error } = await supabase.from('contacts').insert(payload).select('id').single()
      if (error) console.error(error)
      else if (data) navigate(`/contacts/${(data as { id: string }).id}`)
    }
    setSaving(false)
  }

  return (
    <div className="p-4 md:p-6 max-w-xl" data-testid="contact-form">
      <Link
        to={isEdit ? `/contacts/${id}` : '/contacts'}
        className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-6"
        data-testid="contact-form-back"
      >
        <ArrowLeft className="w-4 h-4" />
        {isEdit ? 'Back to contact' : 'Contacts'}
      </Link>
      <h1 className="text-xl font-semibold text-white mb-6">
        {isEdit ? 'Edit contact' : 'New contact'}
      </h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="contact-name" className="block text-sm font-medium text-gray-300 mb-1">
            Name
          </label>
          <input
            id="contact-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Full name"
            data-testid="contact-name-input"
          />
        </div>
        <div>
          <label htmlFor="contact-email" className="block text-sm font-medium text-gray-300 mb-1">
            Email
          </label>
          <input
            id="contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="email@example.com"
            data-testid="contact-email-input"
          />
        </div>
        <div>
          <label htmlFor="contact-phone" className="block text-sm font-medium text-gray-300 mb-1">
            Phone
          </label>
          <input
            id="contact-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="+1 234 567 8900"
            data-testid="contact-phone-input"
          />
        </div>
        <div>
          <label htmlFor="contact-type" className="block text-sm font-medium text-gray-300 mb-1">
            Type
          </label>
          <select
            id="contact-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent"
            data-testid="contact-type-select"
          >
            <option value="primary">Primary</option>
            <option value="billing">Billing</option>
            <option value="technical">Technical</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label htmlFor="contact-company" className="block text-sm font-medium text-gray-300 mb-1">
            Company
          </label>
          <select
            id="contact-company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent"
            data-testid="contact-company-select"
          >
            <option value="">None</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 disabled:opacity-50"
            data-testid="contact-submit"
          >
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </button>
          <Link
            to={isEdit ? `/contacts/${id}` : '/contacts'}
            className="px-4 py-2.5 rounded-lg border border-border hover:bg-surface-muted"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
