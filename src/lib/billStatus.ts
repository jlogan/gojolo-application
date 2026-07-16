/** Display labels for stored bill statuses (invoices.direction = 'inbound'). */
export const BILL_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  approved: 'Open',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

export function billStatusLabel(status: string): string {
  return BILL_STATUS_LABELS[status] ?? status
}

export const BILL_STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  approved: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  paid: 'bg-green-500/20 text-green-300 border-green-500/30',
  cancelled: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
}
