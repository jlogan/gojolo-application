import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Send, Mail, CheckCircle, AlertCircle } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'

type Invoice = {
  id: string
  org_id: string
  direction: 'outbound' | 'inbound'
  number: number | null
  prefix: string | null
  status: string
  company_id: string | null
  contact_id: string | null
  issue_date: string | null
  due_date: string | null
  amount_due: number | null
  total: number | null
  hash: string | null
}

type ContactInfo = { id: string; name: string | null; email: string | null }
type CompanyInfo = { id: string; name: string | null }
type ImapAccount = { id: string; email: string; label: string | null; addresses: string[] | null }
type SendableAddress = { accountId: string; email: string; label: string }

function fmtCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value ?? 0)
}

function fmtDate(date: string | null | undefined): string {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function invoiceNumber(inv: Invoice | null): string {
  if (!inv) return ''
  const prefix = (inv.prefix ?? 'INV-').replace(/-+$/, '')
  return inv.number ? `${prefix}-${String(inv.number).padStart(4, '0')}` : `${prefix}-DRAFT`
}

function splitContactName(name: string | null | undefined): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: 'there', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function plainTextToHtml(text: string): string {
  const escaped = escapeHtml(text.trim())
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1">$1</a>',
  )
  return linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
    .join('')
}

function buildDefaultInvoiceMessage(args: {
  contactName: string
  invoiceAmountDue: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  payUrl: string
  signature: string
}) {
  return [
    `Dear ${args.contactName},`,
    'Thank you for your business. Your invoice can be viewed, printed and downloaded as PDF from the link below. You can also choose to pay it online.',
    `Invoice amount: ${args.invoiceAmountDue}`,
    `Invoice No: ${args.invoiceNumber}`,
    `Invoice Date: ${args.invoiceDate}`,
    `Due Date: ${args.dueDate}`,
    `Pay online: ${args.payUrl}`,
    'Please contact us for more information.',
    `Kind Regards,\n${args.signature}`,
  ].join('\n\n')
}

export default function InvoiceEmailDraft() {
  const { id } = useParams<{ id: string }>()
  const { currentOrg, isVendor } = useOrg()
  const { user } = useAuth()

  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [contact, setContact] = useState<ContactInfo | null>(null)
  const [company, setCompany] = useState<CompanyInfo | null>(null)
  const [accounts, setAccounts] = useState<ImapAccount[]>([])
  const [selectedFrom, setSelectedFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [to, setTo] = useState('')
  const signature = 'Jay Logan\nBrogrammers Agency'
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successThreadId, setSuccessThreadId] = useState<string | null>(null)

  const sendableAddresses = useMemo<SendableAddress[]>(() => {
    return accounts.flatMap((account) => {
      const addresses = [account.email, ...((account.addresses ?? []) as string[])]
        .map((email) => email?.trim())
        .filter(Boolean) as string[]
      return [...new Set(addresses.map((email) => email.toLowerCase()))].map((email) => ({
        accountId: account.id,
        email,
        label: account.label ? `${account.label} <${email}>` : email,
      }))
    })
  }, [accounts])

  const selectedSendable = useMemo(() => (
    sendableAddresses.find((a) => a.email.toLowerCase() === selectedFrom.toLowerCase()) ?? sendableAddresses[0]
  ), [sendableAddresses, selectedFrom])

  const invNum = invoiceNumber(invoice)
  const payUrl = invoice?.hash ? `${window.location.origin}/invoice/${invoice.hash}` : ''
  const bodyHtml = useMemo(() => plainTextToHtml(message), [message])

  const load = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    setLoading(true)
    setError(null)

    const { data: inv, error: invErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()

    if (invErr || !inv) {
      setError(invErr?.message ?? 'Invoice not found')
      setLoading(false)
      return
    }

    const invoiceRow = inv as Invoice
    let loadedContact: ContactInfo | null = null
    let loadedCompany: CompanyInfo | null = null
    setInvoice(invoiceRow)
    const number = invoiceNumber(invoiceRow)
    setSubject(`Invoice - ${number} from Brogrammers Agency`)

    if (invoiceRow.contact_id) {
      const { data: primaryContact } = await supabase
        .from('contacts')
        .select('id, name, email')
        .eq('id', invoiceRow.contact_id)
        .maybeSingle()
      if (primaryContact) {
        loadedContact = primaryContact as ContactInfo
        setContact(loadedContact)
        setTo(loadedContact.email ?? '')
      }
    }

    if (!invoiceRow.contact_id) {
      const { data: invoiceContacts } = await supabase
        .from('invoice_contacts')
        .select('is_primary, contacts(id, name, email)')
        .eq('invoice_id', invoiceRow.id)
        .order('is_primary', { ascending: false })
        .limit(1)
      const linked = invoiceContacts?.[0]?.contacts
      const linkedContact = Array.isArray(linked) ? linked[0] : linked
      if (linkedContact) {
        loadedContact = linkedContact as ContactInfo
        setContact(loadedContact)
        setTo(loadedContact.email ?? '')
      }
    }

    if (invoiceRow.company_id) {
      const { data: companyRow } = await supabase
        .from('companies')
        .select('id, name')
        .eq('id', invoiceRow.company_id)
        .maybeSingle()
      loadedCompany = (companyRow as CompanyInfo | null) ?? null
      setCompany(loadedCompany)
    }

    const { data: accountRows } = await supabase
      .from('imap_accounts')
      .select('id, email, label, addresses')
      .eq('org_id', currentOrg.id)
      .eq('is_active', true)
      .order('email')
    const activeAccounts = (accountRows as ImapAccount[]) ?? []
    setAccounts(activeAccounts)
    if (activeAccounts[0]) setSelectedFrom(activeAccounts[0].email)

    const loadedContactNameParts = splitContactName(loadedContact?.name)
    const loadedContactName = [loadedContactNameParts.first, loadedContactNameParts.last].filter(Boolean).join(' ')
    setMessage(buildDefaultInvoiceMessage({
      contactName: loadedContactName || 'there',
      invoiceAmountDue: fmtCurrency(invoiceRow.amount_due ?? invoiceRow.total ?? 0),
      invoiceNumber: number,
      invoiceDate: fmtDate(invoiceRow.issue_date),
      dueDate: fmtDate(invoiceRow.due_date),
      payUrl: invoiceRow.hash ? `${window.location.origin}/invoice/${invoiceRow.hash}` : '',
      signature,
    }))

    setLoading(false)
  }, [currentOrg?.id, id])

  useEffect(() => { load() }, [load])

  const handleSend = async () => {
    if (!invoice || !user?.id || sending) return
    setError(null)
    if (isVendor) { setError('Vendors cannot send invoices.'); return }
    if (invoice.direction !== 'outbound') { setError('Only outbound invoices can be sent to clients.'); return }
    if (!to.trim() || !to.includes('@')) { setError('Enter a valid recipient email.'); return }
    if (!selectedSendable) { setError('No active inbox email account is available for sending.'); return }
    if (!payUrl) { setError('This invoice does not have a public payment link yet.'); return }
    if (!message.trim()) { setError('Message is required.'); return }

    setSending(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setSending(false)
      setError('Please sign in again before sending.')
      return
    }

    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        compose: true,
        to: to.trim(),
        subject: subject.trim() || `Invoice - ${invNum} from Brogrammers Agency`,
        body: bodyHtml,
        isHtml: true,
        accountId: selectedSendable.accountId,
        fromAddress: selectedSendable.email,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.error) {
      setSending(false)
      setError(data?.error ?? 'Could not send invoice email.')
      return
    }

    const threadId = data.threadId as string | undefined
    if (threadId) {
      await supabase.from('inbox_thread_assignments').insert({ thread_id: threadId, user_id: user.id }).then(({ error }) => {
        if (error && error.code !== '23505') console.warn('[InvoiceEmailDraft] assignment failed', error.message)
      })
      await supabase.from('inbox_threads').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', threadId)
    }

    if (invoice.status === 'draft') {
      await supabase.from('invoices').update({ status: 'unpaid', updated_at: new Date().toISOString() }).eq('id', invoice.id)
    }

    setSuccessThreadId(threadId ?? null)
    setSending(false)
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading invoice email draft…</div>
  }

  if (error && !invoice) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link to="/invoices" className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1 mb-4">
          <ArrowLeft size={16} /> Back to Invoices
        </Link>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-300">{error}</div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <Link to={invoice ? `/invoices/${invoice.id}` : '/invoices'} className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1">
        <ArrowLeft size={16} /> Back to Invoice
      </Link>

      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
            <Mail size={24} className="text-gray-400" /> Send Invoice To Client
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Compose and send {invNum} through the Inbox module. The sent email will create a closed Inbox thread assigned to you.
          </p>
        </div>
        {successThreadId && (
          <Link to={`/inbox/${successThreadId}`} className="inline-flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300 hover:bg-green-500/20">
            <CheckCircle size={16} /> View sent thread
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {successThreadId && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-300 flex items-start gap-2">
          <CheckCircle size={16} className="mt-0.5 shrink-0" /> Invoice email sent, assigned to you, and the Inbox thread is closed.
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-sm font-medium text-white">
          <Mail size={16} className="text-gray-400" /> New Email
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">From</label>
              <select
                value={selectedFrom}
                onChange={(e) => setSelectedFrom(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {sendableAddresses.length === 0 ? (
                  <option value="">No active inbox accounts</option>
                ) : sendableAddresses.map((addr) => (
                  <option key={`${addr.accountId}:${addr.email}`} value={addr.email}>{addr.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">To</label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="client@example.com"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={16}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              This is the actual email body that will be sent through Inbox. Edit it like a normal compose message.
            </p>
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-gray-400 space-y-1">
            <div><span className="text-gray-500">Invoice:</span> <span className="text-gray-200">{invNum}</span></div>
            <div><span className="text-gray-500">Amount due:</span> <span className="text-gray-200">{fmtCurrency(invoice?.amount_due ?? invoice?.total ?? 0)}</span></div>
            <div><span className="text-gray-500">Client:</span> <span className="text-gray-200">{contact?.name || company?.name || '—'}</span></div>
            <div><span className="text-gray-500">Pay link:</span> <span className="text-gray-200 break-all">{payUrl || 'Missing invoice hash'}</span></div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !!successThreadId}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={16} /> {sending ? 'Sending…' : successThreadId ? 'Sent' : 'Send Invoice To Client'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
