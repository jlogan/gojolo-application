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

/** Query param on legacy inbox thread URLs; redirected to invoice compose. */
export const INVOICE_INBOX_DRAFT_QUERY_PARAMS: Record<InvoiceInboxDraftKind, string> = {
  resend: 'resendInvoice',
  overdue_followup: 'followUpInvoice',
}

export const INVOICE_SEND_KIND_QUERY = 'kind'

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
  preferred?: InvoiceEmailKind | InvoiceInboxDraftKind,
): InvoiceEmailKind {
  if (preferred === 'initial') return 'initial'
  if (preferred === 'overdue_followup' && isInvoiceOverdue(inv)) return 'overdue_followup'
  if (preferred === 'resend' || isInvoiceResend(inv)) return 'resend'
  return 'initial'
}

/** Detect generated invoice email HTML (amount block + pay button + detail rows). */
export function isInvoiceEmailHtml(html: string | null | undefined): boolean {
  const trimmed = html?.trim()
  if (!trimmed) return false
  return trimmed.includes('Invoice Amount') && trimmed.includes('Invoice No') && trimmed.includes('PAY NOW')
}

export function inferInvoiceEmailKindFromSubject(subject: string | null | undefined): InvoiceEmailKind {
  const trimmed = (subject ?? '').trim()
  if (/^Overdue:\s*Invoice/i.test(trimmed)) return 'overdue_followup'
  if (/^Reminder:\s*Invoice/i.test(trimmed)) return 'resend'
  return 'initial'
}

export function inferInvoiceEmailKindFromHtml(html: string | null | undefined): InvoiceEmailKind | null {
  if (!isInvoiceEmailHtml(html)) return null
  const trimmed = html!.trim()
  if (trimmed.includes('Overdue Invoice Follow-Up')) return 'overdue_followup'
  if (trimmed.includes('Invoice Reminder')) return 'resend'
  if (trimmed.includes('Invoice from Brogrammers Agency')) return 'initial'
  return null
}

/** Prefer DB invoice draft HTML when IMAP reconcile returns stale or mismatched copy. */
export function shouldPreferExistingInvoiceDraftHtml(args: {
  existingHtml: string | null | undefined
  incomingHtml: string | null | undefined
  threadSubject?: string | null
}): boolean {
  if (!isInvoiceEmailHtml(args.existingHtml)) return false
  if (!args.incomingHtml?.trim()) return true
  if (!isInvoiceEmailHtml(args.incomingHtml)) return true
  const expectedKind = inferInvoiceEmailKindFromSubject(args.threadSubject)
  const existingKind = inferInvoiceEmailKindFromHtml(args.existingHtml)
  const incomingKind = inferInvoiceEmailKindFromHtml(args.incomingHtml)
  if (expectedKind !== 'initial' && incomingKind !== expectedKind) return true
  if (existingKind && incomingKind && existingKind !== incomingKind) return true
  return false
}

/** Prefer thread subject / navigation context over stored html_body (IMAP reconcile can leave stale copy). */
export function resolveInvoiceDraftDisplayKind(args: {
  contextKind?: InvoiceEmailKind | null
  subject?: string | null
  html?: string | null
}): InvoiceEmailKind {
  if (args.contextKind === 'overdue_followup' || args.contextKind === 'resend') return args.contextKind
  const fromSubject = inferInvoiceEmailKindFromSubject(args.subject)
  if (fromSubject !== 'initial') return fromSubject
  return inferInvoiceEmailKindFromHtml(args.html) ?? args.contextKind ?? 'initial'
}

export function getInvoiceSendPath(
  inv: Pick<InvoiceEmailRow, 'id'>,
  kind?: InvoiceInboxDraftKind,
): string {
  const base = `/invoices/${inv.id}/send`
  if (kind === 'overdue_followup') return `${base}?${INVOICE_SEND_KIND_QUERY}=overdue_followup`
  if (kind === 'resend') return `${base}?${INVOICE_SEND_KIND_QUERY}=resend`
  return base
}

/** @deprecated Use getInvoiceSendPath */
export function getInvoiceComposePath(inv: Pick<InvoiceEmailRow, 'id'>): string {
  return getInvoiceSendPath(inv)
}

export function getInvoiceFollowUpPath(
  inv: Pick<InvoiceEmailRow, 'id' | 'due_date' | 'status' | 'email_sent_at' | 'email_sent_thread_id'>,
): string | null {
  if (!canFollowUpOverdueInvoice(inv)) return null
  return getInvoiceSendPath(inv, 'overdue_followup')
}

/** Uniform height for invoice action buttons across list, detail, and compose views. */
export const INVOICE_ACTION_BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium leading-none shrink-0 whitespace-nowrap'

/** Icon-only square buttons for tight table/list action columns. */
export const INVOICE_ACTION_ICON_BUTTON_BASE =
  'inline-flex items-center justify-center size-8 rounded-lg shrink-0'

/** @deprecated Use INVOICE_ACTION_BUTTON_BASE */
export const INVOICE_EMAIL_ACTION_BUTTON_BASE = INVOICE_ACTION_BUTTON_BASE

/** @deprecated Use INVOICE_ACTION_ICON_BUTTON_BASE */
export const INVOICE_EMAIL_ACTION_ICON_BUTTON_BASE = INVOICE_ACTION_ICON_BUTTON_BASE

export function invoiceDetailSecondaryButtonClass(): string {
  return `${INVOICE_ACTION_BUTTON_BASE} border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 disabled:opacity-50`
}

export function invoiceDetailPrimaryButtonClass(): string {
  return `${INVOICE_ACTION_BUTTON_BASE} bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50`
}

export function invoiceDetailDangerButtonClass(): string {
  return `${INVOICE_ACTION_BUTTON_BASE} border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50`
}

export function invoiceDetailDangerSolidButtonClass(): string {
  return `${INVOICE_ACTION_BUTTON_BASE} border border-red-600/50 bg-red-600/10 text-red-400 hover:bg-red-600/20 disabled:opacity-50`
}

export function invoiceRecurringStopButtonClass(): string {
  return `${INVOICE_ACTION_BUTTON_BASE} border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 disabled:opacity-50`
}

export function invoiceRecurringActionButtonClass(variant: 'edit' | 'stop'): string {
  return variant === 'edit'
    ? `${INVOICE_ACTION_BUTTON_BASE} border border-purple-500/40 text-purple-200 hover:bg-purple-500/10`
    : invoiceRecurringStopButtonClass()
}

export function invoiceRecurringActionIconButtonClass(variant: 'edit' | 'stop'): string {
  return variant === 'edit'
    ? `${INVOICE_ACTION_ICON_BUTTON_BASE} border border-purple-500/40 text-purple-200 hover:bg-purple-500/10`
    : `${INVOICE_ACTION_ICON_BUTTON_BASE} border border-purple-500/30 text-purple-300 hover:bg-purple-500/10 disabled:opacity-50`
}

export function invoiceEmailActionButtonClass(variant: 'send' | 'followup'): string {
  return variant === 'followup'
    ? `${INVOICE_ACTION_BUTTON_BASE} bg-red-600/90 text-white hover:bg-red-700`
    : `${INVOICE_ACTION_BUTTON_BASE} bg-blue-600/90 text-white hover:bg-blue-700`
}

export function invoiceEmailActionIconButtonClass(variant: 'send' | 'followup'): string {
  return variant === 'followup'
    ? `${INVOICE_ACTION_ICON_BUTTON_BASE} bg-red-600/90 text-white hover:bg-red-700`
    : `${INVOICE_ACTION_ICON_BUTTON_BASE} bg-blue-600/90 text-white hover:bg-blue-700`
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
        composeDescription: 'Compose and resend this invoice in a new email thread. The original sent thread is left unchanged.',
        draftCreatedToast: 'Invoice resend draft ready to send',
        draftUpdatedToast: 'Invoice resend draft updated',
      }
    case 'overdue_followup':
      return {
        short: 'Follow Up',
        long: 'Follow Up on Overdue Invoice',
        composeTitle: 'Follow Up on Overdue Invoice',
        composeDescription: 'Compose a payment reminder in a new email thread. The original invoice thread is left unchanged.',
        draftCreatedToast: 'Overdue invoice follow-up draft ready to send',
        draftUpdatedToast: 'Overdue invoice follow-up draft updated',
      }
    default:
      return {
        short: 'Send',
        long: 'Send Invoice To Client',
        composeTitle: 'Send Invoice To Client',
        composeDescription: 'Compose and send this invoice through the Inbox module.',
        draftCreatedToast: 'Invoice draft ready to send',
        draftUpdatedToast: 'Invoice draft updated',
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

const P_STYLE = 'margin:0 0 14px;color:#111827;font-size:14px;line-height:1.65;'
const H2_STYLE = 'margin:0 0 20px;color:#111827;font-size:22px;line-height:1.3;font-weight:800;'

function styledParagraph(content: string): string {
  return `<p style="${P_STYLE}">${content}</p>`
}

function styledHeading(title: string): string {
  return `<h2 style="${H2_STYLE}">${title}</h2>`
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

function buildInvoiceAmountBlock(amountDue: string): string {
  return [
    '<div style="margin:24px 0 18px;padding:18px 20px;border-radius:14px;background:#f3f6fb;border:1px solid #dbe4f0;">',
    '<div style="margin:0 0 8px;color:#475569;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">Invoice Amount</div>',
    `<div style="color:#111827;font-size:24px;line-height:1.2;font-weight:800;">${amountDue}</div>`,
    '</div>',
  ].join('')
}

function buildPayNowButton(payUrl: string): string {
  if (!payUrl) return ''
  return `<p style="margin:24px 0;"><a href="${payUrl}" style="display:inline-block;padding:13px 28px;border-radius:999px;background:#2563eb;color:#ffffff;text-decoration:none;font-size:13px;font-weight:800;letter-spacing:0.04em;">PAY NOW</a></p>`
}

function buildInvoiceDetailsBlock(args: InvoiceMessageFields): string {
  const payUrl = escapeHtml(args.payUrl)
  return [
    buildInvoiceAmountBlock(escapeHtml(args.invoiceAmountDue)),
    buildEmailMetaRow('Invoice No', escapeHtml(args.invoiceNumber)),
    buildEmailMetaRow('Invoice Date', escapeHtml(args.invoiceDate)),
    buildEmailMetaRow('Due Date', escapeHtml(args.dueDate)),
    buildPayNowButton(payUrl),
  ].join('')
}

function buildSignatureBlock(signature: string): string {
  const signatureHtml = escapeHtml(signature).replace(/\n/g, '<br />')
  return styledParagraph(`Kind Regards,<br />${signatureHtml}`)
}

function buildInitialInvoiceMessage(args: InvoiceMessageFields): string {
  return [
    styledHeading('Invoice from Brogrammers Agency'),
    styledParagraph(`Dear ${escapeHtml(args.contactName)},`),
    styledParagraph('Thank you for your business. Your invoice can be viewed, printed and downloaded as PDF from the link below. You can also choose to pay it online.'),
    buildInvoiceDetailsBlock(args),
    styledParagraph('Please contact us for more information.'),
    buildSignatureBlock(args.signature),
  ].join('')
}

function buildResendInvoiceMessage(args: InvoiceMessageFields): string {
  return [
    styledHeading('Invoice Reminder from Brogrammers Agency'),
    styledParagraph(`Dear ${escapeHtml(args.contactName)},`),
    styledParagraph(`This is a friendly reminder regarding invoice <strong>${escapeHtml(args.invoiceNumber)}</strong>. We are resending it here for your records. You can view, print, or download the invoice as a PDF from the link below, and pay online if you prefer.`),
    buildInvoiceDetailsBlock(args),
    styledParagraph('If you have already sent payment, please disregard this message. Otherwise, let us know if you have any questions.'),
    buildSignatureBlock(args.signature),
  ].join('')
}

function buildOverdueFollowUpMessage(args: InvoiceMessageFields): string {
  return [
    styledHeading('Overdue Invoice Follow-Up'),
    styledParagraph(`Dear ${escapeHtml(args.contactName)},`),
    styledParagraph(`Our records show that invoice <strong>${escapeHtml(args.invoiceNumber)}</strong> was due on <strong>${escapeHtml(args.dueDate)}</strong> and remains unpaid.`),
    styledParagraph('Please review the invoice details below and submit payment at your earliest convenience. If payment has already been sent, or if you need more time, reply to this email and we will update our records.'),
    buildInvoiceDetailsBlock(args),
    styledParagraph('Thank you for your prompt attention to this matter.'),
    buildSignatureBlock(args.signature),
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
  return [
    '<div style="margin:0;padding:0;background:#ffffff;">',
    '<div style="max-width:680px;margin:0;padding:32px 28px;font-family:Arial,Helvetica,sans-serif;color:#111827;">',
    html,
    '</div>',
    '</div>',
  ].join('')
}

export type InvoiceEmailHtmlValidation = {
  ok: boolean
  issues: string[]
}

/** Sanity-check generated invoice email HTML before send. */
export function validateInvoiceEmailHtml(html: string, kind: InvoiceEmailKind): InvoiceEmailHtmlValidation {
  const issues: string[] = []
  const trimmed = html.trim()

  if (!trimmed) {
    issues.push('HTML is empty')
    return { ok: false, issues }
  }

  const openDivs = (trimmed.match(/<div\b/gi) ?? []).length
  const closeDivs = (trimmed.match(/<\/div>/gi) ?? []).length
  if (openDivs !== closeDivs) {
    issues.push(`Unbalanced div tags (${openDivs} open, ${closeDivs} close)`)
  }

  const openPs = (trimmed.match(/<p\b/gi) ?? []).length
  const closePs = (trimmed.match(/<\/p>/gi) ?? []).length
  if (openPs !== closePs) {
    issues.push(`Unbalanced paragraph tags (${openPs} open, ${closePs} close)`)
  }

  if (!trimmed.includes('Invoice Amount')) {
    issues.push('Missing invoice amount block')
  }

  if (!trimmed.includes('Invoice No')) {
    issues.push('Missing invoice number row')
  }

  if (!trimmed.includes('PAY NOW')) {
    issues.push('Missing pay button')
  }

  if (kind === 'overdue_followup' && !trimmed.includes('Overdue Invoice Follow-Up')) {
    issues.push('Missing overdue follow-up heading')
  }

  if (kind === 'resend' && !trimmed.includes('Invoice Reminder')) {
    issues.push('Missing resend reminder heading')
  }

  if (kind === 'initial' && !trimmed.includes('Invoice from Brogrammers Agency')) {
    issues.push('Missing initial invoice heading')
  }

  if (/style="[^"]*style="/i.test(trimmed)) {
    issues.push('Malformed nested style attributes')
  }

  return { ok: issues.length === 0, issues }
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
