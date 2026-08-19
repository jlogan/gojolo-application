import { supabase } from '@/lib/supabase'
import {
  buildFinalizedInvoiceEmailHtml,
  buildInvoiceEmailContent,
  getInvoiceEmailActionLabels,
  isInvoiceOverdue,
  isInvoiceResend,
  resolveInvoiceEmailKind,
  splitContactName,
  type InvoiceEmailRow,
  type InvoiceInboxDraftKind,
} from '@/lib/invoiceEmailContent'

type ContactInfo = { name: string | null; email: string | null }

function normalizeRecipientEmail(contacts: ContactInfo[]): string {
  for (const contact of contacts) {
    const email = contact.email?.trim()
    if (email && email.includes('@')) return email
  }
  return ''
}

type LoadedInvoice = InvoiceEmailRow & {
  contact_id: string | null
  company_id: string | null
}

async function loadInvoiceRecipients(invoiceId: string, orgId: string, invoiceRow: LoadedInvoice): Promise<ContactInfo[]> {
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
  kind: InvoiceInboxDraftKind
  to: string
  subject: string
  html: string
  contactName: string
}

/** @deprecated Use InvoiceInboxDraftPayload */
export type InvoiceResendDraftPayload = InvoiceInboxDraftPayload

function validateInvoiceForInboxDraft(
  invoiceRow: LoadedInvoice & { org_id: string; is_recurring?: boolean | null; direction: string },
  kind: InvoiceInboxDraftKind,
): string | null {
  if (invoiceRow.is_recurring) {
    return 'Recurring invoice templates cannot be sent to clients.'
  }
  if (invoiceRow.direction !== 'outbound') {
    return 'Only outbound invoices can be sent to clients.'
  }
  if (['paid', 'cancelled'].includes(invoiceRow.status)) {
    return kind === 'overdue_followup'
      ? 'Paid or cancelled invoices cannot receive overdue follow-ups.'
      : 'Paid or cancelled invoices cannot be resent.'
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

export async function loadInvoiceInboxDraftPayload(
  invoiceId: string,
  orgId: string,
  kind: InvoiceInboxDraftKind,
): Promise<{ payload?: InvoiceInboxDraftPayload; error?: string }> {
  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('id, org_id, prefix, number, status, issue_date, due_date, amount_due, total, hash, contact_id, company_id, is_recurring, direction, email_sent_at')
    .eq('id', invoiceId)
    .eq('org_id', orgId)
    .single()

  if (invErr || !inv) {
    return { error: invErr?.message ?? 'Invoice not found' }
  }

  type LoadedInvoiceWithMeta = LoadedInvoice & {
    org_id: string
    is_recurring?: boolean | null
    direction: string
    email_sent_at?: string | null
  }
  const invoiceRow = inv as LoadedInvoiceWithMeta

  const validationError = validateInvoiceForInboxDraft(invoiceRow, kind)
  if (validationError) {
    return { error: validationError }
  }

  const recipients = await loadInvoiceRecipients(invoiceId, orgId, invoiceRow)
  const to = normalizeRecipientEmail(recipients)
  if (!to) {
    return { error: 'No recipient email is available for this invoice.' }
  }

  const contactNameParts = splitContactName(recipients[0]?.name)
  const contactName = [contactNameParts.first, contactNameParts.last].filter(Boolean).join(' ') || 'there'
  const emailKind = resolveInvoiceEmailKind(invoiceRow, kind)
  const emailContent = buildInvoiceEmailContent({
    invoiceRow,
    contactName,
    kind: emailKind,
  })

  return {
    payload: {
      invoiceId,
      kind,
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

export function invoiceInboxDraftToastMessage(kind: InvoiceInboxDraftKind, updated: boolean): string {
  const labels = getInvoiceEmailActionLabels(kind)
  return updated ? labels.draftUpdatedToast : labels.draftCreatedToast
}

export function invoiceInboxDraftFailureMessage(kind: InvoiceInboxDraftKind): string {
  return kind === 'overdue_followup'
    ? 'Could not prepare overdue invoice follow-up draft'
    : 'Could not prepare invoice resend draft'
}
