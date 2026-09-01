import type { SupabaseClient } from '@supabase/supabase-js'

export type TimeLogInvoiceSummary = {
  id: string
  prefix: string | null
  number: number | null
  status: string
}

/** True when linked to an outbound invoice item or manually marked billed on the row. */
export function isTimeLogBilled(
  logId: string,
  dbBilled: boolean,
  invoiceLinkedIds: Set<string>,
): boolean {
  return invoiceLinkedIds.has(logId) || dbBilled
}

export function formatInvoiceNumber(inv: { prefix: string | null; number: number | null }): string {
  const prefix = (inv.prefix ?? 'INV-').replace(/-+$/, '')
  return inv.number ? `${prefix}-${String(inv.number).padStart(4, '0')}` : 'Invoice'
}

type InvoiceLinkRow = {
  invoice_id: string
  time_log_ids: string[] | null
  invoices: {
    id: string
    prefix: string | null
    number: number | null
    status: string
    direction: string
  } | {
    id: string
    prefix: string | null
    number: number | null
    status: string
    direction: string
  }[] | null
}

/** Outbound invoice links for time logs, keyed by time log id. */
export async function fetchOutboundInvoiceLinksForTimeLogs(
  client: SupabaseClient,
  timeLogIds: string[],
): Promise<{
  linkedIds: Set<string>
  invoicesByTimeLogId: Map<string, TimeLogInvoiceSummary[]>
}> {
  const linkedIds = new Set<string>()
  const invoicesByTimeLogId = new Map<string, TimeLogInvoiceSummary[]>()
  if (timeLogIds.length === 0) {
    return { linkedIds, invoicesByTimeLogId }
  }

  const { data, error } = await client
    .from('invoice_items')
    .select('invoice_id, time_log_ids, invoices!inner(id, prefix, number, status, direction)')
    .eq('invoices.direction', 'outbound')
    .overlaps('time_log_ids', timeLogIds)

  if (error) {
    console.error('Failed to fetch invoice-linked time logs:', error)
    return { linkedIds, invoicesByTimeLogId }
  }

  for (const item of (data ?? []) as InvoiceLinkRow[]) {
    const invRaw = item.invoices
    const inv = Array.isArray(invRaw) ? invRaw[0] : invRaw
    if (!inv) continue

    const summary: TimeLogInvoiceSummary = {
      id: inv.id,
      prefix: inv.prefix,
      number: inv.number,
      status: inv.status,
    }

    for (const id of item.time_log_ids ?? []) {
      linkedIds.add(id)
      const existing = invoicesByTimeLogId.get(id) ?? []
      if (!existing.some((e) => e.id === summary.id)) {
        invoicesByTimeLogId.set(id, [...existing, summary])
      }
    }
  }

  return { linkedIds, invoicesByTimeLogId }
}

/** Time log IDs referenced by outbound (client) invoice line items. */
export async function fetchOutboundInvoiceLinkedTimeLogIds(
  client: SupabaseClient,
  timeLogIds: string[],
): Promise<Set<string>> {
  const { linkedIds } = await fetchOutboundInvoiceLinksForTimeLogs(client, timeLogIds)
  return linkedIds
}

/** Plain-text summary for native title tooltips / accessibility. */
export function getTimeLogBillingTooltipText(
  billed: boolean,
  invoices: TimeLogInvoiceSummary[] | undefined,
): string | undefined {
  if (!billed) return undefined
  if ((invoices?.length ?? 0) > 0) {
    return invoices!.map((inv) => `${formatInvoiceNumber(inv)} (${inv.status.replace(/_/g, ' ')})`).join(', ')
  }
  return 'Manually marked as billed'
}

/** True when billed only via time_logs.billed, not on an outbound invoice. */
export function isTimeLogManuallyBilled(
  billed: boolean,
  invoices: TimeLogInvoiceSummary[] | undefined,
): boolean {
  return billed && (invoices?.length ?? 0) === 0
}
