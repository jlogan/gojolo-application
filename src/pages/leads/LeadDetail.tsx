import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Download, Mail, Plus, Trash2 } from 'lucide-react'
import { buildResumePdfFromElement } from '@/lib/resumePdf'
import { resumeToHtml } from '@/lib/resumeHtml'
import type { GeneratedResume } from '@/types/resume'
import '@/components/resume/resume-editor.css'

type Lead = {
  id: string
  company_id: string | null
  title: string
  status: string
  source: string
  job_url: string | null
  job_description: string | null
  job_type: string | null
  work_mode: string | null
  compensation_type: string | null
  compensation_value: string | null
  location: string | null
  next_follow_up_at: string | null
  meta: Record<string, unknown> | null
  companies: { name: string } | { name: string }[] | null
}

type LeadContact = {
  id: string
  role: string
  is_primary: boolean
  notes: string | null
  contacts:
    | {
        id: string
        name: string
        email: string | null
        job_title: string | null
        linkedin_url: string | null
      }
    | {
        id: string
        name: string
        email: string | null
        job_title: string | null
        linkedin_url: string | null
      }[]
    | null
}

type LeadAttempt = {
  id: string
  attempt_type: string
  channel: string | null
  status: string
  content: string | null
  external_url: string | null
  attempted_at: string
  next_follow_up_at: string | null
  contacts: { id: string; name: string; email: string | null } | { id: string; name: string; email: string | null }[] | null
}

type ResumeDoc = {
  id: string
  file_path: string | null
  candidate_name: string
  company_name: string | null
  role_title: string | null
  created_at: string
  template_id: string | null
  content_json: GeneratedResume | null
  document_html: string | null
}

const LEAD_STATUS_OPTIONS = [
  'new',
  'researching',
  'applying',
  'applied',
  'follow_up',
  'interview',
  'closed_won',
  'closed_lost',
] as const

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  return s || 'resume'
}

function asSingle<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v
}

function pretty(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
}

function formatActivityDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' })
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()

  const [loading, setLoading] = useState(true)
  const [lead, setLead] = useState<Lead | null>(null)
  const [contacts, setContacts] = useState<LeadContact[]>([])
  const [attempts, setAttempts] = useState<LeadAttempt[]>([])
  const [resumeDocs, setResumeDocs] = useState<ResumeDoc[]>([])
  const [resumeTemplateName, setResumeTemplateName] = useState<string | null>(null)

  const [statusSaving, setStatusSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const [loggingAttempt, setLoggingAttempt] = useState(false)
  const [attemptType, setAttemptType] = useState('follow_up')
  const [attemptStatus, setAttemptStatus] = useState('completed')
  const [attemptContent, setAttemptContent] = useState('')
  const [attemptNextFollowUpDate, setAttemptNextFollowUpDate] = useState('')

  const [qaName, setQaName] = useState('')
  const [qaTitle, setQaTitle] = useState('')
  const [qaEmail, setQaEmail] = useState('')
  const [qaLinkedin, setQaLinkedin] = useState('')
  const [qaSaving, setQaSaving] = useState(false)

  const [activityDeleteId, setActivityDeleteId] = useState<string | null>(null)
  const [activityDeleting, setActivityDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    setLoading(true)

    const [{ data: leadData }, { data: contactData }, { data: attemptData }, { data: resumeData }] = await Promise.all([
      supabase
        .from('leads')
        .select(
          'id, company_id, title, status, source, job_url, job_description, job_type, work_mode, compensation_type, compensation_value, location, next_follow_up_at, meta, companies(name)',
        )
        .eq('id', id)
        .eq('org_id', currentOrg.id)
        .single(),
      supabase
        .from('lead_contacts')
        .select('id, role, is_primary, notes, contacts(id, name, email, job_title, linkedin_url)')
        .eq('lead_id', id)
        .order('is_primary', { ascending: false }),
      supabase
        .from('lead_attempts')
        .select('id, attempt_type, channel, status, content, external_url, attempted_at, next_follow_up_at, contacts(id, name, email)')
        .eq('lead_id', id)
        .order('attempted_at', { ascending: false }),
      supabase
        .from('resume_documents')
        .select('id, file_path, candidate_name, company_name, role_title, created_at, template_id, content_json, document_html')
        .eq('lead_id', id)
        .order('created_at', { ascending: false }),
    ])

    const L = leadData as Lead | null
    setLead(L ?? null)
    setContacts((contactData as LeadContact[]) ?? [])
    setAttempts((attemptData as LeadAttempt[]) ?? [])
    setResumeDocs((resumeData as ResumeDoc[]) ?? [])

    const tid = (L?.meta?.resume_template_id as string | undefined) ?? null
    if (tid) {
      const { data: tmpl } = await supabase.from('resume_templates').select('name').eq('id', tid).maybeSingle()
      setResumeTemplateName((tmpl as { name: string } | null)?.name ?? null)
    } else {
      setResumeTemplateName(null)
    }

    setLoading(false)
  }, [id, currentOrg?.id])

  useEffect(() => {
    load()
  }, [load])

  const handleStatusChange = async (next: string) => {
    if (!id || !currentOrg?.id || !lead) return
    setStatusSaving(true)
    const { error } = await supabase.from('leads').update({ status: next, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', currentOrg.id)
    setStatusSaving(false)
    if (error) {
      alert(`Could not update status: ${error.message}`)
      return
    }
    setLead({ ...lead, status: next })
  }

  const handleDeleteLead = async () => {
    if (!id || !currentOrg?.id) return
    setDeleting(true)
    const { error } = await supabase.from('leads').delete().eq('id', id).eq('org_id', currentOrg.id)
    setDeleting(false)
    if (error) {
      alert(`Could not delete lead: ${error.message}`)
      return
    }
    navigate('/leads')
  }

  const handleDownloadResume = async (doc: ResumeDoc) => {
    if (!lead) return

    setDownloadingId(doc.id)
    try {
      // Preferred path: rebuild PDF from saved resume HTML/content so this matches Edit → Download PDF quality.
      const sourceHtml =
        typeof doc.document_html === 'string' && doc.document_html.trim()
          ? doc.document_html
          : doc.content_json
            ? resumeToHtml(doc.content_json)
            : null

      if (sourceHtml) {
        const host = document.createElement('div')
        host.style.position = 'fixed'
        host.style.left = '-20000px'
        host.style.top = '0'
        host.style.width = '210mm'
        host.style.opacity = '0'
        host.style.pointerEvents = 'none'

        const page = document.createElement('div')
        page.className = 'resume-a4-page'
        page.style.width = '210mm'
        page.style.background = '#ffffff'

        const prose = document.createElement('div')
        prose.className = 'ProseMirror'
        prose.innerHTML = sourceHtml

        page.appendChild(prose)
        host.appendChild(page)
        document.body.appendChild(host)

        try {
          const blob = await buildResumePdfFromElement(page)
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `${slugify(lead.title)}-${slugify(doc.candidate_name || 'resume')}.pdf`
          a.click()
          URL.revokeObjectURL(url)
          return
        } finally {
          host.remove()
        }
      }

      // Fallback for legacy rows that only have an uploaded file.
      if (!doc.file_path) {
        alert('No stored resume content or PDF file exists for this record.')
        return
      }

      const { data, error } = await supabase.storage.from('lead-resumes').download(doc.file_path)
      if (error || !data) {
        alert(`Download failed: ${error?.message ?? 'Unknown error'}`)
        return
      }
      const url = URL.createObjectURL(data)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slugify(lead.title)}-${slugify(doc.candidate_name || 'resume')}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Could not build PDF: ${(e as Error).message}`)
    } finally {
      setDownloadingId(null)
    }
  }

  const handleLogAttempt = async () => {
    if (!id || !currentOrg?.id || !attemptType) return
    setLoggingAttempt(true)

    const { data: userResult } = await supabase.auth.getUser()
    const userId = userResult?.user?.id ?? null

    const { error } = await supabase.from('lead_attempts').insert({
      lead_id: id,
      org_id: currentOrg.id,
      attempt_type: attemptType,
      channel: null,
      status: attemptStatus,
      content: attemptContent.trim() || null,
      next_follow_up_at: attemptNextFollowUpDate ? new Date(`${attemptNextFollowUpDate}T09:00:00`).toISOString() : null,
      created_by: userId,
    })

    if (error) {
      alert(`Could not log attempt: ${error.message}`)
      setLoggingAttempt(false)
      return
    }

    const leadPatch: Record<string, unknown> = { last_activity_at: new Date().toISOString() }
    if (attemptNextFollowUpDate.trim()) {
      leadPatch.next_follow_up_at = new Date(`${attemptNextFollowUpDate}T09:00:00`).toISOString()
    }
    await supabase.from('leads').update(leadPatch).eq('id', id).eq('org_id', currentOrg.id)

    setAttemptContent('')
    setAttemptNextFollowUpDate('')
    setLoggingAttempt(false)
    load()
  }

  const handleDeleteActivity = async () => {
    if (!activityDeleteId || !currentOrg?.id) return
    setActivityDeleting(true)
    const { error } = await supabase.from('lead_attempts').delete().eq('id', activityDeleteId).eq('org_id', currentOrg.id)
    setActivityDeleting(false)
    if (error) {
      alert(`Could not delete activity: ${error.message}`)
      return
    }
    setActivityDeleteId(null)
    load()
  }

  const handleQuickAddContact = async () => {
    if (!id || !currentOrg?.id || !lead) return
    const name = qaName.trim()
    const email = qaEmail.trim()
    if (!name || !email) {
      alert('Name and email are required to add a contact.')
      return
    }
    setQaSaving(true)
    const { data: created, error: insErr } = await supabase
      .from('contacts')
      .insert({
        org_id: currentOrg.id,
        company_id: lead.company_id,
        type: 'lead',
        name,
        email,
        job_title: qaTitle.trim() || null,
        linkedin_url: qaLinkedin.trim() || null,
        sourced_from_lead: true,
      })
      .select('id')
      .single()
    if (insErr || !created) {
      alert(`Could not create contact: ${insErr?.message ?? 'Unknown error'}`)
      setQaSaving(false)
      return
    }
    const { error: linkErr } = await supabase.from('lead_contacts').insert({
      lead_id: id,
      contact_id: (created as { id: string }).id,
      role: 'target',
      is_primary: contacts.length === 0,
    })
    if (linkErr) {
      alert(`Contact was created but could not be linked to this lead: ${linkErr.message}`)
    }
    setQaName('')
    setQaTitle('')
    setQaEmail('')
    setQaLinkedin('')
    setQaSaving(false)
    load()
  }

  if (loading) return <div className="p-4 md:p-6 text-gray-400">Loading…</div>
  if (!lead) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-gray-400">Lead not found.</p>
        <Link to="/leads" className="text-accent hover:underline mt-2 inline-block">
          Back to leads
        </Link>
      </div>
    )
  }

  const company = asSingle(lead.companies)?.name
  const resumeTemplateId = (lead.meta?.resume_template_id as string | undefined) ?? null
  const compensationType = lead.compensation_type ?? ((lead.meta?.compensation_type as string | undefined) ?? null)
  const templateLine =
    resumeTemplateName ?? (resumeTemplateId ? `Template ID (missing name) ${resumeTemplateId.slice(0, 8)}…` : null)

  return (
    <div className="p-4 md:p-6 max-w-5xl" data-testid="lead-detail-page">
      <Link to="/leads" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-6">
        <ArrowLeft className="w-4 h-4" /> Leads
      </Link>

      <div className="rounded-lg border border-border bg-surface-elevated p-5 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-white">{lead.title}</h1>
            <p className="text-sm text-gray-400 mt-1 flex flex-wrap items-center gap-x-1.5">
              <span>{company ?? 'No company'}</span>
              <span aria-hidden>•</span>
              {lead.job_url ? (
                <a href={lead.job_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {pretty(lead.source)}
                </a>
              ) : (
                <span>{pretty(lead.source)}</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Link to={`/leads/${lead.id}/edit`} className="text-sm text-accent hover:underline font-medium px-1">
              Edit
            </Link>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <span className="whitespace-nowrap">Status</span>
              <select
                value={lead.status}
                disabled={statusSaving}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-white text-sm min-w-[10rem]"
              >
                {LEAD_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {pretty(s)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 text-sm hover:bg-red-500/10"
            >
              <Trash2 className="w-4 h-4" /> Delete lead
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4 text-sm">
          <p className="text-gray-300">
            <span className="text-gray-500">Job type:</span> {lead.job_type ? pretty(lead.job_type) : '—'}
          </p>
          <p className="text-gray-300">
            <span className="text-gray-500">Work mode:</span> {lead.work_mode ? pretty(lead.work_mode) : '—'}
          </p>
          <p className="text-gray-300">
            <span className="text-gray-500">Location:</span> {lead.location ?? '—'}
          </p>
          <p className="text-gray-300">
            <span className="text-gray-500">Compensation:</span> {lead.compensation_value ?? '—'}
            {compensationType ? ` (${pretty(compensationType)})` : ''}
          </p>
          <p className="text-gray-300 md:col-span-2">
            <span className="text-gray-500">Resume template:</span>{' '}
            {templateLine ? <span className="text-white">{templateLine}</span> : <span className="text-amber-400/90">Not set</span>}
          </p>
          <p className="text-gray-300 md:col-span-2 flex flex-wrap items-center gap-2">
            <span className="text-gray-500">Saved resume (PDF):</span>
            {resumeDocs[0] ? (
              <button
                type="button"
                disabled={!resumeDocs[0].file_path || downloadingId === resumeDocs[0].id}
                onClick={() => handleDownloadResume(resumeDocs[0])}
                className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline font-medium disabled:opacity-40 disabled:no-underline"
              >
                <Download className="w-4 h-4 shrink-0" />
                {downloadingId === resumeDocs[0].id ? 'Downloading…' : 'Download latest'}
              </button>
            ) : (
              <span className="text-gray-500">None yet — use Edit to generate one.</span>
            )}
          </p>
        </div>

        {lead.job_description && (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Job description</p>
            <p className="text-sm text-gray-300 whitespace-pre-wrap max-h-60 overflow-y-auto">{lead.job_description}</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="rounded-lg border border-border bg-surface-elevated p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Linked contacts</h2>
          {contacts.length === 0 ? <p className="text-sm text-gray-500 mb-3">No contacts linked yet.</p> : null}
          <ul className="space-y-3 mb-4">
            {contacts.map((lc) => {
              const c = asSingle(lc.contacts)
              const inboxCompose =
                c?.email && id
                  ? `/inbox?compose=1&to=${encodeURIComponent(c.email)}&leadId=${encodeURIComponent(id)}&contactId=${encodeURIComponent(c.id)}`
                  : null
              return (
                <li key={lc.id} className="text-sm text-gray-300 border border-border rounded-lg p-3 bg-surface-muted/20">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium text-white">{c?.name ?? 'Unknown contact'}</span>
                      {c?.job_title ? <span className="text-gray-500"> · {c.job_title}</span> : null}
                      {c?.email ? <p className="text-xs text-gray-400 mt-0.5">{c.email}</p> : null}
                      {c?.linkedin_url ? (
                        <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline block mt-1">
                          LinkedIn
                        </a>
                      ) : null}
                      <span className="text-xs text-gray-500 block mt-1">{lc.is_primary ? 'Primary' : pretty(lc.role)}</span>
                    </div>
                    {inboxCompose ? (
                      <Link
                        to={inboxCompose}
                        className="inline-flex items-center gap-1 text-xs text-accent hover:underline shrink-0"
                      >
                        <Mail className="w-3.5 h-3.5" /> Compose
                      </Link>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Quick add contact</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              value={qaName}
              onChange={(e) => setQaName(e.target.value)}
              placeholder="Name *"
              className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm"
            />
            <input
              value={qaTitle}
              onChange={(e) => setQaTitle(e.target.value)}
              placeholder="Title"
              className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm"
            />
            <input
              value={qaEmail}
              onChange={(e) => setQaEmail(e.target.value)}
              placeholder="Email *"
              type="email"
              className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm sm:col-span-2"
            />
            <input
              value={qaLinkedin}
              onChange={(e) => setQaLinkedin(e.target.value)}
              placeholder="LinkedIn URL"
              className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm sm:col-span-2"
            />
          </div>
          <button
            type="button"
            onClick={handleQuickAddContact}
            disabled={qaSaving}
            className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium text-sm disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> {qaSaving ? 'Saving…' : 'Add contact to lead'}
          </button>
        </section>

        <section className="rounded-lg border border-border bg-surface-elevated p-4 flex flex-col min-h-[320px]">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Activity</h2>
          <div className="flex-1 min-h-0 overflow-y-auto max-h-72 mb-4 pr-1 border-b border-border pb-4">
            {attempts.length === 0 ? (
              <p className="text-sm text-gray-500">No activities logged yet.</p>
            ) : (
              <ul className="space-y-3">
                {attempts.map((a) => {
                  const c = asSingle(a.contacts)
                  return (
                    <li key={a.id} className="border border-border rounded-lg p-3 bg-surface-muted/20">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-white font-medium">
                            {pretty(a.attempt_type)} • {pretty(a.status)}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {formatActivityDate(a.attempted_at)}
                            {c?.name ? ` • ${c.name}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setActivityDeleteId(a.id)}
                          className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-surface-muted"
                          title="Delete activity"
                          aria-label="Delete activity"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      {a.content && <p className="text-sm text-gray-300 whitespace-pre-wrap mt-2">{a.content}</p>}
                      {a.next_follow_up_at && (
                        <p className="text-xs text-amber-300 mt-2">Follow-up: {new Date(a.next_follow_up_at).toLocaleDateString()}</p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Log new activity</p>
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <select
                value={attemptType}
                onChange={(e) => setAttemptType(e.target.value)}
                className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm"
              >
                <option value="application">Application</option>
                <option value="email_outreach">Email outreach</option>
                <option value="linkedin_message">LinkedIn message</option>
                <option value="upwork_proposal">Upwork proposal</option>
                <option value="follow_up">Follow-up</option>
                <option value="call">Call</option>
                <option value="meeting">Meeting</option>
                <option value="inbound">They reached out (inbound)</option>
                <option value="appointment">Appointment booked</option>
                <option value="other">Other</option>
              </select>
              <select
                value={attemptStatus}
                onChange={(e) => setAttemptStatus(e.target.value)}
                className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm"
              >
                <option value="completed">Completed</option>
                <option value="pending">Pending</option>
                <option value="replied">Replied</option>
                <option value="interview">Interview</option>
                <option value="rejected">Rejected</option>
                <option value="won">Won</option>
                <option value="lost">Lost</option>
              </select>
            </div>

            <input
              type="date"
              value={attemptNextFollowUpDate}
              onChange={(e) => setAttemptNextFollowUpDate(e.target.value)}
              className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm"
            />
            <textarea
              value={attemptContent}
              onChange={(e) => setAttemptContent(e.target.value)}
              rows={4}
              placeholder="Notes (outreach, inbound reply, appointment details, etc.)"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm"
            />
            <button
              type="button"
              onClick={handleLogAttempt}
              disabled={loggingAttempt}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> {loggingAttempt ? 'Saving…' : 'Add activity'}
            </button>
          </div>
        </section>
      </div>

      {activityDeleteId && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-activity-title"
        >
          <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
            <h2 id="delete-activity-title" className="text-lg font-semibold text-white">
              Delete this activity?
            </h2>
            <p className="text-sm text-gray-400 mt-2">This removes the log entry from the timeline. It cannot be undone.</p>
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setActivityDeleteId(null)}
                disabled={activityDeleting}
                className="px-4 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteActivity}
                disabled={activityDeleting}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-50"
              >
                {activityDeleting ? 'Deleting…' : 'Delete activity'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-lead-title"
        >
          <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
            <h2 id="delete-lead-title" className="text-lg font-semibold text-white">
              Delete this lead?
            </h2>
            <p className="text-sm text-gray-400 mt-2">
              This removes the lead, its linked lead contacts, and activity history. The underlying contact and company records are not deleted.
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
                onClick={handleDeleteLead}
                disabled={deleting}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete lead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
