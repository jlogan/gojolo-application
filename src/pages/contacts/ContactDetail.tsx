import { useEffect, useState, useCallback } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import {
  Mail, Phone, Building2, Pencil, ArrowLeft, Trash2, Plus,
  FolderKanban, MessageSquare, Send, X, GitMerge,
} from 'lucide-react'
import type { Contact } from './ContactsList'

type ContactEmail = { id: string; email: string; label: string | null; is_primary: boolean }
type ContactPhone = { id: string; phone: string; label: string | null; is_primary: boolean }
type LinkedProject = { id: string; name: string; status: string }
type LinkedThread = { id: string; subject: string | null; last_message_at: string; status: string }

function gravatarUrl(email: string | null, size = 80): string {
  if (!email) return ''
  const hash = email.trim().toLowerCase()
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`
}

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const [contact, setContact] = useState<(Contact & { notes: string | null; avatar_url: string | null }) | null>(null)
  const [emails, setEmails] = useState<ContactEmail[]>([])
  const [phones, setPhones] = useState<ContactPhone[]>([])
  const [projects, setProjects] = useState<LinkedProject[]>([])
  const [threads, setThreads] = useState<LinkedThread[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)

  // Edit state
  const [editName, setEditName] = useState('')
  const [editCompanyId, setEditCompanyId] = useState('')
  const [editType, setEditType] = useState('primary')
  const [editNotes, setEditNotes] = useState('')
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)

  // New email/phone
  const [newEmail, setNewEmail] = useState('')
  const [newPhone, setNewPhone] = useState('')

  const fetchContact = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    const { data } = await supabase.from('contacts')
      .select('id, org_id, company_id, type, name, email, phone, meta, notes, avatar_url, created_at')
      .eq('id', id).eq('org_id', currentOrg.id).single()
    if (data) {
      setContact(data as Contact & { notes: string | null; avatar_url: string | null })
      setEditName(data.name); setEditCompanyId(data.company_id ?? '')
      setEditType(data.type ?? 'primary'); setEditNotes(data.notes ?? '')
    }
    setLoading(false)
  }, [id, currentOrg?.id])

  const fetchExtras = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    const [{ data: eData }, { data: pData }] = await Promise.all([
      supabase.from('contact_emails').select('*').eq('contact_id', id).order('is_primary', { ascending: false }),
      supabase.from('contact_phones').select('*').eq('contact_id', id).order('is_primary', { ascending: false }),
    ])
    setEmails((eData as ContactEmail[]) ?? [])
    setPhones((pData as ContactPhone[]) ?? [])

    // Linked projects
    const { data: pc } = await supabase.from('project_contacts').select('project_id, projects(id, name, status)').eq('contact_id', id)
    setProjects((pc ?? []).map((r: { projects: { id: string; name: string; status: string } | { id: string; name: string; status: string }[] | null }) => {
      const p = Array.isArray(r.projects) ? r.projects[0] : r.projects
      return p ? { id: p.id, name: p.name, status: p.status } : null
    }).filter(Boolean) as LinkedProject[])

    // Linked threads
    const { data: tc } = await supabase.from('inbox_thread_contacts').select('thread_id, inbox_threads(id, subject, last_message_at, status)').eq('contact_id', id)
    setThreads((tc ?? []).map((r: { inbox_threads: { id: string; subject: string | null; last_message_at: string; status: string } | { id: string; subject: string | null; last_message_at: string; status: string }[] | null }) => {
      const t = Array.isArray(r.inbox_threads) ? r.inbox_threads[0] : r.inbox_threads
      return t ? { id: t.id, subject: t.subject, last_message_at: t.last_message_at, status: t.status } : null
    }).filter(Boolean) as LinkedThread[])
  }, [id, currentOrg?.id])

  useEffect(() => { fetchContact() }, [fetchContact])
  useEffect(() => { fetchExtras() }, [fetchExtras])
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.from('companies').select('id, name').eq('org_id', currentOrg.id).order('name')
      .then(({ data }) => setCompanies((data as { id: string; name: string }[]) ?? []))
  }, [currentOrg?.id])

  const handleSave = async () => {
    if (!id || !currentOrg?.id) return
    setSaving(true)
    await supabase.from('contacts').update({
      name: editName.trim(), company_id: editCompanyId || null,
      type: editType, notes: editNotes.trim() || null,
    }).eq('id', id).eq('org_id', currentOrg.id)
    setSaving(false); setEditing(false); fetchContact()
  }

  const handleDelete = async () => {
    if (!id || !confirm('Delete this contact? This cannot be undone.')) return
    await supabase.from('contacts').delete().eq('id', id)
    navigate('/contacts')
  }

  const [showMerge, setShowMerge] = useState(false)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [mergeContacts, setMergeContacts] = useState<{ id: string; name: string; email: string | null }[]>([])

  useEffect(() => {
    if (!showMerge || !currentOrg?.id || !id) return
    supabase.from('contacts').select('id, name, email').eq('org_id', currentOrg.id).neq('id', id).order('name')
      .then(({ data }) => setMergeContacts((data as { id: string; name: string; email: string | null }[]) ?? []))
  }, [showMerge, currentOrg?.id, id])

  const handleMerge = async () => {
    if (!id || !mergeTargetId || !confirm('Merge this contact into the selected contact? This contact will be hidden.')) return
    await supabase.from('contacts').update({ merged_into: mergeTargetId }).eq('id', id)
    // Move emails, phones, thread links to target
    await supabase.from('contact_emails').update({ contact_id: mergeTargetId }).eq('contact_id', id)
    await supabase.from('contact_phones').update({ contact_id: mergeTargetId }).eq('contact_id', id)
    await supabase.from('inbox_thread_contacts').update({ contact_id: mergeTargetId }).eq('contact_id', id)
    await supabase.from('project_contacts').update({ contact_id: mergeTargetId }).eq('contact_id', id)
    navigate(`/contacts/${mergeTargetId}`)
  }

  const handleAddEmail = async () => {
    if (!id || !newEmail.trim()) return
    await supabase.from('contact_emails').insert({ contact_id: id, email: newEmail.trim(), is_primary: emails.length === 0 })
    setNewEmail(''); fetchExtras()
  }

  const handleRemoveEmail = async (emailId: string) => {
    await supabase.from('contact_emails').delete().eq('id', emailId)
    fetchExtras()
  }

  const handleAddPhone = async () => {
    if (!id || !newPhone.trim()) return
    await supabase.from('contact_phones').insert({ contact_id: id, phone: newPhone.trim(), is_primary: phones.length === 0 })
    setNewPhone(''); fetchExtras()
  }

  const handleRemovePhone = async (phoneId: string) => {
    await supabase.from('contact_phones').delete().eq('id', phoneId)
    fetchExtras()
  }

  if (loading) return <div className="p-4 md:p-6 text-gray-400">Loading…</div>
  if (!contact) return (
    <div className="p-4 md:p-6">
      <p className="text-gray-400">Contact not found.</p>
      <Link to="/contacts" className="text-accent hover:underline mt-2 inline-block">Back to contacts</Link>
    </div>
  )

  const avatarSrc = contact.avatar_url || gravatarUrl(contact.email)
  const companyName = companies.find(c => c.id === contact.company_id)?.name

  return (
    <div className="p-4 md:p-6 max-w-3xl" data-testid="contact-detail">
      <Link to="/contacts" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-6">
        <ArrowLeft className="w-4 h-4" /> Contacts
      </Link>

      {/* Contact card header */}
      <div className="rounded-lg border border-border bg-surface-elevated p-6 mb-6">
        <div className="flex items-start gap-4">
          <img src={avatarSrc} alt="" className="w-16 h-16 rounded-full bg-surface-muted object-cover" onError={e => { (e.target as HTMLImageElement).src = `https://ui-avatars.com/api/?name=${encodeURIComponent(contact.name)}&background=262626&color=e4e4e7&size=64` }} />
          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="space-y-3">
                <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                  className="w-full rounded border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
                <div className="grid grid-cols-2 gap-3">
                  <select value={editType} onChange={e => setEditType(e.target.value)}
                    className="rounded border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="lead">Lead</option><option value="client">Client</option><option value="vendor">Vendor</option><option value="other">Other</option>
                  </select>
                  <select value={editCompanyId} onChange={e => setEditCompanyId(e.target.value)}
                    className="rounded border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="">No company</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={handleSave} disabled={saving}
                    className="px-3 py-1.5 rounded bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
                  <button type="button" onClick={() => setEditing(false)} className="px-3 py-1.5 rounded border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-semibold text-white">{contact.name}</h1>
                <div className="flex items-center gap-3 mt-1 text-sm text-gray-400 flex-wrap">
                  <span className="text-xs px-2 py-0.5 rounded bg-surface-muted text-gray-300">{contact.type}</span>
                  {companyName && (
                    <Link to={`/companies/${contact.company_id}`} className="flex items-center gap-1 text-accent hover:underline">
                      <Building2 className="w-3.5 h-3.5" /> {companyName}
                    </Link>
                  )}
                </div>
              </>
            )}
          </div>
          {!editing && (
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => setEditing(true)} className="p-2 rounded text-gray-400 hover:text-white hover:bg-surface-muted" title="Edit"><Pencil className="w-4 h-4" /></button>
              <button type="button" onClick={() => setShowMerge(!showMerge)} className="p-2 rounded text-gray-400 hover:text-accent hover:bg-surface-muted" title="Merge"><GitMerge className="w-4 h-4" /></button>
              <button type="button" onClick={handleDelete} className="p-2 rounded text-gray-400 hover:text-red-400 hover:bg-surface-muted" title="Delete"><Trash2 className="w-4 h-4" /></button>
            </div>
          )}
        </div>

        {/* Quick actions */}
        {!editing && (
          <div className="flex gap-2 mt-4 pt-4 border-t border-border">
            {contact.email && (
              <Link to={`/inbox`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-sm text-gray-300 hover:text-white hover:bg-surface-muted/80">
                <Send className="w-3.5 h-3.5" /> Email
              </Link>
            )}
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted text-sm text-gray-300 hover:text-white hover:bg-surface-muted/80">
                <Phone className="w-3.5 h-3.5" /> Call
              </a>
            )}
          </div>
        )}
      </div>

      {/* Merge panel */}
      {showMerge && (
        <div className="rounded-lg border border-accent/30 bg-surface-elevated p-4 mb-6 space-y-3">
          <h3 className="text-sm font-medium text-white flex items-center gap-2"><GitMerge className="w-4 h-4 text-accent" /> Merge into another contact</h3>
          <p className="text-xs text-gray-400">This will move all emails, phones, thread links, and project links to the target contact and hide this one.</p>
          <div className="flex gap-2">
            <select value={mergeTargetId} onChange={e => setMergeTargetId(e.target.value)}
              className="flex-1 rounded border border-border bg-surface-muted px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="">Select contact to merge into…</option>
              {mergeContacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ''}</option>)}
            </select>
            <button type="button" onClick={handleMerge} disabled={!mergeTargetId}
              className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">Merge</button>
            <button type="button" onClick={() => setShowMerge(false)}
              className="px-3 py-2 rounded border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Emails */}
        <section className="rounded-lg border border-border bg-surface-elevated p-4">
          <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><Mail className="w-4 h-4" /> Email addresses</h2>
          {contact.email && (
            <div className="flex items-center gap-2 py-1.5 text-sm">
              <span className="text-white">{contact.email}</span>
              <span className="text-xs text-gray-500">primary</span>
            </div>
          )}
          {emails.map(e => (
            <div key={e.id} className="flex items-center justify-between py-1.5 text-sm">
              <span className="text-white">{e.email}</span>
              <div className="flex items-center gap-1">
                {e.label && <span className="text-xs text-gray-500">{e.label}</span>}
                <button type="button" onClick={() => handleRemoveEmail(e.id)} className="p-1 text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
              </div>
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="Add email" onKeyDown={e => { if (e.key === 'Enter') handleAddEmail() }}
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
            <button type="button" onClick={handleAddEmail} disabled={!newEmail.trim()}
              className="px-2 py-1.5 rounded bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-50"><Plus className="w-3 h-3" /></button>
          </div>
        </section>

        {/* Phones */}
        <section className="rounded-lg border border-border bg-surface-elevated p-4">
          <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><Phone className="w-4 h-4" /> Phone numbers</h2>
          {contact.phone && (
            <div className="flex items-center gap-2 py-1.5 text-sm">
              <span className="text-white">{contact.phone}</span>
              <span className="text-xs text-gray-500">primary</span>
            </div>
          )}
          {phones.map(p => (
            <div key={p.id} className="flex items-center justify-between py-1.5 text-sm">
              <span className="text-white">{p.phone}</span>
              <div className="flex items-center gap-1">
                {p.label && <span className="text-xs text-gray-500">{p.label}</span>}
                <button type="button" onClick={() => handleRemovePhone(p.id)} className="p-1 text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
              </div>
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <input type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="Add phone" onKeyDown={e => { if (e.key === 'Enter') handleAddPhone() }}
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
            <button type="button" onClick={handleAddPhone} disabled={!newPhone.trim()}
              className="px-2 py-1.5 rounded bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-50"><Plus className="w-3 h-3" /></button>
          </div>
        </section>

        {/* Projects */}
        <section className="rounded-lg border border-border bg-surface-elevated p-4">
          <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><FolderKanban className="w-4 h-4" /> Projects ({projects.length})</h2>
          {projects.length === 0 ? <p className="text-gray-500 text-sm">No linked projects.</p> : (
            <ul className="space-y-1">{projects.map(p => (
              <li key={p.id}><Link to={`/projects/${p.id}`} className="text-sm text-accent hover:underline">{p.name}</Link></li>
            ))}</ul>
          )}
        </section>

        {/* Email threads */}
        <section className="rounded-lg border border-border bg-surface-elevated p-4">
          <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-3"><MessageSquare className="w-4 h-4" /> Email history ({threads.length})</h2>
          {threads.length === 0 ? <p className="text-gray-500 text-sm">No email threads linked.</p> : (
            <ul className="space-y-1">{threads.map(t => (
              <li key={t.id} className="flex items-center justify-between text-sm">
                <Link to="/inbox" className="text-accent hover:underline truncate">{t.subject || '(No subject)'}</Link>
                <span className="text-xs text-gray-500 shrink-0">{new Date(t.last_message_at).toLocaleDateString()}</span>
              </li>
            ))}</ul>
          )}
        </section>
      </div>
    </div>
  )
}
