import { useEffect, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { Building2, Users, Pencil, ArrowLeft } from 'lucide-react'
import type { Company } from './CompaniesList'

type ContactRow = { id: string; name: string; email: string | null }

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const [company, setCompany] = useState<Company | null>(null)
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    let cancelled = false
    setLoading(true)
    supabase
      .from('companies')
      .select('id, org_id, name, industry, meta, created_at')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data) setCompany(null)
        else setCompany(data as Company)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, currentOrg?.id])

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    supabase
      .from('contacts')
      .select('id, name, email')
      .eq('company_id', id)
      .eq('org_id', currentOrg!.id)
      .order('name')
      .then(({ data }) => setContacts((data as ContactRow[]) ?? []))
  }, [id, currentOrg?.id])

  if (loading) {
    return (
      <div className="p-4 md:p-6" data-testid="company-detail-loading">
        Loading…
      </div>
    )
  }

  if (!company) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-surface-muted">Company not found.</p>
        <Link to="/companies" className="text-accent hover:underline mt-2 inline-block">
          Back to companies
        </Link>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6" data-testid="company-detail">
      <div className="mb-6">
        <Link
          to="/companies"
          className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-4"
          data-testid="company-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Companies
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-lg bg-surface-muted flex items-center justify-center shrink-0">
              <Building2 className="w-7 h-7 text-surface-muted" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">{company.name}</h1>
              {company.industry && (
                <p className="text-surface-muted text-sm mt-0.5">{company.industry}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/companies/${company.id}/edit`)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-surface-muted"
            data-testid="company-edit"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </button>
        </div>
      </div>

      <section className="rounded-lg border border-border p-4 bg-surface-elevated mb-6">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3">
          <Users className="w-4 h-4" />
          Contacts ({contacts.length})
        </h2>
        {contacts.length === 0 ? (
          <>
            <p className="text-gray-400 text-sm">No contacts linked yet.</p>
            <Link
              to="/contacts/new"
              className="inline-block mt-2 text-accent hover:underline text-sm"
              data-testid="company-add-contact"
            >
              Add contact
            </Link>
          </>
        ) : (
          <ul className="space-y-2" data-testid="company-contacts-list">
            {contacts.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/contacts/${c.id}`}
                  className="block py-2 text-white hover:text-accent transition-colors"
                  data-testid={`company-contact-${c.id}`}
                >
                  {c.name}
                  {c.email && (
                    <span className="text-surface-muted text-sm ml-2">{c.email}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
