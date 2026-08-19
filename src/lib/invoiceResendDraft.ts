import { supabase } from '@/lib/supabase'
import {
  buildFinalizedInvoiceEmailHtml,
  buildInvoiceEmailContent,
  splitContactName,
  type InvoiceEmailRow,
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

export type InvoiceResendDraftPayload = {
  invoiceId: string
  to: string
  subject: string
  html: string
  contactName: string
}

export async function loadInvoiceResendDraftPayload(
  invoiceId: string,
  orgId: string,
): Promise<{ payload?: InvoiceResendDraftPayload; error?: string }> {
  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('id, org_id, prefix, number, status, issue_date, due_date, amount_due, total, hash, contact_id, company_id, is_recurring, direction')
    .eq('id', invoiceId)
    .eq('org_id', orgId)
    .single()

  if (invErr || !inv) {
    return { error: invErr?.message ?? 'Invoice not found' }
  }

  type LoadedInvoice = InvoiceEmailRow & {
    org_id: string
    contact_id: string | null
    company_id: string | null
    is_recurring?: boolean | null
    direction: string
  }
  const invoiceRow = inv as LoadedInvoice

  if (invoiceRow.is_recurring) {
    return { error: 'Recurring invoice templates cannot be sent to clients.' }
  }
  if (invoiceRow.direction !== 'outbound') {
    return { error: 'Only outbound invoices can be sent to clients.' }
  }
  if (['paid', 'cancelled'].includes(invoiceRow.status)) {
    return { error: 'Paid or cancelled invoices cannot be resent.' }
  }
  if (!invoiceRow.hash) {
    return { error: 'This invoice does not have a public payment link yet.' }
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
  })

  return {
    payload: {
      invoiceId,
      to,
      subject: emailContent.subject,
      html: buildFinalizedInvoiceEmailHtml({ invoiceRow, contactName }),
      contactName,
    },
  }
}
