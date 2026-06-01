import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { Plus, Search } from 'lucide-react'

export type Contact = {
  id: string; org_id: string; company_id: string | null; type: string
  name: string; email: string | null; phone: string | null
  meta: Record<string, unknown> | null; created_at: string
  sourced_from_lead?: boolean | null
}

type Company = {
  id: string
  org_id: string
  name: string
  industry: string | null
  meta: Record<string, unknown> | null
  created_at: string
  sourced_from_lead?: boolean | null
}

type SourceFilter = 'all' | 'customers' | 'leads'

function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()
}

const COLORS = ['bg-accent/30', 'bg-purple-500/30', 'bg-blue-500/30', 'bg-orange-500/30', 'bg-pink-500/30', 'bg-green-500/30']

export default function ContactsList() {
  const { currentOrg } = useOrg()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') === 'contacts' ? 'contacts' : 'companies'
  const sourceParam = searchParams.get('source') as SourceFilter | null
  const sourceFilter: SourceFilter =
    sourceParam === 'customers' || sourceParam === 'leads' ? sourceParam : 'all'
  const [contacts, setContacts] = useState<Contact[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const setSourceFilter = (next: SourceFilter) => {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'all') nextParams.delete('source')
    else nextParams.set('source', next)
    setSearchParams(nextParams)
  }

  useEffect(() => {
    if (!currentOrg?.id) return
    let cancelled = false
    setLoading(true)
    supabase.from('contacts')
      .select('id, org_id, company_id, type, name, email, phone, meta, created_at, sourced_from_lead')
      .eq('org_id', currentOrg.id).order('name')
      .then(async ({ data, error }) => {
        if (cancelled) return
        setContacts(error ? [] : (data as Contact[]) ?? [])
        const { data: companyData, error: companyError } = await supabase
          .from('companies')
          .select('id, org_id, name, industry, meta, created_at, sourced_from_lead')
          .eq('org_id', currentOrg.id)
          .order('name')
        if (!cancelled) setCompanies(companyError ? [] : (companyData as Company[]) ?? [])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [currentOrg?.id])

  const bySource = (c: Contact) => {
    if (sourceFilter === 'all') return true
    const leadish = c.sourced_from_lead === true || c.type === 'lead'
    return sourceFilter === 'leads' ? leadish : !leadish
  }
  const filtered = (search.trim()
    ? contacts.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.email?.toLowerCase().includes(search.toLowerCase()))
    : contacts
  ).filter(bySource)

  return (
    <div className="p-4 md:p-6" data-testid="contacts-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold text-white">Contacts</h1>
        <Link to={activeTab === 'companies' ? '/companies/new' : '/contacts/new'}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white font-medium hover:opacity-90">
          <Plus className="w-4 h-4" /> {activeTab === 'companies' ? 'Add company' : 'Add contact'}
        </Link>
      </div>

      <div className="flex gap-1 mb-4 border-b border-border">
        <button
          type="button"
          onClick={() => {
            const p = new URLSearchParams(searchParams)
            p.set('tab', 'companies')
            setSearchParams(p)
          }}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'companies' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
        >
          Companies
        </button>
        <button
          type="button"
          onClick={() => {
            const p = new URLSearchParams(searchParams)
            p.set('tab', 'contacts')
            setSearchParams(p)
          }}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'contacts' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
        >
          Contacts
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs text-gray-500 self-center mr-1">Show:</span>
        {(['all', 'customers', 'leads'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSourceFilter(key)}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
              sourceFilter === key ? 'border-accent text-accent bg-accent/10' : 'border-border text-gray-400 hover:text-gray-200'
            }`}
          >
            {key === 'all' ? 'All' : key === 'customers' ? 'Customers' : 'Lead prospects'}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={activeTab === 'companies' ? 'Search companies…' : 'Search contacts…'}
          className="w-full rounded-lg border border-border bg-surface-muted pl-10 pr-4 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>

      {loading ? <div className="text-gray-400 text-sm">Loading…</div>
      : activeTab === 'contacts' ? (
        filtered.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
            <p className="font-medium text-gray-200">{search ? 'No matches' : 'No contacts yet'}</p>
            {!search && <Link to="/contacts/new" className="inline-block mt-3 text-accent hover:underline text-sm">Add contact</Link>}
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden" data-testid="contact-list">
            {filtered.map((c, i) => (
              <Link key={c.id} to={`/contacts/${c.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-surface-muted transition-colors border-b border-border last:border-b-0">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium text-white shrink-0 ${COLORS[i % COLORS.length]}`}>
                  {getInitials(c.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white text-sm truncate">{c.name}</p>
                  {c.email && <p className="text-xs text-gray-400 truncate">{c.email}</p>}
                </div>
                {c.phone && <span className="text-xs text-gray-500 hidden sm:block">{c.phone}</span>}
              </Link>
            ))}
          </div>
        )
      ) : (
        (() => {
          const companiesBySource = companies.filter((c) => {
            if (sourceFilter === 'all') return true
            const leadCo = c.sourced_from_lead === true
            return sourceFilter === 'leads' ? leadCo : !leadCo
          })
          const filteredCompanies = search.trim()
            ? companiesBySource.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || (c.industry ?? '').toLowerCase().includes(search.toLowerCase()))
            : companiesBySource
          if (filteredCompanies.length === 0) {
            return (
              <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
                <p className="font-medium text-gray-200">{search ? 'No matches' : 'No companies yet'}</p>
                {!search && <Link to="/companies/new" className="inline-block mt-3 text-accent hover:underline text-sm">Add company</Link>}
              </div>
            )
          }
          return (
            <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden" data-testid="company-list">
              {filteredCompanies.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/companies/${c.id}`}
                    className="flex items-center p-4 hover:bg-surface-muted transition-colors"
                    data-testid={`company-row-${c.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-white truncate">{c.name}</p>
                      {c.industry && <p className="text-sm text-surface-muted truncate">{c.industry}</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )
        })()
      )}
    </div>
  )
}
