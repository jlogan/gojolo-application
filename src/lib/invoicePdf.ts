import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

// ─── Brand colours ───────────────────────────────────────────────────────────
const BRAND_DARK   = '#0f0f0f'   // page accent / header bg
const BRAND_GREEN  = '#16a34a'   // accent / paid badge
const GRAY_900     = '#111827'
const GRAY_600     = '#4b5563'
const GRAY_300     = '#d1d5db'
const WHITE        = '#ffffff'

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n ?? 0)
}
function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// ─── Types ───────────────────────────────────────────────────────────────────
export interface InvoicePdfData {
  invoiceNumber: string
  status: string
  issueDate: string
  dueDate: string | null
  orgName: string
  billToCompany: string | null
  billToContact: string | null
  billToEmail: string | null
  items: Array<{
    description: string
    longDescription?: string | null
    quantity: number
    unit?: string | null
    unitPrice: number
    subtotal: number
  }>
  subtotal: number
  discountTotal: number
  taxTotal: number
  adjustment: number
  total: number
  amountPaid: number
  amountDue: number
  notes?: string | null
  terms?: string | null
  paymentUrl?: string | null   // public invoice URL for pay-online section
}

// ─── Main generator ──────────────────────────────────────────────────────────
export function buildInvoicePdf(data: InvoicePdfData): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const W = doc.internal.pageSize.getWidth()   // 210
  const margin = 14

  // ── Header bar ──────────────────────────────────────────────────────────────
  doc.setFillColor(...hexToRgb(BRAND_DARK))
  doc.rect(0, 0, W, 32, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(...hexToRgb(WHITE))
  doc.text(data.orgName || 'Brogrammers Agency', margin, 14)

  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...hexToRgb(GRAY_300))
  doc.text('INVOICE', margin, 22)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...hexToRgb(WHITE))
  doc.text(data.invoiceNumber, margin + 20, 22)

  // Status badge (right side of header)
  const statusMap: Record<string, { label: string; bg: string; text: string }> = {
    paid:           { label: 'PAID',      bg: '#16a34a', text: WHITE },
    overdue:        { label: 'OVERDUE',   bg: '#dc2626', text: WHITE },
    partially_paid: { label: 'PARTIAL',   bg: '#d97706', text: WHITE },
    partial:        { label: 'PARTIAL',   bg: '#d97706', text: WHITE },
    sent:           { label: 'UNPAID',    bg: '#d97706', text: WHITE },
    viewed:         { label: 'UNPAID',    bg: '#d97706', text: WHITE },
    draft:          { label: 'DRAFT',     bg: '#6b7280', text: WHITE },
    cancelled:      { label: 'CANCELLED', bg: '#374151', text: GRAY_300 },
  }
  const badge = statusMap[data.status] ?? { label: data.status.toUpperCase(), bg: '#6b7280', text: WHITE }
  const badgeH = 10
  const badgeY = 10
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  const badgeW = Math.max(28, doc.getTextWidth(badge.label) + 10)
  const badgeX = W - margin - badgeW
  doc.setFillColor(...hexToRgb(badge.bg))
  doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 2, 2, 'F')
  doc.setTextColor(...hexToRgb(badge.text))
  // Center the text vertically inside the status pill. jsPDF text y is a baseline, not top.
  const badgeTextY = badgeY + badgeH / 2 + 9 * 0.3528 / 3
  doc.text(badge.label, badgeX + badgeW / 2, badgeTextY, { align: 'center' })

  // ── Bill To + Date meta ──────────────────────────────────────────────────────
  let y = 42

  // Left — Bill To
  doc.setFontSize(7.5)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...hexToRgb(GRAY_600))
  doc.text('BILL TO', margin, y)

  y += 5
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...hexToRgb(GRAY_900))
  if (data.billToCompany) { doc.text(data.billToCompany, margin, y); y += 5 }
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...hexToRgb(GRAY_600))
  if (data.billToContact) { doc.text(data.billToContact, margin, y); y += 4.5 }
  if (data.billToEmail)   { doc.text(data.billToEmail,   margin, y); y += 4.5 }

  // Right — Dates
  const rightX = W - margin
  let dy = 42
  const dateRows: Array<[string, string]> = [
    ['Invoice Date', fmtDate(data.issueDate)],
    ['Due Date',     fmtDate(data.dueDate)],
  ]
  dateRows.forEach(([label, value]) => {
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...hexToRgb(GRAY_600))
    doc.text(label, rightX - 40, dy, { align: 'left' })
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...hexToRgb(GRAY_900))
    doc.text(value, rightX, dy, { align: 'right' })
    dy += 6
  })

  // ── Divider ──────────────────────────────────────────────────────────────────
  y = Math.max(y, dy) + 4
  doc.setDrawColor(...hexToRgb(GRAY_300))
  doc.setLineWidth(0.3)
  doc.line(margin, y, W - margin, y)
  y += 6

  // ── Line items table ─────────────────────────────────────────────────────────
  const rows = data.items.map((item) => [
    item.description + (item.longDescription ? `\n${item.longDescription}` : ''),
    `${item.quantity}${item.unit ? ' ' + item.unit : ''}`,
    fmtUSD(item.unitPrice),
    fmtUSD(item.subtotal),
  ])

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['DESCRIPTION', 'QTY', 'RATE', 'AMOUNT']],
    body: rows,
    headStyles: {
      fillColor: hexToRgb(BRAND_DARK),
      textColor: hexToRgb(GRAY_300),
      fontSize: 7.5,
      fontStyle: 'bold',
      cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
    },
    bodyStyles: {
      textColor: hexToRgb(GRAY_900),
      fontSize: 9,
      cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 },
    },
    alternateRowStyles: { fillColor: [248, 249, 250] },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 22 },
      2: { halign: 'right', cellWidth: 30 },
      3: { halign: 'right', cellWidth: 30 },
    },
    tableLineColor: hexToRgb(GRAY_300),
    tableLineWidth: 0.2,
    didParseCell: (hookData) => {
      if (hookData.section === 'head') {
        hookData.cell.styles.lineColor = hexToRgb(GRAY_300)
        hookData.cell.styles.lineWidth = 0.2
      }
    },
  })

  // ── Totals block ─────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalY: number = (doc as any).lastAutoTable?.finalY ?? y + 20
  let ty = finalY + 8
  const totalsX = W - margin - 80

  const drawTotalRow = (label: string, value: string, bold = false, color = GRAY_600) => {
    doc.setFontSize(bold ? 10 : 9)
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setTextColor(...hexToRgb(color))
    doc.text(label, totalsX, ty)
    doc.setTextColor(...hexToRgb(bold ? GRAY_900 : GRAY_600))
    doc.text(value, W - margin, ty, { align: 'right' })
    ty += bold ? 7 : 6
  }

  drawTotalRow('Subtotal', fmtUSD(data.subtotal))
  if (data.discountTotal > 0) drawTotalRow('Discount', `-${fmtUSD(data.discountTotal)}`, false, '#dc2626')
  if (data.taxTotal !== 0)    drawTotalRow('Tax', fmtUSD(data.taxTotal))
  if (data.adjustment !== 0)  drawTotalRow('Adjustment', (data.adjustment > 0 ? '+' : '') + fmtUSD(data.adjustment))

  // Total divider — leave enough gap because jsPDF text y is a baseline.
  doc.setDrawColor(...hexToRgb(GRAY_300))
  doc.setLineWidth(0.3)
  doc.line(totalsX, ty, W - margin, ty)
  ty += 4
  drawTotalRow('Total', fmtUSD(data.total), true)

  if (data.amountPaid > 0) {
    drawTotalRow('Amount Paid', fmtUSD(data.amountPaid), false, BRAND_GREEN)
    // Amount due highlight bar
    doc.setFillColor(...hexToRgb(BRAND_DARK))
    doc.roundedRect(totalsX - 4, ty - 1, W - margin - totalsX + 4 + margin, 10, 2, 2, 'F')
    doc.setFontSize(10)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...hexToRgb(WHITE))
    doc.text('Amount Due', totalsX, ty + 5.5)
    doc.text(fmtUSD(data.amountDue), W - margin, ty + 5.5, { align: 'right' })
    ty += 14
  }

  // ── Notes / Terms ─────────────────────────────────────────────────────────────
  if (data.notes || data.terms) {
    ty += 6
    doc.setDrawColor(...hexToRgb(GRAY_300))
    doc.setLineWidth(0.3)
    doc.line(margin, ty - 3, W - margin, ty - 3)

    if (data.notes) {
      doc.setFontSize(7.5)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...hexToRgb(GRAY_600))
      doc.text('NOTES', margin, ty)
      ty += 5
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(...hexToRgb(GRAY_900))
      const lines = doc.splitTextToSize(data.notes, (W - margin * 2) / 2 - 4)
      doc.text(lines, margin, ty)
      ty += lines.length * 4.5 + 4
    }

    if (data.terms) {
      doc.setFontSize(7.5)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...hexToRgb(GRAY_600))
      doc.text('TERMS & CONDITIONS', margin, ty)
      ty += 5
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(...hexToRgb(GRAY_900))
      const lines = doc.splitTextToSize(data.terms, W - margin * 2)
      doc.text(lines, margin, ty)
    }
  }
  // ── Online invoice link (payment options live on the web invoice) ─────────────
  const canViewOnline = data.status !== 'cancelled'
  if (canViewOnline && data.paymentUrl) {
    ty += 8
    doc.setDrawColor(...hexToRgb(GRAY_300))
    doc.setLineWidth(0.3)
    doc.line(margin, ty - 3, W - margin, ty - 3)

    doc.setFontSize(7.5)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...hexToRgb(GRAY_600))
    doc.text('VIEW INVOICE ONLINE', margin, ty)
    ty += 5

    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...hexToRgb(GRAY_600))
    doc.text('Open the invoice online to review details and payment options:', margin, ty)
    ty += 6

    const onlineInvoiceText = data.paymentUrl
    doc.setTextColor(0, 102, 204)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.text(onlineInvoiceText, margin, ty)
    doc.link(margin, ty - 4, doc.getTextWidth(onlineInvoiceText), 5, { url: data.paymentUrl })
  }

  return doc
}

// ─── Legacy: generate from DOM element (kept for backwards compatibility) ────
export async function generateInvoicePdf(
  _element: HTMLElement,
  filename?: string,
): Promise<{ blob: Blob; filename: string }> {
  // This path is now only called if InvoiceDetail doesn't pass structured data.
  // Fall back to a blank placeholder — callers should migrate to buildInvoicePdf().
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  doc.setFontSize(12)
  doc.text('Invoice PDF — please use the structured export.', 14, 20)
  return { blob: doc.output('blob'), filename: filename || 'invoice.pdf' }
}

/**
 * Build a PDF from structured data and trigger browser download.
 */
export function downloadInvoicePdfFromData(data: InvoicePdfData, filename?: string): void {
  const doc = buildInvoicePdf(data)
  doc.save(filename || `${data.invoiceNumber}.pdf`)
}

/**
 * Legacy DOM-based download (kept for InvoiceDetail until migrated).
 */
export async function downloadInvoicePdf(
  element: HTMLElement,
  filename?: string,
): Promise<void> {
  const { blob, filename: name } = await generateInvoicePdf(element, filename)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
