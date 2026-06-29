import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Send, Mail, Eye, CheckCircle, AlertCircle } from 'lucide-react'
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

function buildInvoiceEmailHtml(args: {
  contactName: string
  invoiceAmountDue: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  payUrl: string
  signature: string
}) {
  const signatureHtml = escapeHtml(args.signature).replace(/\n/g, '<br />')
  return `
<div style="margin:0;padding:0;background:#f6f8fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
  <div style="max-width:640px;margin:0 auto;padding:28px 18px;">
    <div style="background:#ffffff;border:1px solid #e6eaf0;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
      <div style="background:#111827;color:#ffffff;padding:22px 28px;">
        <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;">Brogrammers Agency</div>
        <h1 style="margin:8px 0 0;font-size:24px;line-height:1.25;">Invoice ${escapeHtml(args.invoiceNumber)}</h1>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Dear ${escapeHtml(args.contactName)},</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#374151;">
          Thank you for your business. Your invoice can be viewed, printed and downloaded as PDF from the link below. You can also choose to pay it online.
        </p>

        <div style="border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:0 0 24px;">
          <div style="background:#f9fafb;padding:18px 20px;text-align:center;border-bottom:1px solid #e5e7eb;">
            <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Invoice Amount</div>
            <div style="font-size:30px;font-weight:800;color:#111827;margin-top:6px;">${escapeHtml(args.invoiceAmountDue)}</div>
          </div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
            <tr>
              <td style="padding:14px 18px;border-bottom:1px solid #eef0f3;color:#6b7280;font-size:13px;">Invoice No</td>
              <td style="padding:14px 18px;border-bottom:1px solid #eef0f3;text-align:right;font-weight:700;color:#111827;">${escapeHtml(args.invoiceNumber)}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-bottom:1px solid #eef0f3;color:#6b7280;font-size:13px;">Invoice Date</td>
              <td style="padding:14px 18px;border-bottom:1px solid #eef0f3;text-align:right;font-weight:700;color:#111827;">${escapeHtml(args.invoiceDate)}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;color:#6b7280;font-size:13px;">Due Date</td>
              <td style="padding:14px 18px;text-align:right;font-weight:700;color:#111827;">${escapeHtml(args.dueDate)}</td>
            </tr>
          </table>
        </div>

        <div style="text-align:center;margin:26px 0;">
          <a href="${escapeHtml(args.payUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;letter-spacing:.04em;border-radius:999px;padding:14px 30px;">PAY NOW</a>
        </div>

        <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#374151;">Please contact us for more information.</p>
        <p style="margin:20px 0 0;font-size:15px;line-height:1.7;color:#374151;">Kind Regards,<br />${signatureHtml}</p>
      </div>
    </div>
  </div>
</div>`.trim()
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
  const [signature, setSignature] = useState('Jay Logan\nBrogrammers Agency')
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
  const contactNameParts = splitContactName(contact?.name)
  const contactDisplayName = [contactNameParts.first, contactNameParts.last].filter(Boolean).join(' ')
  const payUrl = invoice?.hash ? `${window.location.origin}/invoice/${invoice.hash}` : ''
  const emailHtml = useMemo(() => buildInvoiceEmailHtml({
    contactName: contactDisplayName || 'there',
    invoiceAmountDue: fmtCurrency(invoice?.amount_due ?? invoice?.total ?? 0),
    invoiceNumber: invNum,
    invoiceDate: fmtDate(invoice?.issue_date),
    dueDate: fmtDate(invoice?.due_date),
    payUrl,
    signature,
  }), [contactDisplayName, invoice?.amount_due, invoice?.total, invoice?.issue_date, invoice?.due_date, invNum, payUrl, signature])

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
        setContact(primaryContact as ContactInfo)
        setTo((primaryContact as ContactInfo).email ?? '')
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
        setContact(linkedContact as ContactInfo)
        setTo((linkedContact as ContactInfo).email ?? '')
      }
    }

    if (invoiceRow.company_id) {
      const { data: companyRow } = await supabase
        .from('companies')
        .select('id, name')
        .eq('id', invoiceRow.company_id)
        .maybeSingle()
      setCompany((companyRow as CompanyInfo | null) ?? null)
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
        body: emailHtml,
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
            Preview and send {invNum} through the Inbox module. The sent email will create a closed Inbox thread assigned to you.
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

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        <div className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-4 h-fit">
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
            <p className="mt-1 text-xs text-gray-500">Autopopulated from {contact?.name || company?.name || 'the invoice contact'}.</p>
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
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">Email signature</label>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-gray-400 space-y-1">
            <div><span className="text-gray-500">Invoice:</span> <span className="text-gray-200">{invNum}</span></div>
            <div><span className="text-gray-500">Amount due:</span> <span className="text-gray-200">{fmtCurrency(invoice?.amount_due ?? invoice?.total ?? 0)}</span></div>
            <div><span className="text-gray-500">Client:</span> <span className="text-gray-200">{contact?.name || company?.name || '—'}</span></div>
            <div><span className="text-gray-500">Pay link:</span> <span className="text-gray-200 break-all">{payUrl || 'Missing invoice hash'}</span></div>
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !!successThreadId}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={16} /> {sending ? 'Sending…' : successThreadId ? 'Sent' : 'Send Invoice To Client'}
          </button>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-sm font-medium text-white">
            <Eye size={16} className="text-gray-400" /> Email Preview
          </div>
          <iframe
            title="Invoice email preview"
            srcDoc={emailHtml}
            className="w-full h-[720px] bg-white"
            sandbox="allow-popups allow-top-navigation-by-user-activation"
          />
        </div>
      </div>
    </div>
  )
}
