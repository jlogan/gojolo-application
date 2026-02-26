import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { Plus, User } from 'lucide-react'

export type Contact = {
  id: string
  org_id: string
  company_id: string | null
  type: string
  name: string
  email: string | null
  phone: string | null
  meta: Record<string, unknown> | null
  created_at: string
}

export default function ContactsList() {
  const { currentOrg } = useOrg()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!currentOrg?.id) return
    let cancelled = false
    setLoading(true)
    supabase
      .from('contacts')
      .select('id, org_id, company_id, type, name, email, phone, meta, created_at')
      .eq('org_id', currentOrg.id)
      .order('name')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error(error)
          setContacts([])
        } else {
          setContacts((data as Contact[]) ?? [])
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentOrg?.id])

  return (
    <div className="p-4 md:p-6" data-testid="contacts-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <h1 className="text-xl font-semibold text-white">Contacts</h1>
        <Link
          to="/contacts/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
          data-testid="contact-create"
        >
          <Plus className="w-4 h-4" />
          Add contact
        </Link>
      </div>

      {loading ? (
        <div className="text-surface-muted text-sm" data-testid="contacts-loading">
          Loading…
        </div>
      ) : contacts.length === 0 ? (
        <div
          className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400"
          data-testid="contacts-empty"
        >
          <User className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No contacts yet</p>
          <p className="text-sm mt-1">Add a contact to get started.</p>
          <Link
            to="/contacts/new"
            className="inline-block mt-4 text-accent hover:underline"
            data-testid="contact-create-empty"
          >
            Add contact
          </Link>
        </div>
      ) : (
        <ul
          className="rounded-lg border border-border divide-y divide-border overflow-hidden"
          data-testid="contact-list"
        >
          {contacts.map((c) => (
            <li key={c.id}>
              <Link
                to={`/contacts/${c.id}`}
                className="flex items-center gap-4 p-4 hover:bg-surface-muted transition-colors"
                data-testid={`contact-row-${c.id}`}
              >
                <div className="w-10 h-10 rounded-full bg-surface-muted flex items-center justify-center shrink-0">
                  <User className="w-5 h-5 text-surface-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white truncate">{c.name}</p>
                  {c.email && (
                    <p className="text-sm text-surface-muted truncate">{c.email}</p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
