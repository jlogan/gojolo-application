import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Plus, Trash2, Clock, X, Check, GripVertical } from 'lucide-react'

/* ─── types ─── */

type TaxRate = { id: string; name: string; rate: number; is_default: boolean }
type Currency = { id: string; code: string; name: string; symbol: string; is_default: boolean }
type Company = { id: string; name: string }
type Contact = { id: string; name: string; email: string | null; company_id: string | null }
type Project = { id: string; name: string }
type VendorUser = { id: string; display_name: string }

type LineItem = {
  id: string // client-side key
  description: string
  long_description: string
  quantity: number
  unit_price: number
  unit: string
  tax_rate_id: string
  time_log_ids: string[]
}

type TimeLogRow = {
  id: string
  task_id: string
  task_title: string | null
  hours: number
  minutes: number
  work_date: string
  description: string | null
  hourly_rate: number | null
  user_display_name: string | null
  project_name?: string | null
  user_id?: string
}

type TaskGroup = {
  task_id: string
  task_title: string
  logs: TimeLogRow[]
  totalHours: number
  rate: number
  selected: boolean
  project_name?: string
}

type VendorGroup = {
  vendor_id: string
  vendor_name: string
  taskGroups: TaskGroup[]
}

/* ─── helpers ─── */

const inputCls =
  'w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent'
const selectCls = inputCls
const labelCls = 'block text-sm font-medium text-gray-300 mb-1'
const btnPrimary =
  'px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 disabled:opacity-50'
const btnSecondary =
  'px-4 py-2.5 rounded-lg border border-border text-gray-300 hover:bg-surface-muted disabled:opacity-50'

function uid() {
  return crypto.randomUUID()
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function emptyItem(): LineItem {
  return {
    id: uid(),
    description: '',
    long_description: '',
    quantity: 1,
    unit_price: 0,
    unit: 'hours',
    tax_rate_id: '',
    time_log_ids: [],
  }
}

/* ─── component ─── */

export default function InvoiceForm() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const isEdit = Boolean(id)

  /* ── reference data ── */
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [currencies, setCurrencies] = useState<Currency[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  /* ── form fields ── */
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound')
  const [companyId, setCompanyId] = useState('')
  const [contactId, setContactId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [currencyId, setCurrencyId] = useState('')
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent')
  const [discountValue, setDiscountValue] = useState(0)
  const [adjustment, setAdjustment] = useState(0)
  const [items, setItems] = useState<LineItem[]>([emptyItem()])
  const [saving, setSaving] = useState(false)

  /* ── vendor multi-select (inbound) ── */
  const [vendorUsers, setVendorUsers] = useState<VendorUser[]>([])
  const [selectedVendorIds, setSelectedVendorIds] = useState<string[]>([])
  const [dateRangeStart, setDateRangeStart] = useState('')
  const [dateRangeEnd, setDateRangeEnd] = useState('')

  /* ── recurring ── */
  const [isRecurring, setIsRecurring] = useState(false)
  const [recurringInterval, setRecurringInterval] = useState('monthly')

  /* ── vendor groups for inbound time log modal ── */
  const [vendorGroups, setVendorGroups] = useState<VendorGroup[]>([])

  /* ── time logs modal ── */
  const [showTimeLogModal, setShowTimeLogModal] = useState(false)
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>([])
  const [loadingTimeLogs, setLoadingTimeLogs] = useState(false)

  /* ── drag state ── */
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  /* ── load reference data ── */
  useEffect(() => {
    if (!currentOrg?.id) return
    const orgId = currentOrg.id

    supabase
      .from('tax_rates')
      .select('id, name, rate, is_default')
      .eq('org_id', orgId)
      .order('name')
      .then(({ data }) => setTaxRates((data as TaxRate[] | null) ?? []))

    supabase
      .from('currencies')
      .select('id, code, name, symbol, is_default')
      .eq('org_id', orgId)
      .order('code')
      .then(({ data }) => {
        const rows = (data as Currency[] | null) ?? []
        setCurrencies(rows)
        const def = rows.find((c) => c.is_default)
        if (def && !currencyId) setCurrencyId(def.id)
      })

    supabase
      .from('companies')
      .select('id, name')
      .eq('org_id', orgId)
      .order('name')
      .then(({ data }) => setCompanies((data as Company[] | null) ?? []))

    supabase
      .from('contacts')
      .select('id, name, email, company_id')
      .eq('org_id', orgId)
      .order('name')
      .then(({ data }) => setContacts((data as Contact[] | null) ?? []))

    supabase
      .from('projects')
      .select('id, name')
      .eq('org_id', orgId)
      .order('name')
      .then(({ data }) => setProjects((data as Project[] | null) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id])

  /* ── load vendor users (for inbound) ── */
  useEffect(() => {
    if (!currentOrg?.id || direction !== 'inbound') return
    ;(async () => {
      const { data: rows } = await supabase
        .from('organization_users')
        .select('user_id, roles!inner(name), profiles:user_id(display_name)')
        .eq('org_id', currentOrg.id)
        .eq('roles.name', 'vendor')
      if (rows) {
        const vendors: VendorUser[] = (rows as unknown as { user_id: string; profiles: { display_name: string | null } | null }[]).map((r) => ({
          id: r.user_id,
          display_name: (r.profiles as { display_name: string | null } | null)?.display_name ?? 'Unknown Vendor',
        }))
        setVendorUsers(vendors)
      }
    })()
  }, [currentOrg?.id, direction])

  /* ── load existing invoice for edit ── */
  useEffect(() => {
    if (!id || !currentOrg?.id) return

    ;(async () => {
      const { data: inv } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', id)
        .eq('org_id', currentOrg.id)
        .single()

      if (!inv) return
      const d = inv as Record<string, unknown>
      setDirection((d.direction as 'outbound' | 'inbound') ?? 'outbound')
      setCompanyId((d.company_id as string) ?? '')
      setContactId((d.contact_id as string) ?? '')
      setProjectId((d.project_id as string) ?? '')
      setCurrencyId((d.currency_id as string) ?? '')
      setIssueDate((d.issue_date as string) ?? '')
      setDueDate((d.due_date as string) ?? '')
      setNotes((d.notes as string) ?? '')
      setTerms((d.terms as string) ?? '')
      setDiscountType((d.discount_type as 'percent' | 'fixed') ?? 'percent')
      setDiscountValue(Number(d.discount_value) || 0)
      setAdjustment(Number(d.adjustment) || 0)

      // load line items
      const { data: itemRows } = await supabase
        .from('invoice_items')
        .select('*')
        .eq('invoice_id', id)
        .order('sort_order')

      if (itemRows && itemRows.length > 0) {
        setItems(
          (itemRows as Record<string, unknown>[]).map((r) => ({
            id: (r.id as string) ?? uid(),
            description: (r.description as string) ?? '',
            long_description: (r.long_description as string) ?? '',
            quantity: Number(r.quantity) || 1,
            unit_price: Number(r.unit_price) || 0,
            unit: (r.unit as string) ?? 'hours',
            tax_rate_id: (r.tax_rate_id as string) ?? '',
            time_log_ids: (r.time_log_ids as string[]) ?? [],
          })),
        )
      }
    })()
  }, [id, currentOrg?.id])

  /* ── filtered contacts by company ── */
  const filteredContacts = useMemo(
    () => (companyId ? contacts.filter((c) => c.company_id === companyId) : contacts),
    [contacts, companyId],
  )

  /* reset contact when company changes */
  useEffect(() => {
    if (companyId && contactId) {
      const valid = contacts.find((c) => c.id === contactId && c.company_id === companyId)
      if (!valid) setContactId('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  /* ── line item helpers ── */

  const updateItem = useCallback((idx: number, patch: Partial<LineItem>) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)))
  }, [])

  const removeItem = useCallback((idx: number) => {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== idx)
      return next.length === 0 ? [emptyItem()] : next
    })
  }, [])

  const addItem = useCallback(() => {
    setItems((prev) => [...prev, emptyItem()])
  }, [])

  /* ── calculations ── */

  const taxRateMap = useMemo(() => {
    const m = new Map<string, number>()
    taxRates.forEach((tr) => m.set(tr.id, Number(tr.rate)))
    return m
  }, [taxRates])

  const lineCalcs = useMemo(() => {
    return items.map((item) => {
      const subtotal = round2(item.quantity * item.unit_price)
      const rate = item.tax_rate_id ? taxRateMap.get(item.tax_rate_id) ?? 0 : 0
      const tax = round2(subtotal * rate / 100)
      return { subtotal, tax, total: round2(subtotal + tax) }
    })
  }, [items, taxRateMap])

  const summary = useMemo(() => {
    const subtotal = round2(lineCalcs.reduce((s, l) => s + l.subtotal, 0))
    const taxTotal = round2(lineCalcs.reduce((s, l) => s + l.tax, 0))
    const discountTotal =
      discountType === 'percent'
        ? round2(subtotal * discountValue / 100)
        : round2(discountValue)
    const total = round2(subtotal + taxTotal - discountTotal + adjustment)
    return { subtotal, taxTotal, discountTotal, total }
  }, [lineCalcs, discountType, discountValue, adjustment])

  /* ── import time logs ── */

  const openTimeLogModal = useCallback(async () => {
    if (direction === 'inbound') {
      // Inbound: fetch by selected vendors + date range
      if (selectedVendorIds.length === 0 || !currentOrg?.id) return
      setShowTimeLogModal(true)
      setLoadingTimeLogs(true)

      let query = supabase
        .from('time_logs')
        .select('id, task_id, user_id, project_id, hours, minutes, work_date, description, hourly_rate, tasks(title), projects:project_id(name)')
        .in('user_id', selectedVendorIds)
        .eq('billed', false)
        .order('work_date', { ascending: false })

      if (dateRangeStart) query = query.gte('work_date', dateRangeStart)
      if (dateRangeEnd) query = query.lte('work_date', dateRangeEnd)

      const { data: rows } = await query

      if (!rows || rows.length === 0) {
        setVendorGroups([])
        setTaskGroups([])
        setLoadingTimeLogs(false)
        return
      }

      // Build a vendor name map
      const vendorNameMap = new Map<string, string>()
      vendorUsers.forEach((v) => vendorNameMap.set(v.id, v.display_name))

      // Map rows
      const mapped: (TimeLogRow & { vendor_id: string })[] = (rows as unknown[]).map((r) => {
        const row = r as TimeLogRow & { tasks?: { title?: string } | null; projects?: { name?: string } | null; user_id: string }
        return {
          id: row.id,
          task_id: row.task_id,
          task_title: row.tasks?.title ?? 'Untitled Task',
          hours: row.hours,
          minutes: row.minutes,
          work_date: row.work_date,
          description: row.description,
          hourly_rate: row.hourly_rate,
          user_display_name: vendorNameMap.get(row.user_id) ?? 'Unknown',
          project_name: (row as unknown as { projects?: { name?: string } | null }).projects?.name ?? null,
          user_id: row.user_id,
          vendor_id: row.user_id,
        }
      })

      // Group by vendor, then by task
      const vGroupMap = new Map<string, { vendor_id: string; vendor_name: string; taskMap: Map<string, TaskGroup> }>()
      mapped.forEach((log) => {
        let vg = vGroupMap.get(log.vendor_id)
        if (!vg) {
          vg = {
            vendor_id: log.vendor_id,
            vendor_name: vendorNameMap.get(log.vendor_id) ?? 'Unknown Vendor',
            taskMap: new Map(),
          }
          vGroupMap.set(log.vendor_id, vg)
        }
        const taskKey = `${log.vendor_id}:${log.task_id}`
        let tg = vg.taskMap.get(taskKey)
        if (!tg) {
          tg = {
            task_id: taskKey,
            task_title: log.task_title ?? 'Untitled Task',
            logs: [],
            totalHours: 0,
            rate: 0,
            selected: true,
            project_name: log.project_name ?? undefined,
          }
          vg.taskMap.set(taskKey, tg)
        }
        tg.logs.push(log)
        tg.totalHours += log.hours + log.minutes / 60
        if (log.hourly_rate != null && log.hourly_rate > 0) {
          tg.rate = log.hourly_rate
        }
      })

      const vGroups: VendorGroup[] = Array.from(vGroupMap.values()).map((vg) => ({
        vendor_id: vg.vendor_id,
        vendor_name: vg.vendor_name,
        taskGroups: Array.from(vg.taskMap.values()),
      }))

      setVendorGroups(vGroups)
      // Also flatten into taskGroups for import
      setTaskGroups(vGroups.flatMap((vg) => vg.taskGroups))
      setLoadingTimeLogs(false)
      return
    }

    // Outbound: existing behavior
    if (!projectId || !currentOrg?.id) return
    setShowTimeLogModal(true)
    setLoadingTimeLogs(true)

    // Fetch unbilled time logs for the selected project
    const { data: rows } = await supabase
      .from('time_logs')
      .select('id, task_id, hours, minutes, work_date, description, hourly_rate, tasks(title)')
      .eq('project_id', projectId)
      .eq('billed', false)
      .order('work_date', { ascending: false })

    if (!rows || rows.length === 0) {
      setTaskGroups([])
      setLoadingTimeLogs(false)
      return
    }

    // Get user display names
    const userIds = [...new Set((rows as unknown as { user_id: string }[]).map((r) => r.user_id))]
    const profileMap = new Map<string, string>()
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds)
      ;(profiles ?? []).forEach((p: { id: string; display_name: string | null }) => {
        profileMap.set(p.id, p.display_name ?? 'Unknown')
      })
    }

    // Map rows
    const mapped: TimeLogRow[] = (rows as unknown[]).map((r) => {
      const row = r as TimeLogRow & { tasks?: { title?: string } | null; user_id?: string }
      return {
        id: row.id,
        task_id: row.task_id,
        task_title: row.tasks?.title ?? 'Untitled Task',
        hours: row.hours,
        minutes: row.minutes,
        work_date: row.work_date,
        description: row.description,
        hourly_rate: row.hourly_rate,
        user_display_name: profileMap.get(row.user_id ?? '') ?? null,
      }
    })

    // Group by task
    const groupMap = new Map<string, TaskGroup>()
    mapped.forEach((log) => {
      let g = groupMap.get(log.task_id)
      if (!g) {
        g = {
          task_id: log.task_id,
          task_title: log.task_title ?? 'Untitled Task',
          logs: [],
          totalHours: 0,
          rate: 0,
          selected: true,
        }
        groupMap.set(log.task_id, g)
      }
      g.logs.push(log)
      g.totalHours += log.hours + log.minutes / 60
      // Use the latest non-null hourly_rate
      if (log.hourly_rate != null && log.hourly_rate > 0) {
        g.rate = log.hourly_rate
      }
    })

    setTaskGroups(Array.from(groupMap.values()))
    setLoadingTimeLogs(false)
  }, [direction, selectedVendorIds, dateRangeStart, dateRangeEnd, vendorUsers, projectId, currentOrg?.id])

  const toggleTaskGroup = useCallback((taskId: string) => {
    setTaskGroups((prev) =>
      prev.map((g) => (g.task_id === taskId ? { ...g, selected: !g.selected } : g)),
    )
  }, [])

  const importSelectedTimeLogs = useCallback(() => {
    const selected = taskGroups.filter((g) => g.selected)
    if (selected.length === 0) {
      setShowTimeLogModal(false)
      return
    }

    const newItems: LineItem[] = selected.map((g) => ({
      id: uid(),
      description: g.task_title,
      long_description: g.logs
        .map(
          (l) =>
            `${l.work_date}: ${l.hours}h ${l.minutes}m${l.description ? ' — ' + l.description : ''}`,
        )
        .join('\n'),
      quantity: round2(g.totalHours),
      unit_price: g.rate,
      unit: 'hours',
      tax_rate_id: '',
      time_log_ids: g.logs.map((l) => l.id),
    }))

    // Remove empty placeholder items and append new items
    setItems((prev) => {
      const existing = prev.filter(
        (item) => item.description.trim() !== '' || item.unit_price > 0,
      )
      return [...existing, ...newItems]
    })

    setShowTimeLogModal(false)
  }, [taskGroups])

  /* ── drag reorder ── */
  const handleDragStart = (idx: number) => setDragIdx(idx)

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    setItems((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(idx, 0, moved)
      return next
    })
    setDragIdx(idx)
  }

  const handleDragEnd = () => setDragIdx(null)

  /* ── save ── */

  const handleSave = async (sendAfterSave: boolean) => {
    if (!currentOrg?.id || !user?.id) return
    setSaving(true)

    try {
      const prefix = direction === 'outbound' ? 'INV-' : 'BILL-'

      // Build invoice payload (without number for new invoices — assigned via RPC)
      const invoicePayload: Record<string, unknown> = {
        org_id: currentOrg.id,
        direction,
        prefix,
        status: sendAfterSave ? 'sent' : 'draft',
        company_id: direction === 'inbound' ? null : (companyId || null),
        contact_id: direction === 'inbound' ? null : (contactId || null),
        project_id: projectId || null,
        issue_date: issueDate,
        due_date: dueDate || null,
        currency_id: currencyId || null,
        subtotal: summary.subtotal,
        tax_total: summary.taxTotal,
        discount_type: discountType,
        discount_value: discountValue,
        discount_total: summary.discountTotal,
        adjustment,
        total: summary.total,
        amount_due: summary.total,
        notes: notes.trim() || null,
        terms: terms.trim() || null,
        updated_at: new Date().toISOString(),
        vendor_user_id: direction === 'inbound' ? (selectedVendorIds[0] || null) : null,
        is_recurring: isRecurring,
        recurring_interval: isRecurring ? recurringInterval : null,
        next_recurring_date: isRecurring ? (() => {
          const d = new Date(issueDate)
          switch (recurringInterval) {
            case 'weekly': d.setDate(d.getDate() + 7); break
            case 'bi-weekly': d.setDate(d.getDate() + 14); break
            case 'monthly': d.setMonth(d.getMonth() + 1); break
            case 'quarterly': d.setMonth(d.getMonth() + 3); break
            case 'yearly': d.setFullYear(d.getFullYear() + 1); break
          }
          return d.toISOString().split('T')[0]
        })() : null,
      }

      let invoiceId: string

      if (isEdit && id) {
        // Update existing
        const { error } = await supabase
          .from('invoices')
          .update(invoicePayload)
          .eq('id', id)
          .eq('org_id', currentOrg.id)

        if (error) {
          console.error('Error updating invoice:', error)
          setSaving(false)
          return
        }
        invoiceId = id

        // Delete old items and re-insert
        await supabase.from('invoice_items').delete().eq('invoice_id', id)
      } else {
        // Get next invoice number
        const { data: numData, error: numErr } = await supabase.rpc('next_invoice_number', {
          p_org_id: currentOrg.id,
          p_direction: direction,
        })

        if (numErr) {
          console.error('Error getting invoice number:', numErr)
          setSaving(false)
          return
        }

        invoicePayload.number = numData as number
        invoicePayload.created_by = user.id

        const { data: insertedInv, error: insertErr } = await supabase
          .from('invoices')
          .insert(invoicePayload)
          .select('id')
          .single()

        if (insertErr || !insertedInv) {
          console.error('Error creating invoice:', insertErr)
          setSaving(false)
          return
        }

        invoiceId = (insertedInv as { id: string }).id
      }

      // Insert line items
      const itemPayloads = items
        .filter((item) => item.description.trim() !== '')
        .map((item, idx) => {
          const calc = lineCalcs[items.indexOf(item)] ?? { subtotal: 0, tax: 0, total: 0 }
          return {
            invoice_id: invoiceId,
            description: item.description,
            long_description: item.long_description || null,
            quantity: item.quantity,
            unit_price: item.unit_price,
            unit: item.unit,
            tax_rate_id: item.tax_rate_id || null,
            tax_amount: calc.tax,
            subtotal: calc.subtotal,
            total: calc.total,
            sort_order: idx,
            time_log_ids: item.time_log_ids.length > 0 ? item.time_log_ids : [],
          }
        })

      if (itemPayloads.length > 0) {
        const { error: itemsErr } = await supabase.from('invoice_items').insert(itemPayloads)
        if (itemsErr) {
          console.error('Error inserting invoice items:', itemsErr)
        }
      }

      navigate(`/invoices`)
    } catch (err) {
      console.error('Unexpected error saving invoice:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleSave(false)
  }

  /* ── currency symbol ── */
  const currSymbol = useMemo(() => {
    const c = currencies.find((c) => c.id === currencyId)
    return c?.symbol ?? '$'
  }, [currencies, currencyId])

  /* ─── render ─── */

  return (
    <div className="p-4 md:p-6 max-w-5xl" data-testid="invoice-form">
      {/* Back link */}
      <Link
        to={isEdit ? `/invoices` : '/invoices'}
        className="inline-flex items-center gap-2 text-sm text-surface-muted hover:text-gray-300 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to invoices
      </Link>

      <h1 className="text-xl font-semibold text-white mb-6">
        {isEdit ? 'Edit Invoice' : 'New Invoice'}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* ─── Header fields ─── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Direction */}
          <div>
            <label className={labelCls}>Type</label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'outbound' | 'inbound')}
              className={selectCls}
              disabled={isEdit}
            >
              <option value="outbound">Invoice (Outbound)</option>
              <option value="inbound">Bill (Inbound)</option>
            </select>
          </div>

          {/* Company (outbound only) */}
          {direction === 'outbound' && (
          <div>
            <label className={labelCls}>
              Client Company
            </label>
            <select
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className={selectCls}
            >
              <option value="">— Select company —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          )}

          {/* Contact (outbound only) */}
          {direction === 'outbound' && (
          <div>
            <label className={labelCls}>Contact</label>
            <select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className={selectCls}
            >
              <option value="">— Select contact —</option>
              {filteredContacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.email ? ` (${c.email})` : ''}
                </option>
              ))}
            </select>
          </div>
          )}

          {/* Vendor multi-select (inbound only) */}
          {direction === 'inbound' && (
          <div className="lg:col-span-3">
            <label className={labelCls}>Select Vendors</label>
            {vendorUsers.length === 0 ? (
              <p className="text-sm text-gray-500">No vendors found in this organization.</p>
            ) : (
              <div className="flex flex-wrap gap-2 mt-1">
                {vendorUsers.map((v) => {
                  const sel = selectedVendorIds.includes(v.id)
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() =>
                        setSelectedVendorIds((prev) =>
                          sel ? prev.filter((id) => id !== v.id) : [...prev, v.id],
                        )
                      }
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        sel
                          ? 'border-accent bg-accent/10 text-white'
                          : 'border-border bg-surface-muted text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          sel ? 'bg-accent border-accent' : 'border-gray-500 bg-transparent'
                        }`}
                      >
                        {sel && <Check className="w-3 h-3 text-white" />}
                      </div>
                      {v.display_name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          )}

          {/* Date range for inbound */}
          {direction === 'inbound' && (
          <>
            <div>
              <label className={labelCls}>Start Date (filter)</label>
              <input
                type="date"
                value={dateRangeStart}
                onChange={(e) => setDateRangeStart(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>End Date (filter)</label>
              <input
                type="date"
                value={dateRangeEnd}
                onChange={(e) => setDateRangeEnd(e.target.value)}
                className={inputCls}
              />
            </div>
          </>
          )}

          {/* Project */}
          <div>
            <label className={labelCls}>Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={selectCls}
            >
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Currency */}
          <div>
            <label className={labelCls}>Currency</label>
            <select
              value={currencyId}
              onChange={(e) => setCurrencyId(e.target.value)}
              className={selectCls}
            >
              <option value="">— Select currency —</option>
              {currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Issue date */}
          <div>
            <label className={labelCls}>Issue Date</label>
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
              className={inputCls}
            />
          </div>

          {/* Due date */}
          <div>
            <label className={labelCls}>Due Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {/* ─── Recurring ─── */}
        <div className="rounded-lg border border-border bg-surface-muted p-4 space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              className={`w-5 h-5 rounded border flex items-center justify-center ${
                isRecurring ? 'bg-accent border-accent' : 'border-gray-500 bg-transparent'
              }`}
              onClick={() => setIsRecurring(!isRecurring)}
            >
              {isRecurring && <Check className="w-3.5 h-3.5 text-white" />}
            </div>
            <input
              type="checkbox"
              checked={isRecurring}
              onChange={(e) => setIsRecurring(e.target.checked)}
              className="sr-only"
            />
            <span className="text-sm font-medium text-white">Recurring</span>
          </label>

          {isRecurring && (
            <div className="space-y-3 ml-8">
              <div className="max-w-xs">
                <label className={labelCls}>Interval</label>
                <select
                  value={recurringInterval}
                  onChange={(e) => setRecurringInterval(e.target.value)}
                  className={selectCls}
                >
                  <option value="weekly">Weekly</option>
                  <option value="bi-weekly">Bi-weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <p className="text-xs text-gray-500">
                {direction === 'outbound'
                  ? 'Invoice will be auto-generated on schedule.'
                  : 'Bill will be auto-generated from vendor time logs on schedule.'}
              </p>
            </div>
          )}
        </div>

        {/* ─── Line Items ─── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-medium text-white">Line Items</h2>
            <div className="flex gap-2">
              {(direction === 'inbound' || projectId) && (
                <button
                  type="button"
                  onClick={openTimeLogModal}
                  className={`${btnSecondary} inline-flex items-center gap-2 text-sm`}
                >
                  <Clock className="w-4 h-4" />
                  Import from Time Logs
                </button>
              )}
              <button
                type="button"
                onClick={addItem}
                className={`${btnSecondary} inline-flex items-center gap-2 text-sm`}
              >
                <Plus className="w-4 h-4" />
                Add Row
              </button>
            </div>
          </div>

          {/* Table header */}
          <div className="hidden md:grid md:grid-cols-[32px_1fr_80px_100px_80px_120px_100px_100px_36px] gap-2 text-xs text-gray-400 uppercase tracking-wider mb-2 px-1">
            <div></div>
            <div>Description</div>
            <div className="text-right">Qty</div>
            <div className="text-right">Unit Price</div>
            <div>Unit</div>
            <div>Tax Rate</div>
            <div className="text-right">Subtotal</div>
            <div className="text-right">Tax</div>
            <div></div>
          </div>

          {/* Line item rows */}
          <div className="space-y-2">
            {items.map((item, idx) => {
              const calc = lineCalcs[idx] ?? { subtotal: 0, tax: 0, total: 0 }
              return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                  className={`rounded-lg border border-border bg-surface-muted p-3 md:p-2 ${
                    dragIdx === idx ? 'opacity-50' : ''
                  }`}
                >
                  {/* Desktop layout */}
                  <div className="hidden md:grid md:grid-cols-[32px_1fr_80px_100px_80px_120px_100px_100px_36px] gap-2 items-center">
                    <div className="cursor-grab text-gray-500 hover:text-gray-300 flex justify-center">
                      <GripVertical className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => updateItem(idx, { description: e.target.value })}
                      placeholder="Item description"
                      className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.quantity || ''}
                      onChange={(e) =>
                        updateItem(idx, { quantity: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.unit_price || ''}
                      onChange={(e) =>
                        updateItem(idx, { unit_price: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <select
                      value={item.unit}
                      onChange={(e) => updateItem(idx, { unit: e.target.value })}
                      className="w-full rounded border border-border bg-transparent px-1 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="hours">hrs</option>
                      <option value="qty">qty</option>
                      <option value="days">days</option>
                      <option value="units">units</option>
                    </select>
                    <select
                      value={item.tax_rate_id}
                      onChange={(e) => updateItem(idx, { tax_rate_id: e.target.value })}
                      className="w-full rounded border border-border bg-transparent px-1 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="">No tax</option>
                      {taxRates.map((tr) => (
                        <option key={tr.id} value={tr.id}>
                          {tr.name} ({tr.rate}%)
                        </option>
                      ))}
                    </select>
                    <div className="text-sm text-gray-300 text-right tabular-nums">
                      {currSymbol}
                      {calc.subtotal.toFixed(2)}
                    </div>
                    <div className="text-sm text-gray-400 text-right tabular-nums">
                      {calc.tax > 0 ? `${currSymbol}${calc.tax.toFixed(2)}` : '—'}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      className="text-gray-500 hover:text-red-400 flex justify-center"
                      title="Remove row"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Mobile layout */}
                  <div className="md:hidden space-y-2">
                    <div className="flex items-center gap-2">
                      <GripVertical className="w-4 h-4 text-gray-500 cursor-grab flex-shrink-0" />
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) => updateItem(idx, { description: e.target.value })}
                        placeholder="Item description"
                        className="flex-1 rounded border border-border bg-transparent px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-gray-500 hover:text-red-400 flex-shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-xs text-gray-500">Qty</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.quantity || ''}
                          onChange={(e) =>
                            updateItem(idx, { quantity: parseFloat(e.target.value) || 0 })
                          }
                          className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Price</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.unit_price || ''}
                          onChange={(e) =>
                            updateItem(idx, { unit_price: parseFloat(e.target.value) || 0 })
                          }
                          className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Tax</label>
                        <select
                          value={item.tax_rate_id}
                          onChange={(e) => updateItem(idx, { tax_rate_id: e.target.value })}
                          className="w-full rounded border border-border bg-transparent px-1 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
                        >
                          <option value="">None</option>
                          {taxRates.map((tr) => (
                            <option key={tr.id} value={tr.id}>
                              {tr.name} ({tr.rate}%)
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">
                        Subtotal: {currSymbol}
                        {calc.subtotal.toFixed(2)}
                      </span>
                      {calc.tax > 0 && (
                        <span className="text-gray-500">
                          Tax: {currSymbol}
                          {calc.tax.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Long description (expandable) */}
                  {item.long_description && (
                    <div className="mt-2 ml-8 md:ml-8">
                      <p className="text-xs text-gray-500 whitespace-pre-wrap">
                        {item.long_description}
                      </p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ─── Discount & Adjustment ─── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={labelCls}>Discount Type</label>
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as 'percent' | 'fixed')}
              className={selectCls}
            >
              <option value="percent">Percentage (%)</option>
              <option value="fixed">Fixed Amount ({currSymbol})</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>
              Discount Value{discountType === 'percent' ? ' (%)' : ` (${currSymbol})`}
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={discountValue || ''}
              onChange={(e) => setDiscountValue(parseFloat(e.target.value) || 0)}
              className={inputCls}
              placeholder="0"
            />
          </div>
          <div>
            <label className={labelCls}>Adjustment ({currSymbol})</label>
            <input
              type="number"
              step="0.01"
              value={adjustment || ''}
              onChange={(e) => setAdjustment(parseFloat(e.target.value) || 0)}
              className={inputCls}
              placeholder="0.00"
            />
          </div>
        </div>

        {/* ─── Summary ─── */}
        <div className="rounded-lg border border-border bg-surface-muted p-4 md:p-6 max-w-sm ml-auto">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Subtotal</span>
              <span className="text-white tabular-nums">
                {currSymbol}
                {summary.subtotal.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Tax</span>
              <span className="text-white tabular-nums">
                {currSymbol}
                {summary.taxTotal.toFixed(2)}
              </span>
            </div>
            {summary.discountTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">
                  Discount
                  {discountType === 'percent' ? ` (${discountValue}%)` : ''}
                </span>
                <span className="text-red-400 tabular-nums">
                  -{currSymbol}
                  {summary.discountTotal.toFixed(2)}
                </span>
              </div>
            )}
            {adjustment !== 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">Adjustment</span>
                <span className="text-white tabular-nums">
                  {adjustment >= 0 ? '+' : '-'}
                  {currSymbol}
                  {Math.abs(adjustment).toFixed(2)}
                </span>
              </div>
            )}
            <div className="border-t border-border pt-2 flex justify-between font-semibold">
              <span className="text-gray-200">Total</span>
              <span className="text-white tabular-nums text-lg">
                {currSymbol}
                {summary.total.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* ─── Notes & Terms ─── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className={`${inputCls} resize-y`}
              placeholder="Notes visible to the client…"
            />
          </div>
          <div>
            <label className={labelCls}>Terms</label>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={3}
              className={`${inputCls} resize-y`}
              placeholder="Payment terms, late fee policy…"
            />
          </div>
        </div>

        {/* ─── Actions ─── */}
        <div className="flex flex-wrap gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className={btnPrimary}
          >
            {saving ? 'Saving…' : 'Save as Draft'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleSave(true)}
            className={`${btnPrimary} bg-green-600 hover:bg-green-700`}
          >
            {saving ? 'Saving…' : 'Save & Send'}
          </button>
          <Link to="/invoices" className={btnSecondary}>
            Cancel
          </Link>
        </div>
      </form>

      {/* ─── Import Time Logs Modal ─── */}
      {showTimeLogModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl max-h-[80vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <h3 className="text-lg font-semibold text-white">Import from Time Logs</h3>
              <button
                type="button"
                onClick={() => setShowTimeLogModal(false)}
                className="text-gray-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {loadingTimeLogs ? (
                <div className="flex items-center justify-center py-12 text-gray-400">
                  Loading time logs…
                </div>
              ) : taskGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <Clock className="w-10 h-10 mb-3 opacity-50" />
                  <p>No unbilled time logs found{direction === 'outbound' ? ' for this project' : ''}.</p>
                </div>
              ) : direction === 'inbound' && vendorGroups.length > 0 ? (
                <div className="space-y-4">
                  <p className="text-sm text-gray-400 mb-4">
                    Select task groups to import as line items. Grouped by vendor.
                  </p>
                  {vendorGroups.map((vg) => (
                    <div key={vg.vendor_id}>
                      <h4 className="text-sm font-semibold text-accent mb-2">{vg.vendor_name}</h4>
                      <div className="space-y-2 ml-2">
                        {vg.taskGroups.map((group) => (
                          <label
                            key={group.task_id}
                            className={`block rounded-lg border p-4 cursor-pointer transition-colors ${
                              group.selected
                                ? 'border-accent bg-accent/10'
                                : 'border-border bg-surface-muted hover:border-gray-600'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5">
                                <div
                                  className={`w-5 h-5 rounded border flex items-center justify-center ${
                                    group.selected
                                      ? 'bg-accent border-accent'
                                      : 'border-gray-500 bg-transparent'
                                  }`}
                                >
                                  {group.selected && <Check className="w-3.5 h-3.5 text-white" />}
                                </div>
                                <input
                                  type="checkbox"
                                  checked={group.selected}
                                  onChange={() => toggleTaskGroup(group.task_id)}
                                  className="sr-only"
                                />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between">
                                  <span className="font-medium text-white">
                                    {group.task_title}
                                    {group.project_name && (
                                      <span className="text-gray-500 font-normal ml-2 text-xs">({group.project_name})</span>
                                    )}
                                  </span>
                                  <span className="text-sm text-gray-300 tabular-nums ml-2">
                                    {round2(group.totalHours).toFixed(2)} hrs
                                    {group.rate > 0 && (
                                      <span className="text-gray-500">
                                        {' '}× {currSymbol}{group.rate.toFixed(2)}
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <div className="mt-1 text-xs text-gray-500">
                                  {group.logs.length} time{group.logs.length !== 1 ? ' entries' : ' entry'}
                                  {group.rate > 0 && (
                                    <span> · Est. {currSymbol}{round2(group.totalHours * group.rate).toFixed(2)}</span>
                                  )}
                                </div>
                                <div className="mt-2 space-y-1">
                                  {group.logs.slice(0, 5).map((log) => (
                                    <div key={log.id} className="text-xs text-gray-500">
                                      {log.work_date}: {log.hours}h {log.minutes}m
                                      {log.description && ` — ${log.description}`}
                                    </div>
                                  ))}
                                  {group.logs.length > 5 && (
                                    <div className="text-xs text-gray-600">
                                      +{group.logs.length - 5} more entries
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-gray-400 mb-4">
                    Select task groups to import as line items. Each task becomes one line item with
                    total hours.
                  </p>
                  {taskGroups.map((group) => (
                    <label
                      key={group.task_id}
                      className={`block rounded-lg border p-4 cursor-pointer transition-colors ${
                        group.selected
                          ? 'border-accent bg-accent/10'
                          : 'border-border bg-surface-muted hover:border-gray-600'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">
                          <div
                            className={`w-5 h-5 rounded border flex items-center justify-center ${
                              group.selected
                                ? 'bg-accent border-accent'
                                : 'border-gray-500 bg-transparent'
                            }`}
                          >
                            {group.selected && <Check className="w-3.5 h-3.5 text-white" />}
                          </div>
                          <input
                            type="checkbox"
                            checked={group.selected}
                            onChange={() => toggleTaskGroup(group.task_id)}
                            className="sr-only"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-white">{group.task_title}</span>
                            <span className="text-sm text-gray-300 tabular-nums ml-2">
                              {round2(group.totalHours).toFixed(2)} hrs
                              {group.rate > 0 && (
                                <span className="text-gray-500">
                                  {' '}
                                  × {currSymbol}
                                  {group.rate.toFixed(2)}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-gray-500">
                            {group.logs.length} time{group.logs.length !== 1 ? ' entries' : ' entry'}
                            {group.rate > 0 && (
                              <span>
                                {' '}
                                · Est. {currSymbol}
                                {round2(group.totalHours * group.rate).toFixed(2)}
                              </span>
                            )}
                          </div>
                          {/* Show individual entries */}
                          <div className="mt-2 space-y-1">
                            {group.logs.slice(0, 5).map((log) => (
                              <div key={log.id} className="text-xs text-gray-500">
                                {log.work_date}: {log.hours}h {log.minutes}m
                                {log.description && ` — ${log.description}`}
                              </div>
                            ))}
                            {group.logs.length > 5 && (
                              <div className="text-xs text-gray-600">
                                +{group.logs.length - 5} more entries
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="border-t border-border px-6 py-4 flex justify-between items-center">
              <span className="text-sm text-gray-400">
                {taskGroups.filter((g) => g.selected).length} of {taskGroups.length} tasks selected
              </span>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowTimeLogModal(false)}
                  className={btnSecondary}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={importSelectedTimeLogs}
                  disabled={taskGroups.filter((g) => g.selected).length === 0}
                  className={btnPrimary}
                >
                  Import Selected
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
