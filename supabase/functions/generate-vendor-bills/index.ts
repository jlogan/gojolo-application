import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TZ = 'America/New_York'

type BillingConfig = {
  billing_type: 'hourly' | 'fixed'
  hourly_rate: number | null
  fixed_amount: number | null
  source: 'project' | 'vendor'
}

type TimeLog = {
  id: string
  user_id: string
  task_id: string | null
  project_id: string
  hours: number | null
  minutes: number | null
  work_date: string
  description: string | null
  hourly_rate: number | null
}

function partsInZone(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), weekday: get('weekday') }
}

function isoDate(d: Date) { return d.toISOString().split('T')[0] }
function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return isoDate(d)
}
function previousWeekRange(localToday: string) {
  return { start: addDays(localToday, -7), end: addDays(localToday, -1) }
}
function roundMoney(n: number) { return Math.round(n * 100) / 100 }

async function resolveConfig(supabase: any, orgId: string, vendorUserId: string, projectId: string, periodEnd: string): Promise<BillingConfig | null> {
  const { data: override, error: overrideErr } = await supabase
    .from('vendor_project_billing_profiles')
    .select('billing_type, hourly_rate, fixed_amount')
    .eq('org_id', orgId)
    .eq('vendor_user_id', vendorUserId)
    .eq('project_id', projectId)
    .lte('effective_from', periodEnd)
    .or(`effective_to.is.null,effective_to.gte.${periodEnd}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (overrideErr) throw new Error(`Project billing config error: ${overrideErr.message}`)
  if (override) return { ...override, source: 'project' }

  const { data: profile, error: profileErr } = await supabase
    .from('vendor_billing_profiles')
    .select('default_billing_type, default_hourly_rate, default_fixed_amount')
    .eq('org_id', orgId)
    .eq('vendor_user_id', vendorUserId)
    .lte('effective_from', periodEnd)
    .or(`effective_to.is.null,effective_to.gte.${periodEnd}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (profileErr) throw new Error(`Vendor billing config error: ${profileErr.message}`)
  if (!profile) return null
  return {
    billing_type: profile.default_billing_type,
    hourly_rate: profile.default_hourly_rate,
    fixed_amount: profile.default_fixed_amount,
    source: 'vendor',
  }
}

async function billExists(supabase: any, orgId: string, vendorUserId: string, projectId: string, periodStart: string, periodEnd: string) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id')
    .eq('org_id', orgId)
    .eq('direction', 'inbound')
    .eq('vendor_user_id', vendorUserId)
    .eq('project_id', projectId)
    .eq('billing_period_start', periodStart)
    .eq('billing_period_end', periodEnd)
    .neq('status', 'cancelled')
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Bill lookup failed: ${error.message}`)
  return data?.id as string | undefined
}

async function createBill(supabase: any, params: {
  orgId: string
  vendorUserId: string
  projectId: string
  periodStart: string
  periodEnd: string
  billingType: 'hourly' | 'fixed'
  currencyId: string | null
  lineItems: Array<{ description: string; long_description?: string | null; quantity: number; unit_price: number; unit: string; subtotal: number; total: number; time_log_ids?: string[]; sort_order: number }>
}) {
  const total = roundMoney(params.lineItems.reduce((sum, item) => sum + Number(item.total ?? 0), 0))
  const { data: nextNum, error: numErr } = await supabase.rpc('next_invoice_number', { p_org_id: params.orgId, p_direction: 'inbound' })
  if (numErr || nextNum == null) throw new Error(`Failed to get next bill number: ${numErr?.message ?? 'null result'}`)

  const { data: inv, error: invErr } = await supabase.from('invoices').insert({
    org_id: params.orgId,
    direction: 'inbound',
    number: nextNum,
    prefix: 'BILL-',
    status: 'draft',
    vendor_user_id: params.vendorUserId,
    project_id: params.projectId,
    issue_date: new Date().toISOString().split('T')[0],
    currency_id: params.currencyId,
    subtotal: total,
    tax_total: 0,
    discount_type: 'percent',
    discount_value: 0,
    discount_total: 0,
    adjustment: 0,
    total,
    amount_paid: 0,
    amount_due: total,
    billing_period_start: params.periodStart,
    billing_period_end: params.periodEnd,
    billing_source: 'automated',
    notes: `Auto-generated ${params.billingType} vendor bill for ${params.periodStart} to ${params.periodEnd}.`,
  }).select('id, number').single()
  if (invErr || !inv) throw new Error(`Failed to create bill: ${invErr?.message ?? 'no row returned'}`)

  const { error: itemsErr } = await supabase.from('invoice_items').insert(params.lineItems.map((item) => ({
    invoice_id: inv.id,
    description: item.description,
    long_description: item.long_description ?? null,
    quantity: item.quantity,
    unit_price: item.unit_price,
    unit: item.unit,
    tax_amount: 0,
    subtotal: item.subtotal,
    total: item.total,
    sort_order: item.sort_order,
    time_log_ids: item.time_log_ids ?? [],
  })))
  if (itemsErr) throw new Error(`Failed to create bill items: ${itemsErr.message}`)
  return inv
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabase = createClient(supabaseUrl, serviceKey)
  const body = await req.json().catch(() => ({})) as { force?: boolean; orgId?: string; periodStart?: string; periodEnd?: string; scheduled?: boolean }
  const local = partsInZone()
  const localToday = `${local.year}-${local.month}-${local.day}`

  if (body.scheduled && !body.force && (local.weekday !== 'Mon' || local.hour !== '06')) {
    return new Response(JSON.stringify({ skipped: true, reason: `Not Monday 6 AM ${TZ}`, local }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const range = body.periodStart && body.periodEnd ? { start: body.periodStart, end: body.periodEnd } : previousWeekRange(localToday)
  const created: Array<{ bill_id: string; org_id: string; vendor_user_id: string; project_id: string; amount: number }> = []
  const skipped: Array<{ org_id: string; vendor_user_id?: string; project_id?: string; reason: string }> = []
  const errors: Array<{ org_id?: string; vendor_user_id?: string; project_id?: string; error: string }> = []

  const { data: orgs, error: orgErr } = body.orgId
    ? await supabase.from('organizations').select('id').eq('id', body.orgId)
    : await supabase.from('organizations').select('id')
  if (orgErr) throw new Error(`Failed to load orgs: ${orgErr.message}`)

  for (const org of orgs ?? []) {
    const orgId = org.id as string
    let runId: string | null = null
    try {
      const { data: run } = await supabase.from('bill_generation_runs').upsert({
        org_id: orgId,
        billing_period_start: range.start,
        billing_period_end: range.end,
        status: 'running',
        started_at: new Date().toISOString(),
      }, { onConflict: 'org_id,billing_period_start,billing_period_end' }).select('id').single()
      runId = run?.id ?? null

      const { data: currency } = await supabase.from('currencies').select('id').eq('org_id', orgId).eq('is_default', true).maybeSingle()
      const currencyId = currency?.id ?? null

      const { data: orgProjects, error: projectsErr } = await supabase.from('projects').select('id').eq('org_id', orgId)
      if (projectsErr) throw new Error(`Failed to fetch projects: ${projectsErr.message}`)
      const orgProjectIds = (orgProjects ?? []).map((p: { id: string }) => p.id)

      let logs: TimeLog[] = []
      if (orgProjectIds.length > 0) {
        const { data: logRows, error: logErr } = await supabase
          .from('time_logs')
          .select('id, user_id, task_id, project_id, hours, minutes, work_date, description, hourly_rate')
          .gte('work_date', range.start)
          .lte('work_date', range.end)
          .in('project_id', orgProjectIds)
          .order('work_date', { ascending: true })
        if (logErr) throw new Error(`Failed to fetch time logs: ${logErr.message}`)
        logs = (logRows ?? []) as TimeLog[]
      }

      const logGroups = new Map<string, TimeLog[]>()
      for (const log of logs) {
        const key = `${log.user_id}:${log.project_id}`
        logGroups.set(key, [...(logGroups.get(key) ?? []), log])
      }

      const billKeys = new Set<string>()
      for (const [key, group] of logGroups) {
        const [vendorUserId, projectId] = key.split(':')
        billKeys.add(key)
        try {
          if (await billExists(supabase, orgId, vendorUserId, projectId, range.start, range.end)) {
            skipped.push({ org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, reason: 'Bill already exists for period' })
            continue
          }
          const config = await resolveConfig(supabase, orgId, vendorUserId, projectId, range.end)
          if (!config) {
            skipped.push({ org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, reason: 'Missing vendor billing profile' })
            continue
          }
          if (config.billing_type === 'fixed') continue // fixed handled below, including no-time weeks
          const rate = Number(config.hourly_rate ?? group.find((l) => l.hourly_rate != null)?.hourly_rate ?? 0)
          if (!rate) {
            skipped.push({ org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, reason: 'Missing hourly rate' })
            continue
          }

          const taskIds = [...new Set(group.map((l) => l.task_id).filter(Boolean))]
          const { data: tasks } = taskIds.length ? await supabase.from('tasks').select('id, title').in('id', taskIds) : { data: [] }
          const taskTitles = new Map((tasks ?? []).map((t: { id: string; title: string }) => [t.id, t.title]))
          const byTask = new Map<string, TimeLog[]>()
          for (const log of group) byTask.set(log.task_id ?? 'none', [...(byTask.get(log.task_id ?? 'none') ?? []), log])
          const items = [...byTask.entries()].map(([taskId, taskLogs], idx) => {
            const hours = Math.round(taskLogs.reduce((sum, l) => sum + Number(l.hours ?? 0) + Number(l.minutes ?? 0) / 60, 0) * 100) / 100
            const subtotal = roundMoney(hours * rate)
            return {
              description: taskId !== 'none' ? (taskTitles.get(taskId) ?? 'Vendor time') : 'Vendor time',
              long_description: taskLogs.map((l) => `${l.work_date}: ${l.hours ?? 0}h ${l.minutes ?? 0}m${l.description ? ' - ' + l.description : ''}`).join('\n'),
              quantity: hours,
              unit_price: rate,
              unit: 'hours',
              subtotal,
              total: subtotal,
              time_log_ids: taskLogs.map((l) => l.id),
              sort_order: idx + 1,
            }
          })
          const inv = await createBill(supabase, { orgId, vendorUserId, projectId, periodStart: range.start, periodEnd: range.end, billingType: 'hourly', currencyId, lineItems: items })
          created.push({ bill_id: inv.id, org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, amount: items.reduce((s, i) => s + i.total, 0) })
        } catch (e) {
          errors.push({ org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, error: (e as Error).message })
        }
      }

      // Fixed bills from active project overrides.
      const { data: fixedOverrides } = await supabase
        .from('vendor_project_billing_profiles')
        .select('vendor_user_id, project_id, fixed_amount')
        .eq('org_id', orgId)
        .eq('billing_type', 'fixed')
        .lte('effective_from', range.end)
        .or(`effective_to.is.null,effective_to.gte.${range.end}`)
      for (const fixed of fixedOverrides ?? []) {
        const key = `${fixed.vendor_user_id}:${fixed.project_id}`
        billKeys.add(key)
      }

      // Fixed bills from default fixed vendor profiles for every active project membership.
      const { data: fixedDefaults } = await supabase
        .from('vendor_billing_profiles')
        .select('vendor_user_id')
        .eq('org_id', orgId)
        .eq('default_billing_type', 'fixed')
        .lte('effective_from', range.end)
        .or(`effective_to.is.null,effective_to.gte.${range.end}`)
      const fixedVendorIds = [...new Set((fixedDefaults ?? []).map((p: { vendor_user_id: string }) => p.vendor_user_id))]
      if (fixedVendorIds.length > 0) {
        const { data: memberships } = await supabase
          .from('project_members')
          .select('project_id, user_id, projects!inner(org_id, status)')
          .in('user_id', fixedVendorIds)
          .eq('projects.org_id', orgId)
        for (const membership of memberships ?? []) {
          billKeys.add(`${membership.user_id}:${membership.project_id}`)
        }
      }

      for (const key of billKeys) {
        const [vendorUserId, projectId] = key.split(':')
        try {
          const config = await resolveConfig(supabase, orgId, vendorUserId, projectId, range.end)
          if (config?.billing_type !== 'fixed') continue
          const amount = Number(config.fixed_amount ?? 0)
          if (!amount) {
            skipped.push({ org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, reason: 'Missing fixed weekly amount' })
            continue
          }
          if (await billExists(supabase, orgId, vendorUserId, projectId, range.start, range.end)) continue
          const { data: project } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle()
          const group = logGroups.get(key) ?? []
          const inv = await createBill(supabase, {
            orgId, vendorUserId, projectId, periodStart: range.start, periodEnd: range.end, billingType: 'fixed', currencyId,
            lineItems: [{
              description: `Weekly fixed fee - ${project?.name ?? 'Project'}`,
              long_description: `Fixed weekly vendor bill for ${range.start} to ${range.end}.${group.length ? `\nReference time logs: ${group.length}` : ''}`,
              quantity: 1,
              unit_price: amount,
              unit: 'week',
              subtotal: amount,
              total: amount,
              time_log_ids: group.map((l) => l.id),
              sort_order: 1,
            }],
          })
          created.push({ bill_id: inv.id, org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, amount })
        } catch (e) {
          errors.push({ org_id: orgId, vendor_user_id: vendorUserId, project_id: projectId, error: (e as Error).message })
        }
      }

      if (runId) {
        await supabase.from('bill_generation_runs').update({
          status: errors.length ? (created.length ? 'partial' : 'failed') : 'completed',
          completed_at: new Date().toISOString(),
          bills_created: created.filter((c) => c.org_id === orgId).length,
          bills_skipped: skipped.filter((s) => s.org_id === orgId).length,
          summary: { created, skipped, errors },
          error_message: errors.length ? `${errors.length} errors` : null,
        }).eq('id', runId)
      }
    } catch (e) {
      errors.push({ org_id: orgId, error: (e as Error).message })
      if (runId) await supabase.from('bill_generation_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: (e as Error).message }).eq('id', runId)
    }
  }

  return new Response(JSON.stringify({ period: range, created, skipped, errors }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
