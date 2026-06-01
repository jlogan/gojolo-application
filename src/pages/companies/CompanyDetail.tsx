import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { Users, Pencil, ArrowLeft, X, Trash2 } from 'lucide-react'
import type { Company } from './CompaniesList'

type ContactRow = { id: string; name: string; email: string | null; phone: string | null }
type SearchContact = { id: string; name: string; email: string | null; phone: string | null }

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const [company, setCompany] = useState<Company | null>(null)
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)
  const [quickName, setQuickName] = useState('')
  const [quickEmail, setQuickEmail] = useState('')
  const [quickPhone, setQuickPhone] = useState('')
  const [editingContactId, setEditingContactId] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchContact[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchContainerRef = useRef<HTMLDivElement>(null)

  const fetchCompany = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    const { data, error } = await supabase
      .from('companies')
      .select('id, org_id, name, industry, meta, created_at')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
    if (error || !data) setCompany(null)
    else setCompany(data as Company)
  }, [id, currentOrg?.id])

  const fetchContacts = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    const { data } = await supabase
      .from('contacts')
      .select('id, name, email, phone')
      .eq('company_id', id)
      .eq('org_id', currentOrg!.id)
      .order('name')
    setContacts((data as ContactRow[]) ?? [])
  }, [id, currentOrg?.id])

  useEffect(() => {
    if (!id || !currentOrg?.id) return
    let cancelled = false
    setLoading(true)
    fetchCompany().then(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, currentOrg?.id, fetchCompany])

  useEffect(() => { fetchContacts() }, [fetchContacts])

  useEffect(() => {
    if (!currentOrg?.id || !quickName.trim()) {
      setSearchResults([])
      return
    }
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(async () => {
      const q = quickName.trim().toLowerCase()
      const { data } = await supabase
        .from('contacts')
        .select('id, name, email, phone')
        .eq('org_id', currentOrg!.id)
        .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8)
      setSearchResults((data as SearchContact[]) ?? [])
      setShowSearch(true)
    }, 200)
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    }
  }, [quickName, currentOrg?.id])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) setShowSearch(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectExistingContact = (c: SearchContact) => {
    setQuickName(c.name)
    setQuickEmail(c.email ?? '')
    setQuickPhone(c.phone ?? '')
    setEditingContactId(c.id)
    setShowSearch(false)
    setSearchResults([])
  }

  const clearQuickForm = () => {
    setQuickName('')
    setQuickEmail('')
    setQuickPhone('')
    setEditingContactId(null)
    setSearchResults([])
    setShowSearch(false)
  }

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !currentOrg?.id) return
    const name = quickName.trim()
    if (!name) return
    setSaving(true)
    const payload = {
      name,
      email: quickEmail.trim() || null,
      phone: quickPhone.trim() || null,
      company_id: id,
      org_id: currentOrg.id,
      type: 'client',
    }
    if (editingContactId) {
      await supabase.from('contacts').update(payload).eq('id', editingContactId).eq('org_id', currentOrg.id)
    } else {
      await supabase.from('contacts').insert(payload)
    }
    clearQuickForm()
    fetchContacts()
    setSaving(false)
  }

  const handleRemoveContact = async (contactId: string) => {
    if (!id) return
    await supabase.from('contacts').update({ company_id: null }).eq('id', contactId).eq('org_id', currentOrg!.id)
    fetchContacts()
  }

  const handleDeleteCompany = async () => {
    if (!id || !currentOrg?.id || !company) return
    setDeleting(true)
    const { error } = await supabase.from('companies').delete().eq('id', id).eq('org_id', currentOrg.id)
    setDeleting(false)
    if (error) {
      alert(`Could not delete company: ${error.message}`)
      return
    }
    navigate('/contacts?tab=companies')
  }

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
        <Link to="/contacts?tab=companies" className="text-accent hover:underline mt-2 inline-block">
          Back to companies
        </Link>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6" data-testid="company-detail">
      <div className="mb-6">
        <Link
          to="/contacts?tab=companies"
          className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-4"
          data-testid="company-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Companies
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-white">{company.name}</h1>
            {company.industry && (
              <p className="text-surface-muted text-sm mt-0.5">{company.industry}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/companies/${company.id}/edit`)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-surface-muted"
              data-testid="company-edit"
            >
              <Pencil className="w-4 h-4" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-500/40 text-red-400 hover:bg-red-500/10"
              data-testid="company-delete"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        </div>
      </div>

      <section className="rounded-lg border border-border p-4 bg-surface-elevated mb-6">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3">
          <Users className="w-4 h-4" />
          Contacts ({contacts.length})
        </h2>
        <p className="text-gray-500 text-xs mb-3">Add contacts or link existing ones by searching by name. They’ll be auto-added to projects linked to this company.</p>
        {contacts.length === 0 ? (
          <p className="text-gray-400 text-sm">No contacts linked yet.</p>
        ) : (
          <ul className="space-y-1 mb-4" data-testid="company-contacts-list">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2 border-b border-border last:border-b-0">
                <Link
                  to={`/contacts/${c.id}/edit`}
                  className="min-w-0 flex-1 text-white hover:text-accent transition-colors truncate"
                  data-testid={`company-contact-${c.id}`}
                >
                  <span className="font-medium">{c.name}</span>
                  {(c.email || c.phone) && (
                    <span className="text-gray-400 text-sm ml-2">
                      {[c.email, c.phone].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </Link>
                <button
                  type="button"
                  onClick={() => handleRemoveContact(c.id)}
                  className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-surface-muted shrink-0"
                  title="Remove from company"
                  aria-label={`Remove ${c.name} from company`}
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={handleQuickSubmit} className="space-y-3 pt-2 border-t border-border">
          <div className="relative" ref={searchContainerRef}>
            <label htmlFor="quick-name" className="block text-xs font-medium text-gray-400 mb-1">Name</label>
            <input
              id="quick-name"
              type="text"
              value={quickName}
              onChange={(e) => setQuickName(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowSearch(true)}
              placeholder="Type to search existing or enter new name"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="company-quick-name"
            />
            {showSearch && searchResults.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface-elevated py-1 shadow-lg max-h-48 overflow-auto">
                {searchResults.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => selectExistingContact(c)}
                      className="w-full text-left px-3 py-2 text-sm text-white hover:bg-surface-muted flex flex-col"
                    >
                      <span className="font-medium">{c.name}</span>
                      {(c.email || c.phone) && (
                        <span className="text-gray-400 text-xs">
                          {[c.email, c.phone].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <label htmlFor="quick-email" className="block text-xs font-medium text-gray-400 mb-1">Email</label>
            <input
              id="quick-email"
              type="email"
              value={quickEmail}
              onChange={(e) => setQuickEmail(e.target.value)}
              placeholder="email@example.com"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="company-quick-email"
            />
          </div>
          <div>
            <label htmlFor="quick-phone" className="block text-xs font-medium text-gray-400 mb-1">Phone</label>
            <input
              id="quick-phone"
              type="tel"
              value={quickPhone}
              onChange={(e) => setQuickPhone(e.target.value)}
              placeholder="+1 234 567 8900"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="company-quick-phone"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving || !quickName.trim()}
              className="px-3 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              data-testid="company-quick-submit"
            >
              {saving ? 'Saving…' : editingContactId ? 'Update' : 'Add'}
            </button>
            {editingContactId && (
              <button
                type="button"
                onClick={clearQuickForm}
                className="px-3 py-2 rounded-lg border border-border text-gray-300 text-sm hover:bg-surface-muted"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      {deleteOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-company-title"
        >
          <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
            <h2 id="delete-company-title" className="text-lg font-semibold text-white">
              Delete this company?
            </h2>
            <p className="text-sm text-gray-400 mt-2">
              This removes the company record. Contacts stay in your org but are unlinked from this company. Leads linked to this company lose the company association. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteCompany}
                disabled={deleting}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete company'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
