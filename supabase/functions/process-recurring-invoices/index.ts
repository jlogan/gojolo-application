import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/** Advance a date by the given recurring interval */
function advanceDate(date: string, interval: string): string {
  const d = new Date(date + 'T00:00:00Z')
  switch (interval) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7)
      break
    case 'biweekly':
      d.setUTCDate(d.getUTCDate() + 14)
      break
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1)
      break
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3)
      break
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1)
      break
    default:
      // Default to monthly
      d.setUTCMonth(d.getUTCMonth() + 1)
  }
  return d.toISOString().split('T')[0]
}

/** Calculate the day offset between two date strings */
function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z')
  const db = new Date(b + 'T00:00:00Z')
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24))
}

/** Format today as YYYY-MM-DD */
function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey)
    const today = todayStr()

    // 1. Query all recurring invoices due for processing
    const { data: recurringInvoices, error: fetchErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('is_recurring', true)
      .lte('next_recurring_date', today)
      .neq('status', 'cancelled')

    if (fetchErr) {
      throw new Error(`Failed to fetch recurring invoices: ${fetchErr.message}`)
    }

    if (!recurringInvoices || recurringInvoices.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, created: [], skipped: [], message: 'No recurring invoices due' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const created: { invoice_id: string; direction: string; original_id: string; number: number }[] = []
    const skipped: { original_id: string; reason: string }[] = []
    const errors: { original_id: string; error: string }[] = []

    for (const inv of recurringInvoices) {
      try {
        if (inv.direction === 'outbound') {
          // ── OUTBOUND: duplicate the invoice and its items ──

          // Get next invoice number
          const { data: nextNum, error: rpcErr } = await supabase
            .rpc('next_invoice_number', { p_org_id: inv.org_id, p_direction: 'outbound' })

          if (rpcErr || nextNum == null) {
            throw new Error(`Failed to get next invoice number: ${rpcErr?.message ?? 'null result'}`)
          }

          // Calculate due_date offset from original
          const dueDayOffset = inv.issue_date && inv.due_date
            ? daysBetween(inv.issue_date, inv.due_date)
            : 30 // default 30 days

          const newDueDate = new Date(today + 'T00:00:00Z')
          newDueDate.setUTCDate(newDueDate.getUTCDate() + dueDayOffset)
          const newDueDateStr = newDueDate.toISOString().split('T')[0]

          // Create the new invoice
          const { data: newInvoice, error: insertErr } = await supabase
            .from('invoices')
            .insert({
              org_id: inv.org_id,
              direction: 'outbound',
              number: nextNum,
              prefix: inv.prefix,
              status: 'draft',
              company_id: inv.company_id,
              contact_id: inv.contact_id,
              vendor_user_id: inv.vendor_user_id,
              project_id: inv.project_id,
              issue_date: today,
              due_date: newDueDateStr,
              is_recurring: false, // The new invoice is not itself recurring
              subtotal: inv.subtotal,
              tax_total: inv.tax_total,
              discount_type: inv.discount_type,
              discount_value: inv.discount_value,
              discount_total: inv.discount_total,
              adjustment: inv.adjustment,
              total: inv.total,
              amount_paid: 0,
              amount_due: inv.total,
              notes: inv.notes,
              terms: inv.terms,
              created_by: inv.created_by,
            })
            .select('id')
            .single()

          if (insertErr || !newInvoice) {
            throw new Error(`Failed to create outbound invoice: ${insertErr?.message ?? 'unknown'}`)
          }

          // Duplicate invoice items
          const { data: origItems, error: itemsErr } = await supabase
            .from('invoice_items')
            .select('*')
            .eq('invoice_id', inv.id)
            .order('sort_order', { ascending: true })

          if (itemsErr) {
            throw new Error(`Failed to fetch original items: ${itemsErr.message}`)
          }

          if (origItems && origItems.length > 0) {
            const newItems = origItems.map((item: Record<string, unknown>) => ({
              invoice_id: newInvoice.id,
              description: item.description,
              long_description: item.long_description,
              quantity: item.quantity,
              unit_price: item.unit_price,
              unit: item.unit,
              tax_rate_id: item.tax_rate_id,
              tax_amount: item.tax_amount,
              subtotal: item.subtotal,
              total: item.total,
              sort_order: item.sort_order,
              // Don't copy time_log_ids — these are new line items
            }))

            const { error: itemInsertErr } = await supabase
              .from('invoice_items')
              .insert(newItems)

            if (itemInsertErr) {
              throw new Error(`Failed to duplicate items: ${itemInsertErr.message}`)
            }
          }

          created.push({
            invoice_id: newInvoice.id,
            direction: 'outbound',
            original_id: inv.id,
            number: nextNum,
          })

        } else if (inv.direction === 'inbound') {
          // ── INBOUND: auto-generate bill from unbilled time logs ──

          if (!inv.vendor_user_id) {
            skipped.push({ original_id: inv.id, reason: 'No vendor_user_id on inbound recurring invoice' })
            // Still advance the recurring date
            await advanceRecurringDate(supabase, inv)
            continue
          }

          // Determine the lookback period: from last recurring date (minus interval) to today
          // The next_recurring_date was the date this was supposed to fire,
          // so the "last" period start is one interval before that
          const periodStart = inv.next_recurring_date
            ? advanceDateBackward(inv.next_recurring_date, inv.recurring_interval)
            : inv.issue_date ?? today

          // Query unbilled time logs for this vendor
          const { data: timeLogs, error: tlErr } = await supabase
            .from('time_logs')
            .select('id, task_id, project_id, hours, minutes, work_date, description, hourly_rate')
            .eq('user_id', inv.vendor_user_id)
            .eq('billed', false)
            .gte('work_date', periodStart)
            .lte('work_date', today)
            .order('work_date', { ascending: true })

          if (tlErr) {
            throw new Error(`Failed to fetch time logs: ${tlErr.message}`)
          }

          if (!timeLogs || timeLogs.length === 0) {
            skipped.push({ original_id: inv.id, reason: 'No unbilled time logs in period' })
            await advanceRecurringDate(supabase, inv)
            continue
          }

          // Group time logs by task_id
          const taskGroups: Record<string, {
            task_id: string | null
            logs: typeof timeLogs
            totalHours: number
            hourlyRate: number
          }> = {}

          for (const log of timeLogs) {
            const key = log.task_id ?? '__no_task__'
            if (!taskGroups[key]) {
              taskGroups[key] = { task_id: log.task_id, logs: [], totalHours: 0, hourlyRate: 0 }
            }
            taskGroups[key].logs.push(log)
            const logHours = (log.hours ?? 0) + (log.minutes ?? 0) / 60
            taskGroups[key].totalHours += logHours
            // Use the most recent hourly_rate for the group
            if (log.hourly_rate != null) {
              taskGroups[key].hourlyRate = log.hourly_rate
            }
          }

          // Fetch task titles for descriptions
          const taskIds = Object.keys(taskGroups).filter(k => k !== '__no_task__')
          let taskTitles: Record<string, string> = {}
          if (taskIds.length > 0) {
            const { data: tasks } = await supabase
              .from('tasks')
              .select('id, title')
              .in('id', taskIds)

            if (tasks) {
              taskTitles = Object.fromEntries(tasks.map((t: { id: string; title: string }) => [t.id, t.title]))
            }
          }

          // Get next invoice number
          const { data: nextNum, error: rpcErr } = await supabase
            .rpc('next_invoice_number', { p_org_id: inv.org_id, p_direction: 'inbound' })

          if (rpcErr || nextNum == null) {
            throw new Error(`Failed to get next invoice number: ${rpcErr?.message ?? 'null result'}`)
          }

          // Calculate due date with same offset as original
          const dueDayOffset = inv.issue_date && inv.due_date
            ? daysBetween(inv.issue_date, inv.due_date)
            : 30

          const newDueDate = new Date(today + 'T00:00:00Z')
          newDueDate.setUTCDate(newDueDate.getUTCDate() + dueDayOffset)
          const newDueDateStr = newDueDate.toISOString().split('T')[0]

          // Create the new inbound invoice (totals will be recalculated by trigger)
          const { data: newInvoice, error: insertErr } = await supabase
            .from('invoices')
            .insert({
              org_id: inv.org_id,
              direction: 'inbound',
              number: nextNum,
              prefix: inv.prefix,
              status: 'draft',
              company_id: inv.company_id,
              contact_id: inv.contact_id,
              vendor_user_id: inv.vendor_user_id,
              project_id: inv.project_id,
              issue_date: today,
              due_date: newDueDateStr,
              is_recurring: false,
              subtotal: 0,
              tax_total: 0,
              total: 0,
              amount_paid: 0,
              amount_due: 0,
              notes: inv.notes,
              terms: inv.terms,
              created_by: inv.created_by,
            })
            .select('id')
            .single()

          if (insertErr || !newInvoice) {
            throw new Error(`Failed to create inbound invoice: ${insertErr?.message ?? 'unknown'}`)
          }

          // Create line items grouped by task
          const lineItems = Object.entries(taskGroups).map(([key, group], idx) => {
            const taskTitle = key !== '__no_task__' ? taskTitles[key] : null
            const description = taskTitle ?? 'Unbilled time'
            const hours = Math.round(group.totalHours * 100) / 100
            const rate = group.hourlyRate
            const subtotal = Math.round(hours * rate * 100) / 100

            return {
              invoice_id: newInvoice.id,
              description,
              quantity: hours,
              unit_price: rate,
              unit: 'hours',
              tax_amount: 0,
              subtotal,
              total: subtotal,
              sort_order: idx + 1,
              time_log_ids: group.logs.map((l: { id: string }) => l.id),
            }
          })

          const { error: itemInsertErr } = await supabase
            .from('invoice_items')
            .insert(lineItems)

          if (itemInsertErr) {
            throw new Error(`Failed to create inbound line items: ${itemInsertErr.message}`)
          }

          created.push({
            invoice_id: newInvoice.id,
            direction: 'inbound',
            original_id: inv.id,
            number: nextNum,
          })
        }

        // 3. Advance the original invoice's next_recurring_date
        await advanceRecurringDate(supabase, inv)

      } catch (err) {
        console.error(`Error processing recurring invoice ${inv.id}:`, (err as Error).message)
        errors.push({ original_id: inv.id, error: (err as Error).message })
      }
    }

    const summary = {
      processed: recurringInvoices.length,
      created,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    }

    console.log('Recurring invoice processing complete:', JSON.stringify(summary))

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Process recurring invoices error:', (err as Error).message)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// ── Helper: advance the recurring date on the original invoice ──

// deno-lint-ignore no-explicit-any
async function advanceRecurringDate(supabase: any, inv: Record<string, any>) {
  const nextDate = advanceDate(
    inv.next_recurring_date ?? todayStr(),
    inv.recurring_interval ?? 'monthly'
  )

  const { error } = await supabase
    .from('invoices')
    .update({ next_recurring_date: nextDate })
    .eq('id', inv.id)

  if (error) {
    console.error(`Failed to advance recurring date for ${inv.id}:`, error.message)
  }
}

/** Go backward one interval (to find the period start) */
function advanceDateBackward(date: string, interval: string): string {
  const d = new Date(date + 'T00:00:00Z')
  switch (interval) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() - 7)
      break
    case 'biweekly':
      d.setUTCDate(d.getUTCDate() - 14)
      break
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() - 1)
      break
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() - 3)
      break
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() - 1)
      break
    default:
      d.setUTCMonth(d.getUTCMonth() - 1)
  }
  return d.toISOString().split('T')[0]
}
