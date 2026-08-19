import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Mail, CheckCircle, AlertCircle } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import EmailComposeForm from '@/components/inbox/EmailComposeForm'
import {
  buildInvoiceEmailContent,
  finalizeInvoiceEmailHtml,
  getInvoiceInboxDraftPath,
  invoiceNumberFromRow,
  isInvoiceResend,
  resolveInvoiceEmailKind,
  getInvoiceEmailActionLabels,
  splitContactName,
  DEFAULT_INVOICE_EMAIL_SIGNATURE,
  type InvoiceEmailRow,
} from '@/lib/invoiceEmailContent'
import {
  clearStaleInvoiceSentThreadLink,
  resolveUsableInvoiceSentThreadId,
} from '@/lib/invoiceEmailThread'

type Invoice = InvoiceEmailRow & {
  org_id: string
  direction: 'outbound' | 'inbound'
  company_id: string | null
  contact_id: string | null
  is_recurring?: boolean | null
  email_sent_at: string | null
  email_sent_thread_id: string | null
}

type ContactInfo = { id: string; name: string | null; email: string | null; company_id?: string | null }
type CompanyInfo = { id: string; name: string | null }
type RecipientOption = { name: string; email: string }
type ImapAccount = { id: string; email: string; label: string | null; addresses: string[] | null }
type SendableAddress = { accountId: string; email: string; label: string }

async function ensureInvoiceNumber(inv: Invoice, orgId: string): Promise<{ invoice: Invoice; error?: string }> {
  if (inv.is_recurring) {
    return { invoice: inv, error: 'Recurring invoice templates cannot be sent to clients.' }
  }
  if (inv.number != null) {
    return { invoice: inv }
  }

  const { data: numData, error: numErr } = await supabase.rpc('next_invoice_number', {
    p_org_id: orgId,
    p_direction: inv.direction,
  })
  if (numErr || numData == null) {
    return { invoice: inv, error: numErr?.message ?? 'Could not assign invoice number.' }
  }

  const { data: updated, error: updateErr } = await supabase
    .from('invoices')
    .update({ number: numData as number, updated_at: new Date().toISOString() })
    .eq('id', inv.id)
    .select('*')
    .single()

  if (updateErr || !updated) {
    return { invoice: inv, error: updateErr?.message ?? 'Could not save invoice number.' }
  }

  return { invoice: updated as Invoice }
}

function normalizeRecipientOptions(contacts: ContactInfo[]): RecipientOption[] {
  const seen = new Set<string>()
  return contacts
    .map((c) => ({
      name: c.name?.trim() || c.email?.trim() || 'Contact',
      email: c.email?.trim() || '',
    }))
    .filter((c) => {
      const key = c.email.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export default function InvoiceEmailDraft() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg, isVendor } = useOrg()
  const { user } = useAuth()

  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [contact, setContact] = useState<ContactInfo | null>(null)
  const [company, setCompany] = useState<CompanyInfo | null>(null)
  const [accounts, setAccounts] = useState<ImapAccount[]>([])
  const [recipientOptions, setRecipientOptions] = useState<RecipientOption[]>([])
  const [selectedFrom, setSelectedFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [to, setTo] = useState('')
  const signature = DEFAULT_INVOICE_EMAIL_SIGNATURE
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successThreadId, setSuccessThreadId] = useState<string | null>(null)
  const [usableSentThreadId, setUsableSentThreadId] = useState<string | null>(null)

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

  const invNum = invoiceNumberFromRow(invoice)
  const payUrl = invoice?.hash ? `${window.location.origin}/invoice/${invoice.hash}` : ''
  const emailKind = invoice ? resolveInvoiceEmailKind(invoice) : 'initial'
  const actionLabels = getInvoiceEmailActionLabels(emailKind)
  const resendThreadId = isInvoiceResend(invoice ?? { email_sent_at: null, status: 'draft' })
    ? usableSentThreadId
    : null

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
    if (invoiceRow.is_recurring) {
      setInvoice(invoiceRow)
      setError('Recurring invoice templates cannot be sent to clients.')
      setLoading(false)
      return
    }

    const ensured = await ensureInvoiceNumber(invoiceRow, currentOrg.id)
    if (ensured.error) {
      setInvoice(invoiceRow)
      setError(ensured.error)
      setLoading(false)
      return
    }

    const readyInvoice = ensured.invoice
    if (isInvoiceResend(readyInvoice) && readyInvoice.email_sent_thread_id) {
      const usableThreadId = await resolveUsableInvoiceSentThreadId(readyInvoice.email_sent_thread_id)
      if (usableThreadId) {
        const inboxDraftPath = getInvoiceInboxDraftPath({ ...readyInvoice, email_sent_thread_id: usableThreadId }, 'resend')
        if (inboxDraftPath) {
          navigate(inboxDraftPath, { replace: true })
          return
        }
      }
      await clearStaleInvoiceSentThreadLink(readyInvoice.id, readyInvoice.email_sent_thread_id)
      readyInvoice.email_sent_thread_id = null
      setUsableSentThreadId(null)
    } else {
      setUsableSentThreadId(null)
    }

    let loadedContact: ContactInfo | null = null
    let loadedCompany: CompanyInfo | null = null
    setInvoice(readyInvoice)

    const invoiceContactRows: ContactInfo[] = []
    const { data: invoiceContacts } = await supabase
      .from('invoice_contacts')
      .select('is_primary, contacts(id, name, email, company_id)')
      .eq('invoice_id', invoiceRow.id)
      .order('is_primary', { ascending: false })

    ;(invoiceContacts ?? []).forEach((row) => {
      const linked = row.contacts
      const linkedContact = Array.isArray(linked) ? linked[0] : linked
      if (linkedContact) invoiceContactRows.push(linkedContact as ContactInfo)
    })

    if (invoiceContactRows.length > 0) {
      loadedContact = invoiceContactRows[0]
      setContact(loadedContact)
    } else if (invoiceRow.contact_id) {
      const { data: primaryContact } = await supabase
        .from('contacts')
        .select('id, name, email, company_id')
        .eq('id', invoiceRow.contact_id)
        .maybeSingle()
      if (primaryContact) {
        loadedContact = primaryContact as ContactInfo
        setContact(loadedContact)
        invoiceContactRows.push(loadedContact)
      }
    }

    const companyContactRows: ContactInfo[] = []
    if (invoiceRow.company_id) {
      const { data: companyContacts } = await supabase
        .from('contacts')
        .select('id, name, email, company_id')
        .eq('org_id', currentOrg.id)
        .eq('company_id', invoiceRow.company_id)
        .order('name')
      companyContactRows.push(...(((companyContacts as ContactInfo[] | null) ?? [])))
    }

    const recipients = normalizeRecipientOptions([...invoiceContactRows, ...companyContactRows])
    setRecipientOptions(recipients)
    if (recipients[0]) setTo(recipients[0].email)

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
    const flattenedAddresses = activeAccounts.flatMap((account) => [account.email, ...((account.addresses ?? []) as string[])])
    const preferredFrom = flattenedAddresses.find((email) => email?.trim().toLowerCase() === 'jay@jaylogan.com')
    if (preferredFrom) setSelectedFrom(preferredFrom.trim().toLowerCase())
    else if (activeAccounts[0]) setSelectedFrom(activeAccounts[0].email)

    const loadedContactNameParts = splitContactName(loadedContact?.name)
    const loadedContactName = [loadedContactNameParts.first, loadedContactNameParts.last].filter(Boolean).join(' ')
    const emailContent = buildInvoiceEmailContent({
      invoiceRow: readyInvoice,
      contactName: loadedContactName || 'there',
      signature,
      kind: resolveInvoiceEmailKind(readyInvoice),
    })
    setSubject(emailContent.subject)
    setMessage(emailContent.message)

    setLoading(false)
  }, [currentOrg?.id, id, navigate, signature])

  useEffect(() => { load() }, [load])

  const handleSend = async () => {
    if (!invoice || !user?.id || !currentOrg?.id || sending) return
    setError(null)
    if (isVendor) { setError('Vendors cannot send invoices.'); return }
    if (invoice.direction !== 'outbound') { setError('Only outbound invoices can be sent to clients.'); return }
    if (invoice.is_recurring) { setError('Recurring invoice templates cannot be sent to clients.'); return }
    if (['paid', 'cancelled'].includes(invoice.status)) { setError('Paid or cancelled invoices cannot be sent.'); return }
    const recipients = to.split(',').map((email) => email.trim()).filter(Boolean)
    if (recipients.length === 0 || recipients.some((email) => !email.includes('@'))) { setError('Enter at least one valid recipient email.'); return }
    if (!selectedSendable) { setError('No active inbox email account is available for sending.'); return }
    if (!payUrl) { setError('This invoice does not have a public payment link yet.'); return }
    if (!message.trim()) { setError('Message is required.'); return }

    setSending(true)
    const ensured = await ensureInvoiceNumber(invoice, currentOrg.id)
    if (ensured.error) {
      setSending(false)
      setError(ensured.error)
      return
    }

    let sendInvoice = ensured.invoice
    let sendSubject = subject.trim()
    let sendMessage = message
    if (sendInvoice.number !== invoice.number) {
      setInvoice(sendInvoice)
      const loadedContactNameParts = splitContactName(contact?.name)
      const loadedContactName = [loadedContactNameParts.first, loadedContactNameParts.last].filter(Boolean).join(' ')
      const emailContent = buildInvoiceEmailContent({
        invoiceRow: sendInvoice,
        contactName: loadedContactName || 'there',
        signature,
        kind: resolveInvoiceEmailKind(sendInvoice),
      })
      sendSubject = emailContent.subject
      sendMessage = emailContent.message
      setSubject(sendSubject)
      setMessage(sendMessage)
    }

    const sendNum = invoiceNumberFromRow(sendInvoice)
    if (!sendInvoice.number) {
      setSending(false)
      setError('This invoice does not have an invoice number yet.')
      return
    }

    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setSending(false)
      setError('Please sign in again before sending.')
      return
    }

    const sendHtml = finalizeInvoiceEmailHtml(sendMessage)
    const useExistingThread = Boolean(resendThreadId)
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        ...(useExistingThread ? { threadId: resendThreadId } : { compose: true }),
        to: recipients.join(', '),
        subject: sendSubject || `Invoice - ${sendNum} from Brogrammers Agency`,
        body: sendHtml,
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

    const sentUpdate: Record<string, string> = { updated_at: new Date().toISOString(), email_sent_at: new Date().toISOString() }
    if (threadId) sentUpdate.email_sent_thread_id = threadId
    if (sendInvoice.status === 'draft') sentUpdate.status = 'unpaid'
    await supabase.from('invoices').update(sentUpdate).eq('id', sendInvoice.id)
    if (threadId) {
      await supabase
        .from('inbox_thread_invoices')
        .upsert({ thread_id: threadId, invoice_id: sendInvoice.id, created_by: user.id }, { onConflict: 'thread_id,invoice_id' })
        .then(({ error }) => {
          if (error) console.warn('[InvoiceEmailDraft] invoice/thread link failed', error.message)
        })
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
            <Mail size={24} className="text-gray-400" /> {actionLabels.composeTitle}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Compose and {emailKind === 'initial' ? 'send' : emailKind === 'resend' ? 'resend' : 'follow up on'} {invNum} through the Inbox module. The sent email will create a closed Inbox thread assigned to you.
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

      <div className="invoice-email-draft-compose">
        <EmailComposeForm
          modeLabel="New message"
          sendableAddresses={sendableAddresses}
          selectedFromAddress={selectedFrom}
          onFromAddressChange={(email) => setSelectedFrom(email)}
          to={to}
          onToChange={setTo}
          toOptions={recipientOptions}
          allowMultipleToOptions
          subject={subject}
          onSubjectChange={setSubject}
          html={message}
          onHtmlChange={setMessage}
          onSend={handleSend}
          sending={sending}
          sendDisabled={!!successThreadId || !to.trim()}
          sendLabel="Send"
          minHeight="min-h-[520px]"
          onCancel={() => window.history.back()}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-gray-400 space-y-1">
        <div><span className="text-gray-500">Invoice:</span> <span className="text-gray-200">{invNum}</span></div>
        <div><span className="text-gray-500">Amount due:</span> <span className="text-gray-200">{fmtCurrency(invoice?.amount_due ?? invoice?.total ?? 0)}</span></div>
        <div><span className="text-gray-500">Client:</span> <span className="text-gray-200">{contact?.name || company?.name || '—'}</span></div>
        <div><span className="text-gray-500">Pay link:</span> <span className="text-gray-200 break-all">{payUrl || 'Missing invoice hash'}</span></div>
      </div>
    </div>
  )
}

function fmtCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value ?? 0)
}
