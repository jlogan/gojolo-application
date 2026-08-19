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

export function getInvoiceSendPath(inv: Pick<InvoiceEmailRow, 'id' | 'email_sent_at' | 'email_sent_thread_id' | 'status'>): string {
  if (isInvoiceResend(inv) && inv.email_sent_thread_id) {
    return `/inbox/${inv.email_sent_thread_id}?resendInvoice=${inv.id}`
  }
  return `/invoices/${inv.id}/send`
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

function buildDefaultInvoiceMessage(args: {
  contactName: string
  invoiceAmountDue: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  payUrl: string
  signature: string
}) {
  const signatureHtml = escapeHtml(args.signature).replace(/\n/g, '<br />')
  const payUrl = escapeHtml(args.payUrl)
  return [
    '<h2>Invoice from Brogrammers Agency</h2>',
    `<p>Dear ${escapeHtml(args.contactName)},</p>`,
    '<p>Thank you for your business. Your invoice can be viewed, printed and downloaded as PDF from the link below. You can also choose to pay it online.</p>',
    '<h3>INVOICE AMOUNT</h3>',
    `<p><strong>${escapeHtml(args.invoiceAmountDue)}</strong></p>`,
    `<p><span>Invoice No</span><strong>${escapeHtml(args.invoiceNumber)}</strong></p>`,
    `<p><span>Invoice Date</span><strong>${escapeHtml(args.invoiceDate)}</strong></p>`,
    `<p><span>Due Date</span><strong>${escapeHtml(args.dueDate)}</strong></p>`,
    `<p><a href="${payUrl}"><strong>PAY NOW</strong></a></p>`,
    '<p>Please contact us for more information.</p>',
    `<p>Kind Regards,<br />${signatureHtml}</p>`,
  ].join('')
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
}) {
  const number = invoiceNumberFromRow(args.invoiceRow)
  const payOrigin = args.origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  return {
    number,
    subject: `Invoice - ${number} from Brogrammers Agency`,
    message: buildDefaultInvoiceMessage({
      contactName: args.contactName,
      invoiceAmountDue: fmtInvoiceCurrency(args.invoiceRow.amount_due ?? args.invoiceRow.total ?? 0),
      invoiceNumber: number,
      invoiceDate: fmtInvoiceDate(args.invoiceRow.issue_date),
      dueDate: fmtInvoiceDate(args.invoiceRow.due_date),
      payUrl: args.invoiceRow.hash ? `${payOrigin}/invoice/${args.invoiceRow.hash}` : '',
      signature: args.signature ?? DEFAULT_INVOICE_EMAIL_SIGNATURE,
    }),
  }
}

export function buildFinalizedInvoiceEmailHtml(args: Parameters<typeof buildInvoiceEmailContent>[0]): string {
  const { message } = buildInvoiceEmailContent(args)
  return finalizeInvoiceEmailHtml(message)
}
