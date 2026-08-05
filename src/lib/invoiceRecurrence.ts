import { supabase } from '@/lib/supabase'

type StopInvoiceRecurrenceParams = {
  invoiceId: string
  orgId: string
  direction: 'outbound' | 'inbound'
  existingNumber: number | null
}

export async function stopInvoiceRecurrence({
  invoiceId,
  orgId,
  direction,
  existingNumber,
}: StopInvoiceRecurrenceParams): Promise<{ error: string | null }> {
  const update: Record<string, unknown> = {
    is_recurring: false,
    recurring_interval: null,
    next_recurring_date: null,
    updated_at: new Date().toISOString(),
  }

  if (existingNumber == null) {
    const { data: numData, error: numErr } = await supabase.rpc('next_invoice_number', {
      p_org_id: orgId,
      p_direction: direction,
    })
    if (numErr) return { error: numErr.message }
    update.number = numData as number
  }

  const { error } = await supabase
    .from('invoices')
    .update(update)
    .eq('id', invoiceId)
    .eq('org_id', orgId)

  return { error: error?.message ?? null }
}
