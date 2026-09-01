import { supabase } from '@/lib/supabase'
import { prepareDraftHtmlForDisplay } from '@/lib/emailSanitizer'
import { linkInvoiceToThread } from '@/lib/invoiceEmailThread'
import {
  buildFinalizedInvoiceEmailHtml,
  buildInvoiceEmailContent,
  getInvoiceEmailActionLabels,
  isInvoiceOverdue,
  isInvoiceResend,
  resolveInvoiceEmailKind,
  resolveInvoiceDraftDisplayKind,
  splitContactName,
  type InvoiceEmailKind,
  type InvoiceEmailRow,
  type InvoiceInboxDraftKind,
} from '@/lib/invoiceEmailContent'

type ContactInfo = { name: string | null; email: string | null }

type LoadedInvoice = InvoiceEmailRow & {
  org_id: string
  contact_id: string | null
  company_id: string | null
  is_recurring?: boolean | null
  direction: string
}

type ImapAccount = { id: string; email: string; addresses: string[] | null }

function stripHtmlToPlain(html: string, maxLen = 100_000): string {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function normalizeRecipientEmail(contacts: ContactInfo[]): string {
  for (const contact of contacts) {
    const email = contact.email?.trim()
    if (email && email.includes('@')) return email
  }
  return ''
}

async function ensureInvoiceNumber(invoiceRow: LoadedInvoice, orgId: string): Promise<{ invoice: LoadedInvoice; error?: string }> {
  if (invoiceRow.number != null) {
    return { invoice: invoiceRow }
  }

  const { data: numData, error: numErr } = await supabase.rpc('next_invoice_number', {
    p_org_id: orgId,
    p_direction: invoiceRow.direction,
  })
  if (numErr || numData == null) {
    return { invoice: invoiceRow, error: numErr?.message ?? 'Could not assign invoice number.' }
  }

  const { data: updated, error: updateErr } = await supabase
    .from('invoices')
    .update({ number: numData as number, updated_at: new Date().toISOString() })
    .eq('id', invoiceRow.id)
    .select('id, org_id, prefix, number, status, issue_date, due_date, amount_due, total, hash, contact_id, company_id, is_recurring, direction, email_sent_at, email_sent_thread_id')
    .single()

  if (updateErr || !updated) {
    return { invoice: invoiceRow, error: updateErr?.message ?? 'Could not save invoice number.' }
  }

  return { invoice: updated as LoadedInvoice }
}

async function loadInvoiceRecipients(invoiceId: string, orgId: string, invoiceRow: Pick<LoadedInvoice, 'contact_id' | 'company_id'>): Promise<ContactInfo[]> {
  const rows: ContactInfo[] = []
  const { data: invoiceContacts } = await supabase
    .from('invoice_contacts')
    .select('is_primary, contacts(name, email)')
    .eq('invoice_id', invoiceId)
    .order('is_primary', { ascending: false })

  ;(invoiceContacts ?? []).forEach((row) => {
    const linked = row.contacts
    const linkedContact = Array.isArray(linked) ? linked[0] : linked
    if (linkedContact) rows.push(linkedContact as ContactInfo)
  })

  if (rows.length === 0 && invoiceRow.contact_id) {
    const { data: primaryContact } = await supabase
      .from('contacts')
      .select('name, email')
      .eq('id', invoiceRow.contact_id)
      .maybeSingle()
    if (primaryContact) rows.push(primaryContact as ContactInfo)
  }

  if (invoiceRow.company_id) {
    const { data: companyContacts } = await supabase
      .from('contacts')
      .select('name, email')
      .eq('org_id', orgId)
      .eq('company_id', invoiceRow.company_id)
      .order('name')
    rows.push(...(((companyContacts as ContactInfo[] | null) ?? [])))
  }

  return rows
}

export type InvoiceInboxDraftPayload = {
  invoiceId: string
  kind: InvoiceEmailKind
  status: string
  to: string
  subject: string
  html: string
  contactName: string
}

/** @deprecated Use InvoiceInboxDraftPayload */
export type InvoiceResendDraftPayload = InvoiceInboxDraftPayload

export type InvoiceInboxDraftResult = {
  threadId: string
  messageId: string
  invoiceId: string
  kind: InvoiceEmailKind
  status: string
}

function validateInvoiceForInboxDraft(
  invoiceRow: LoadedInvoice,
  kind: InvoiceEmailKind,
): string | null {
  if (invoiceRow.is_recurring) {
    return 'Recurring invoice templates cannot be sent to clients.'
  }
  if (invoiceRow.direction !== 'outbound') {
    return 'Only outbound invoices can be sent to clients.'
  }
  if (['paid', 'cancelled'].includes(invoiceRow.status)) {
    if (kind === 'overdue_followup') {
      return 'Paid or cancelled invoices cannot receive overdue follow-ups.'
    }
    return 'Paid or cancelled invoices cannot be sent.'
  }
  if (!invoiceRow.hash) {
    return 'This invoice does not have a public payment link yet.'
  }
  if (kind === 'overdue_followup') {
    if (!isInvoiceOverdue(invoiceRow)) {
      return 'This invoice is not overdue yet.'
    }
    if (!isInvoiceResend(invoiceRow)) {
      return 'Overdue follow-ups are only available after the invoice has been sent.'
    }
  }
  return null
}

function pickSendFromAddress(accounts: ImapAccount[]): { accountId: string; email: string } | null {
  const first = accounts[0]
  const email = first?.email?.trim()
  if (!first || !email) return null
  return { accountId: first.id, email }
}

export async function loadInvoiceInboxDraftPayload(
  invoiceId: string,
  orgId: string,
  preferredKind?: InvoiceEmailKind | InvoiceInboxDraftKind,
): Promise<{ payload?: InvoiceInboxDraftPayload; error?: string }> {
  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('id, org_id, prefix, number, status, issue_date, due_date, amount_due, total, hash, contact_id, company_id, is_recurring, direction, email_sent_at, email_sent_thread_id')
    .eq('id', invoiceId)
    .eq('org_id', orgId)
    .single()

  if (invErr || !inv) {
    return { error: invErr?.message ?? 'Invoice not found' }
  }

  let invoiceRow = inv as LoadedInvoice
  const emailKind = resolveInvoiceEmailKind(invoiceRow, preferredKind as InvoiceInboxDraftKind | undefined)

  const validationError = validateInvoiceForInboxDraft(invoiceRow, emailKind)
  if (validationError) {
    return { error: validationError }
  }

  if (emailKind === 'initial' && !invoiceRow.number) {
    const ensured = await ensureInvoiceNumber(invoiceRow, orgId)
    if (ensured.error) {
      return { error: ensured.error }
    }
    invoiceRow = ensured.invoice
  }

  const recipients = await loadInvoiceRecipients(invoiceId, orgId, invoiceRow)
  const to = normalizeRecipientEmail(recipients)
  if (!to) {
    return { error: 'No recipient email is available for this invoice.' }
  }

  const contactNameParts = splitContactName(recipients[0]?.name)
  const contactName = [contactNameParts.first, contactNameParts.last].filter(Boolean).join(' ') || 'there'
  const emailContent = buildInvoiceEmailContent({
    invoiceRow,
    contactName,
    kind: emailKind,
  })

  return {
    payload: {
      invoiceId,
      kind: emailKind,
      status: invoiceRow.status,
      to,
      subject: emailContent.subject,
      html: buildFinalizedInvoiceEmailHtml({ invoiceRow, contactName, kind: emailKind }),
      contactName,
    },
  }
}

export async function loadInvoiceResendDraftPayload(
  invoiceId: string,
  orgId: string,
): Promise<{ payload?: InvoiceInboxDraftPayload; error?: string }> {
  return loadInvoiceInboxDraftPayload(invoiceId, orgId, 'resend')
}

/** Regenerate canonical invoice draft subject/HTML for the inbox composer (correct resend/overdue copy). */
export async function refreshInvoiceInboxDraftEditorContent(args: {
  invoiceId: string
  orgId: string
  kind: InvoiceEmailKind
}): Promise<{ subject: string; html: string; storageHtml: string } | null> {
  const preferredKind = args.kind === 'initial' ? undefined : args.kind
  const { payload, error } = await loadInvoiceInboxDraftPayload(args.invoiceId, args.orgId, preferredKind)
  if (error || !payload) return null
  return {
    subject: payload.subject,
    storageHtml: payload.html,
    html: prepareDraftHtmlForDisplay(payload.html),
  }
}

export function resolveKindForInvoiceDraftEditor(args: {
  contextKind?: InvoiceEmailKind | null
  subject?: string | null
  html?: string | null
}): InvoiceEmailKind {
  return resolveInvoiceDraftDisplayKind(args)
}

/** Creates a new inbox thread + draft message for send/resend/overdue (never reuses the initial sent thread). */
export async function createInvoiceInboxDraft(
  invoiceId: string,
  orgId: string,
  preferredKind?: InvoiceEmailKind | InvoiceInboxDraftKind,
): Promise<{ result?: InvoiceInboxDraftResult; error?: string }> {
  const { payload, error } = await loadInvoiceInboxDraftPayload(invoiceId, orgId, preferredKind)
  if (error || !payload) {
    return { error: error ?? 'Could not prepare invoice draft' }
  }

  const { data: accountRows, error: accountErr } = await supabase
    .from('imap_accounts')
    .select('id, email, addresses')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('email')

  if (accountErr) {
    return { error: accountErr.message }
  }

  const fromAddress = pickSendFromAddress((accountRows as ImapAccount[]) ?? [])
  if (!fromAddress) {
    return { error: 'No active inbox email account is available for sending.' }
  }

  const now = new Date().toISOString()
  const { data: newThread, error: threadErr } = await supabase
    .from('inbox_threads')
    .insert({
      org_id: orgId,
      channel: 'email',
      status: 'open',
      subject: payload.subject,
      last_message_at: now,
      imap_account_id: fromAddress.accountId,
      from_address: fromAddress.email,
      mailbox_address: fromAddress.email.toLowerCase(),
    })
    .select('id')
    .single()

  if (threadErr || !newThread) {
    return { error: threadErr?.message ?? 'Could not create draft thread' }
  }

  const threadId = (newThread as { id: string }).id
  const draftPayload = {
    thread_id: threadId,
    channel: 'email' as const,
    direction: 'outbound' as const,
    from_identifier: fromAddress.email,
    to_identifier: payload.to,
    cc: null,
    html_body: payload.html,
    body: stripHtmlToPlain(payload.html),
    is_draft: true,
    imap_account_id: fromAddress.accountId,
    received_at: now,
  }

  const { data: draftMsg, error: draftErr } = await supabase
    .from('inbox_messages')
    .insert(draftPayload)
    .select('id')
    .single()

  if (draftErr || !draftMsg) {
    await supabase.from('inbox_threads').delete().eq('id', threadId)
    return { error: draftErr?.message ?? 'Could not create draft message' }
  }

  await linkInvoiceToThread(payload.invoiceId, threadId)

  const messageId = (draftMsg as { id: string }).id
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) {
    void fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-save-draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ messageId, action: 'save' }),
    }).catch(() => {})
  }

  return {
    result: {
      threadId,
      messageId,
      invoiceId: payload.invoiceId,
      kind: payload.kind,
      status: payload.status,
    },
  }
}

export function invoiceInboxDraftToastMessage(kind: InvoiceEmailKind, updated: boolean): string {
  const labels = getInvoiceEmailActionLabels(kind)
  return updated ? labels.draftUpdatedToast : labels.draftCreatedToast
}

export function invoiceInboxDraftFailureMessage(kind: InvoiceEmailKind): string {
  if (kind === 'overdue_followup') {
    return 'Could not prepare overdue invoice follow-up draft'
  }
  if (kind === 'resend') {
    return 'Could not prepare invoice resend draft'
  }
  return 'Could not prepare invoice draft'
}
