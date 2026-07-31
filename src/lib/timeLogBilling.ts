import type { SupabaseClient } from '@supabase/supabase-js'

/** True when linked to an outbound invoice item or manually marked billed on the row. */
export function isTimeLogBilled(
  logId: string,
  dbBilled: boolean,
  invoiceLinkedIds: Set<string>,
): boolean {
  return invoiceLinkedIds.has(logId) || dbBilled
}

/** Time log IDs referenced by outbound (client) invoice line items. */
export async function fetchOutboundInvoiceLinkedTimeLogIds(
  client: SupabaseClient,
  timeLogIds: string[],
): Promise<Set<string>> {
  const linked = new Set<string>()
  if (timeLogIds.length === 0) return linked

  const { data, error } = await client
    .from('invoice_items')
    .select('time_log_ids, invoices!inner(direction)')
    .eq('invoices.direction', 'outbound')
    .overlaps('time_log_ids', timeLogIds)

  if (error) {
    console.error('Failed to fetch invoice-linked time logs:', error)
    return linked
  }

  for (const item of (data ?? []) as { time_log_ids: string[] | null }[]) {
    for (const id of item.time_log_ids ?? []) {
      linked.add(id)
    }
  }
  return linked
}
