export type InvoiceEmailRow = {
  id: string
  prefix: string | null
  number: number | null
  status: string
  issue_date: string | null
  due_date: string | null
  amount_due: number | null
  total: number | null
  hash: string | null
  email_sent_at?: string | null
  email_sent_thread_id?: string | null
}

/** How the invoice email should be worded when composing or drafting. */
export type InvoiceEmailKind = 'initial' | 'resend' | 'overdue_followup'

export type InvoiceInboxDraftKind = Extract<InvoiceEmailKind, 'resend' | 'overdue_followup'>

export const INVOICE_INBOX_DRAFT_QUERY_PARAMS: Record<InvoiceInboxDraftKind, string> = {
  resend: 'resendInvoice',
  overdue_followup: 'followUpInvoice',
}

export function fmtInvoiceCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value ?? 0)
}

export function fmtInvoiceDate(date: string | null | undefined): string {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function invoiceNumberFromRow(inv: Pick<InvoiceEmailRow, 'prefix' | 'number'> | null): string {
  if (!inv) return ''
  const prefix = (inv.prefix ?? 'INV-').replace(/-+$/, '')
  if (!inv.number) return `${prefix}-DRAFT`
  return `${prefix}-${String(inv.number).padStart(4, '0')}`
}

export function isInvoiceResend(inv: Pick<InvoiceEmailRow, 'email_sent_at' | 'status'>): boolean {
  return Boolean(inv.email_sent_at) || !['draft', 'paid', 'cancelled'].includes(inv.status)
}

function startOfTodayLocal(): Date {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

export function isInvoiceOverdue(inv: Pick<InvoiceEmailRow, 'due_date' | 'status'>): boolean {
  if (!inv.due_date) return false
  if (['paid', 'cancelled', 'draft'].includes(inv.status)) return false
  const dueDate = new Date(`${inv.due_date}T00:00:00`)
  return dueDate < startOfTodayLocal()
}

export function canFollowUpOverdueInvoice(
  inv: Pick<InvoiceEmailRow, 'due_date' | 'status' | 'email_sent_at' | 'email_sent_thread_id'>,
): boolean {
  return isInvoiceOverdue(inv) && isInvoiceResend(inv) && Boolean(inv.email_sent_thread_id)
}

export function resolveInvoiceEmailKind(
  inv: Pick<InvoiceEmailRow, 'due_date' | 'status' | 'email_sent_at'>,
  preferred?: InvoiceInboxDraftKind,
): InvoiceEmailKind {
  if (preferred === 'overdue_followup' && isInvoiceOverdue(inv)) return 'overdue_followup'
  if (preferred === 'resend' || isInvoiceResend(inv)) return 'resend'
  return 'initial'
}

export function hasInvoiceSentThreadId(
  inv: Pick<InvoiceEmailRow, 'email_sent_thread_id'>,
): boolean {
  return Boolean(inv.email_sent_thread_id)
}

export function getInvoiceInboxDraftPath(
  inv: Pick<InvoiceEmailRow, 'id' | 'email_sent_thread_id'>,
  kind: InvoiceInboxDraftKind,
): string | null {
  if (!hasInvoiceSentThreadId(inv)) return null
  const param = INVOICE_INBOX_DRAFT_QUERY_PARAMS[kind]
  return `/inbox/${inv.email_sent_thread_id}?${param}=${inv.id}`
}

/** Inbox-thread resend path when a sent thread id exists; callers must verify the thread has real sent/received messages. */
export function getInvoiceSendPath(inv: Pick<InvoiceEmailRow, 'id' | 'email_sent_at' | 'email_sent_thread_id' | 'status'>): string {
  const inboxPath = getInvoiceInboxDraftPath(inv, 'resend')
  if (isInvoiceResend(inv) && inboxPath) return inboxPath
  return `/invoices/${inv.id}/send`
}

export function getInvoiceComposePath(inv: Pick<InvoiceEmailRow, 'id'>): string {
  return `/invoices/${inv.id}/send`
}

export function getInvoiceFollowUpPath(
  inv: Pick<InvoiceEmailRow, 'id' | 'due_date' | 'status' | 'email_sent_at' | 'email_sent_thread_id'>,
): string | null {
  if (!canFollowUpOverdueInvoice(inv)) return null
  return getInvoiceInboxDraftPath(inv, 'overdue_followup')
}

/** Compact shared styling for Send / Resend / Follow Up invoice actions (detail page, mobile). */
export const INVOICE_EMAIL_ACTION_BUTTON_BASE =
  'inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium leading-none shrink-0 whitespace-nowrap'

/** Icon-only square buttons for tight table/list action columns. */
export const INVOICE_EMAIL_ACTION_ICON_BUTTON_BASE =
  'inline-flex items-center justify-center size-7 rounded-md shrink-0'

export function invoiceEmailActionButtonClass(variant: 'send' | 'followup'): string {
  return variant === 'followup'
    ? `${INVOICE_EMAIL_ACTION_BUTTON_BASE} bg-red-600/90 text-white hover:bg-red-700`
    : `${INVOICE_EMAIL_ACTION_BUTTON_BASE} bg-blue-600/90 text-white hover:bg-blue-700`
}

export function invoiceEmailActionIconButtonClass(variant: 'send' | 'followup'): string {
  return variant === 'followup'
    ? `${INVOICE_EMAIL_ACTION_ICON_BUTTON_BASE} bg-red-600/90 text-white hover:bg-red-700`
    : `${INVOICE_EMAIL_ACTION_ICON_BUTTON_BASE} bg-blue-600/90 text-white hover:bg-blue-700`
}

export function getInvoiceEmailActionLabels(kind: InvoiceEmailKind): {
  short: string
  long: string
  composeTitle: string
  composeDescription: string
  draftCreatedToast: string
  draftUpdatedToast: string
} {
  switch (kind) {
    case 'resend':
      return {
        short: 'Resend',
        long: 'Resend Invoice To Client',
        composeTitle: 'Resend Invoice To Client',
        composeDescription: 'Compose and resend this invoice through the Inbox module.',
        draftCreatedToast: 'Invoice resend draft created in this thread',
        draftUpdatedToast: 'Invoice resend draft updated in this thread',
      }
    case 'overdue_followup':
      return {
        short: 'Follow Up',
        long: 'Follow Up on Overdue Invoice',
        composeTitle: 'Follow Up on Overdue Invoice',
        composeDescription: 'Compose a payment reminder for this overdue invoice in the existing Inbox thread.',
        draftCreatedToast: 'Overdue invoice follow-up draft created in this thread',
        draftUpdatedToast: 'Overdue invoice follow-up draft updated in this thread',
      }
    default:
      return {
        short: 'Send',
        long: 'Send Invoice To Client',
        composeTitle: 'Send Invoice To Client',
        composeDescription: 'Compose and send this invoice through the Inbox module.',
        draftCreatedToast: 'Invoice draft created in this thread',
        draftUpdatedToast: 'Invoice draft updated in this thread',
      }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function buildEmailMetaRow(label: string, value: string): string {
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #e5e7eb;">',
    '<tr>',
    `<td style="padding:12px 0;color:#6b7280;font-size:13px;font-weight:700;">${label}</td>`,
    `<td align="right" style="padding:12px 0;color:#111827;font-size:14px;font-weight:700;">${value}</td>`,
    '</tr>',
    '</table>',
  ].join('')
}

type InvoiceMessageFields = {
  contactName: string
  invoiceAmountDue: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  payUrl: string
  signature: string
}

function buildInvoiceDetailsBlock(args: InvoiceMessageFields): string {
  const payUrl = escapeHtml(args.payUrl)
  return [
    '<h3>INVOICE AMOUNT</h3>',
    `<p><strong>${escapeHtml(args.invoiceAmountDue)}</strong></p>`,
    `<p><span>Invoice No</span><strong>${escapeHtml(args.invoiceNumber)}</strong></p>`,
    `<p><span>Invoice Date</span><strong>${escapeHtml(args.invoiceDate)}</strong></p>`,
    `<p><span>Due Date</span><strong>${escapeHtml(args.dueDate)}</strong></p>`,
    `<p><a href="${payUrl}"><strong>PAY NOW</strong></a></p>`,
  ].join('')
}

function buildInitialInvoiceMessage(args: InvoiceMessageFields): string {
  const signatureHtml = escapeHtml(args.signature).replace(/\n/g, '<br />')
  return [
    '<h2>Invoice from Brogrammers Agency</h2>',
    `<p>Dear ${escapeHtml(args.contactName)},</p>`,
    '<p>Thank you for your business. Your invoice can be viewed, printed and downloaded as PDF from the link below. You can also choose to pay it online.</p>',
    buildInvoiceDetailsBlock(args),
    '<p>Please contact us for more information.</p>',
    `<p>Kind Regards,<br />${signatureHtml}</p>`,
  ].join('')
}

function buildResendInvoiceMessage(args: InvoiceMessageFields): string {
  const signatureHtml = escapeHtml(args.signature).replace(/\n/g, '<br />')
  return [
    '<h2>Invoice Reminder from Brogrammers Agency</h2>',
    `<p>Dear ${escapeHtml(args.contactName)},</p>`,
    `<p>This is a friendly reminder regarding invoice <strong>${escapeHtml(args.invoiceNumber)}</strong>. We are resending it here for your records. You can view, print, or download the invoice as a PDF from the link below, and pay online if you prefer.</p>`,
    buildInvoiceDetailsBlock(args),
    '<p>If you have already sent payment, please disregard this message. Otherwise, let us know if you have any questions.</p>',
    `<p>Kind Regards,<br />${signatureHtml}</p>`,
  ].join('')
}

function buildOverdueFollowUpMessage(args: InvoiceMessageFields): string {
  const signatureHtml = escapeHtml(args.signature).replace(/\n/g, '<br />')
  return [
    '<h2>Overdue Invoice Follow-Up</h2>',
    `<p>Dear ${escapeHtml(args.contactName)},</p>`,
    `<p>Our records show that invoice <strong>${escapeHtml(args.invoiceNumber)}</strong> was due on <strong>${escapeHtml(args.dueDate)}</strong> and remains unpaid.</p>`,
    '<p>Please review the invoice details below and submit payment at your earliest convenience. If payment has already been sent, or if you need more time, reply to this email and we will update our records.</p>',
    buildInvoiceDetailsBlock(args),
    '<p>Thank you for your prompt attention to this matter.</p>',
    `<p>Kind Regards,<br />${signatureHtml}</p>`,
  ].join('')
}

function buildInvoiceMessage(kind: InvoiceEmailKind, args: InvoiceMessageFields): string {
  switch (kind) {
    case 'resend':
      return buildResendInvoiceMessage(args)
    case 'overdue_followup':
      return buildOverdueFollowUpMessage(args)
    default:
      return buildInitialInvoiceMessage(args)
  }
}

function buildInvoiceSubject(kind: InvoiceEmailKind, invoiceNumber: string): string {
  switch (kind) {
    case 'resend':
      return `Reminder: Invoice - ${invoiceNumber} from Brogrammers Agency`
    case 'overdue_followup':
      return `Overdue: Invoice - ${invoiceNumber} from Brogrammers Agency`
    default:
      return `Invoice - ${invoiceNumber} from Brogrammers Agency`
  }
}

export function finalizeInvoiceEmailHtml(html: string): string {
  let out = html

  out = out.replace(/<h2>(.*?)<\/h2>/gis, (_match, title: string) => (
    `<h2 style="margin:0 0 20px;color:#111827;font-size:22px;line-height:1.3;font-weight:800;">${title}</h2>`
  ))

  out = out.replace(/<h3>\s*INVOICE AMOUNT\s*<\/h3>\s*<p>\s*<strong>(.*?)<\/strong>\s*<\/p>/is, (_match, amount: string) => ([
    '<div style="margin:24px 0 18px;padding:18px 20px;border-radius:14px;background:#f3f6fb;border:1px solid #dbe4f0;">',
    '<div style="margin:0 0 8px;color:#475569;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">Invoice Amount</div>',
    `<div style="color:#111827;font-size:24px;line-height:1.2;font-weight:800;">${amount}</div>`,
    '</div>',
  ].join('')))

  out = out.replace(/<p>\s*(?:<span>)?\s*(Invoice No|Invoice Date|Due Date)\s*(?:<\/span>)?\s*<strong>(.*?)<\/strong>\s*<\/p>/gis, (_match, label: string, value: string) => (
    buildEmailMetaRow(label, value)
  ))

  out = out.replace(/<p>\s*<a\s+href="([^"]+)"[^>]*>\s*(?:<strong>)?\s*PAY NOW\s*(?:<\/strong>)?\s*<\/a>\s*<\/p>/is, (_match, href: string) => (
    `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;padding:13px 28px;border-radius:999px;background:#2563eb;color:#ffffff;text-decoration:none;font-size:13px;font-weight:800;letter-spacing:0.04em;">PAY NOW</a></p>`
  ))

  out = out.replace(/<p>/gi, '<p style="margin:0 0 14px;color:#111827;font-size:14px;line-height:1.65;">')

  return [
    '<div style="margin:0;padding:0;background:#ffffff;">',
    '<div style="max-width:680px;margin:0;padding:32px 28px;font-family:Arial,Helvetica,sans-serif;color:#111827;">',
    out,
    '</div>',
    '</div>',
  ].join('')
}

export function splitContactName(name: string | null | undefined): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: 'there', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

export const DEFAULT_INVOICE_EMAIL_SIGNATURE = 'Jay Logan\nBrogrammers Agency'

export function buildInvoiceEmailContent(args: {
  invoiceRow: InvoiceEmailRow
  contactName: string
  signature?: string
  origin?: string
  kind?: InvoiceEmailKind
}) {
  const kind = args.kind ?? resolveInvoiceEmailKind(args.invoiceRow)
  const number = invoiceNumberFromRow(args.invoiceRow)
  const payOrigin = args.origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  const messageFields: InvoiceMessageFields = {
    contactName: args.contactName,
    invoiceAmountDue: fmtInvoiceCurrency(args.invoiceRow.amount_due ?? args.invoiceRow.total ?? 0),
    invoiceNumber: number,
    invoiceDate: fmtInvoiceDate(args.invoiceRow.issue_date),
    dueDate: fmtInvoiceDate(args.invoiceRow.due_date),
    payUrl: args.invoiceRow.hash ? `${payOrigin}/invoice/${args.invoiceRow.hash}` : '',
    signature: args.signature ?? DEFAULT_INVOICE_EMAIL_SIGNATURE,
  }

  return {
    kind,
    number,
    subject: buildInvoiceSubject(kind, number),
    message: buildInvoiceMessage(kind, messageFields),
  }
}

export function buildFinalizedInvoiceEmailHtml(args: Parameters<typeof buildInvoiceEmailContent>[0]): string {
  const { message } = buildInvoiceEmailContent(args)
  return finalizeInvoiceEmailHtml(message)
}
