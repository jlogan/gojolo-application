import { useEffect, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { User, Mail, Phone, Building2, Pencil, ArrowLeft } from 'lucide-react'
import type { Contact } from './ContactsList'

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const [contact, setContact] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    let cancelled = false
    setLoading(true)
    supabase
      .from('contacts')
      .select('id, org_id, company_id, type, name, email, phone, meta, created_at')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data) setContact(null)
        else setContact(data as Contact)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, currentOrg?.id])

  if (loading) {
    return (
      <div className="p-4 md:p-6" data-testid="contact-detail-loading">
        Loading…
      </div>
    )
  }

  if (!contact) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-surface-muted">Contact not found.</p>
        <Link to="/contacts" className="text-accent hover:underline mt-2 inline-block">
          Back to contacts
        </Link>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6" data-testid="contact-detail">
      <div className="mb-6">
        <Link
          to="/contacts"
          className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-4"
          data-testid="contact-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Contacts
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-surface-muted flex items-center justify-center shrink-0">
              <User className="w-7 h-7 text-surface-muted" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">{contact.name}</h1>
              {contact.email && (
                <p className="text-surface-muted text-sm flex items-center gap-1 mt-0.5">
                  <Mail className="w-3.5 h-3.5" />
                  {contact.email}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/contacts/${contact.id}/edit`)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-surface-muted"
            data-testid="contact-edit"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </button>
        </div>
      </div>

      <dl className="space-y-4 rounded-lg border border-border p-4 bg-surface-elevated">
        <div>
          <dt className="text-xs font-medium text-surface-muted uppercase tracking-wider">Type</dt>
          <dd className="mt-1 text-white">{contact.type || '—'}</dd>
        </div>
        {contact.phone && (
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-surface-muted" />
            <span>{contact.phone}</span>
          </div>
        )}
        {contact.company_id && (
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-surface-muted" />
            <Link
              to={`/companies/${contact.company_id}`}
              className="text-accent hover:underline"
              data-testid="contact-company-link"
            >
              View company
            </Link>
          </div>
        )}
      </dl>
    </div>
  )
}
