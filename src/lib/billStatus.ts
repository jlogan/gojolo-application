/** Display labels for stored bill statuses (invoices.direction = 'inbound'). */
export const BILL_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  approved: 'Open',
  partially_paid: 'Open',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

export function billStatusLabel(status: string): string {
  return BILL_STATUS_LABELS[status] ?? status
}

export const BILL_STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  approved: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  partially_paid: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  paid: 'bg-green-500/20 text-green-300 border-green-500/30',
  cancelled: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
}

/** DB statuses shown under the user-facing Open stage (filter + payments). */
export const BILL_OPEN_STATUSES = ['approved', 'partially_paid'] as const

export function isBillOpenStatus(status: string): boolean {
  return (BILL_OPEN_STATUSES as readonly string[]).includes(status)
}

export function canRecordBillPayment(status: string): boolean {
  return isBillOpenStatus(status)
}

export function canCancelBill(status: string): boolean {
  return status !== 'cancelled' && status !== 'paid'
}

/** Appends an auditable cancellation line to invoice notes without overwriting prior content. */
export function appendBillCancellationNote(existingNotes: string | null | undefined, reason: string): string {
  const trimmedReason = reason.trim()
  const line = `Cancellation reason: ${trimmedReason}`
  const base = existingNotes?.trim()
  return base ? `${base}\n\n${line}` : line
}
