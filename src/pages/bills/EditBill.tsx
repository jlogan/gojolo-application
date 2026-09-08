import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import DateInput from '@/components/DateInput'
import {
  assertBillEditPayloadInvariants,
  assertBillStillEditable,
  buildBillHeaderUpdatePayload,
  buildBillLineUpdatePayloads,
  canEditOpenBill,
  computeBillEditPreviewTotal,
  computeBillLineAmounts,
  roundMoney,
  validateBillEditForm,
} from '@/lib/billEdit'
import { billStatusLabel } from '@/lib/billStatus'
import { supabase } from '@/lib/supabase'

type BillRow = {
  id: string
  number: number | null
  prefix: string | null
  status: string
  direction: string
  org_id: string
  issue_date: string | null
  notes: string | null
  billing_period_start: string | null
  billing_period_end: string | null
  billing_source: string | null
  amount_paid: number | null
  adjustment: number | null
  discount_total: number | null
  discount_type: string | null
  discount_value: number | null
  vendor_user_id: string | null
  project_id: string | null
  projects: { name: string } | { name: string }[] | null
}

type ItemRow = {
  id: string
  description: string
  long_description: string | null
  quantity: number
  unit_price: number
  tax_amount: number | null
  sort_order: number
  time_log_ids: string[] | null
}

type EditableLine = {
  id: string
  description: string
  long_description: string
  quantity: string
  unit_price: string
  tax_amount: number
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount)
}

function billNumber(bill: Pick<BillRow, 'prefix' | 'number'>) {
  const prefix = (bill.prefix ?? 'BILL-').replace(/-+$/, '')
  return bill.number ? `${prefix}-${String(bill.number).padStart(4, '0')}` : 'Bill'
}

function projectName(projects: BillRow['projects']) {
  if (!projects) return null
  return Array.isArray(projects) ? projects[0]?.name ?? null : projects.name
}

export default function EditBill() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { currentOrg, isOrgAdmin, isVendor } = useOrg()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bill, setBill] = useState<BillRow | null>(null)
  const [vendorLabel, setVendorLabel] = useState<string | null>(null)
  const [originalLineIds, setOriginalLineIds] = useState<string[]>([])

  const [issueDate, setIssueDate] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<EditableLine[]>([])

  const loadBill = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!id || !currentOrg?.id) return
    setLoading(true)
    setError(null)

    const { data, error: loadErr } = await supabase
      .from('invoices')
      .select(
        'id, number, prefix, status, direction, org_id, issue_date, notes, billing_period_start, billing_period_end, billing_source, amount_paid, adjustment, discount_total, discount_type, discount_value, vendor_user_id, project_id, projects(name)',
      )
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .eq('direction', 'inbound')
      .maybeSingle()

    if (signal?.cancelled) return

    if (loadErr || !data) {
      setBill(null)
      setLoading(false)
      setError(loadErr?.message ?? 'Bill not found.')
      return
    }

    const loaded = data as unknown as BillRow
    if (
      !canEditOpenBill({
        isOrgAdmin,
        isVendor,
        direction: loaded.direction,
        orgId: loaded.org_id,
        currentOrgId: currentOrg.id,
        status: loaded.status,
      })
    ) {
      setBill(loaded)
      setLoading(false)
      setError('Only admins can edit Open bills.')
      return
    }

    const { data: itemRows, error: itemsErr } = await supabase
      .from('invoice_items')
      .select('id, description, long_description, quantity, unit_price, tax_amount, sort_order, time_log_ids')
      .eq('invoice_id', loaded.id)
      .order('sort_order')

    if (signal?.cancelled) return

    if (itemsErr) {
      setBill(null)
      setLoading(false)
      setError(itemsErr.message)
      return
    }

    const items = (itemRows ?? []) as ItemRow[]
    let vendorName: string | null = null
    if (loaded.vendor_user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name, email')
        .eq('id', loaded.vendor_user_id)
        .maybeSingle()
      if (!signal?.cancelled) {
        vendorName = (profile as { display_name: string | null; email: string | null } | null)?.display_name
          || (profile as { display_name: string | null; email: string | null } | null)?.email
          || null
      }
    }

    if (signal?.cancelled) return

    setBill(loaded)
    setVendorLabel(vendorName)
    setIssueDate(loaded.issue_date ?? '')
    setPeriodStart(loaded.billing_period_start ?? '')
    setPeriodEnd(loaded.billing_period_end ?? '')
    setNotes(loaded.notes ?? '')
    setOriginalLineIds(items.map((item) => item.id))
    setLines(
      items.map((item) => ({
        id: item.id,
        description: item.description ?? '',
        long_description: item.long_description ?? '',
        quantity: String(item.quantity ?? ''),
        unit_price: String(item.unit_price ?? ''),
        tax_amount: Number(item.tax_amount ?? 0),
      })),
    )
    setLoading(false)
  }, [id, currentOrg?.id, isOrgAdmin, isVendor])

  useEffect(() => {
    const signal = { cancelled: false }
    loadBill(signal)
    return () => { signal.cancelled = true }
  }, [loadBill])

  const previewTotal = useMemo(() => {
    const parsed = lines.map((line) => ({
      quantity: parseFloat(line.quantity) || 0,
      unit_price: parseFloat(line.unit_price) || 0,
      tax_amount: line.tax_amount,
    }))
    return computeBillEditPreviewTotal(parsed, {
      adjustment: bill?.adjustment,
      discountTotal: bill?.discount_total,
      discountType: bill?.discount_type, discountValue: bill?.discount_value,
    })
  }, [lines, bill?.adjustment, bill?.discount_total, bill?.discount_type, bill?.discount_value])

  const updateLine = (lineId: string, patch: Partial<EditableLine>) => {
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, ...patch } : line)))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!bill || !currentOrg?.id) return

    const validation = validateBillEditForm({
      issueDate,
      periodStart,
      periodEnd,
      lines: lines.map((line) => ({
        id: line.id,
        description: line.description,
        long_description: line.long_description,
        quantity: line.quantity,
        unit_price: line.unit_price,
      })),
      amountPaid: Number(bill.amount_paid ?? 0),
      adjustment: bill.adjustment,
      discountTotal: bill.discount_total,
      discountType: bill.discount_type, discountValue: bill.discount_value,
      lineTaxAmounts: Object.fromEntries(lines.map((line) => [line.id, line.tax_amount])),
    })

    if (!validation.ok) {
      setError(validation.error)
      return
    }

    setSaving(true)
    setError(null)

    try {
      const { data: fresh, error: freshErr } = await supabase
        .from('invoices')
        .select('id, direction, org_id, status, amount_paid, adjustment, discount_total, discount_type, discount_value')
        .eq('id', bill.id)
        .eq('org_id', currentOrg.id)
        .eq('direction', 'inbound')
        .maybeSingle()

      if (freshErr || !fresh) {
        setError(freshErr?.message ?? 'Bill not found.')
        setSaving(false)
        return
      }

      const freshRow = fresh as {
        id: string
        direction: string
        org_id: string
        status: string
        amount_paid: number | null
        adjustment: number | null
        discount_total: number | null
  discount_type: string | null
  discount_value: number | null
      }

      const stillEditable = assertBillStillEditable({
        isOrgAdmin,
        isVendor,
        direction: freshRow.direction,
        org_id: freshRow.org_id,
        status: freshRow.status,
        amount_paid: freshRow.amount_paid,
        currentOrgId: currentOrg.id,
      })
      if (!stillEditable.ok) {
        setError(stillEditable.error)
        setSaving(false)
        return
      }

      const revalidated = validateBillEditForm({
        issueDate,
        periodStart,
        periodEnd,
        lines: lines.map((line) => ({
          id: line.id,
          description: line.description,
          long_description: line.long_description,
          quantity: line.quantity,
          unit_price: line.unit_price,
        })),
        amountPaid: Number(freshRow.amount_paid ?? 0),
        adjustment: freshRow.adjustment,
        discountTotal: freshRow.discount_total,
        discountType: freshRow.discount_type, discountValue: freshRow.discount_value,
        lineTaxAmounts: Object.fromEntries(lines.map((line) => [line.id, line.tax_amount])),
      })
      if (!revalidated.ok) {
        setError(revalidated.error)
        setSaving(false)
        return
      }

      const header = buildBillHeaderUpdatePayload({
        issueDate,
        periodStart,
        periodEnd,
        notes,
      })
      const linePayloads = buildBillLineUpdatePayloads(
        revalidated.lines.map((line) => ({
          id: line.id,
          description: line.description,
          long_description: line.long_description,
          quantity: line.quantity,
          unit_price: line.unit_price,
          tax_amount: line.tax_amount,
        })),
      )

      const invariants = assertBillEditPayloadInvariants({
        header: header as unknown as Record<string, unknown>,
        lines: linePayloads as unknown as Array<Record<string, unknown>>,
        originalLineIds,
      })
      if (!invariants.ok) {
        setError(invariants.error)
        setSaving(false)
        return
      }

      const { data: savedHeader, error: headerErr } = await supabase
        .from('invoices')
        .update(header)
        .eq('id', bill.id)
        .eq('org_id', currentOrg.id)
        .eq('direction', 'inbound')
        .eq('status', freshRow.status)
        .eq('amount_paid', freshRow.amount_paid ?? 0)
        .select('id')
        .maybeSingle()

      if (headerErr || !savedHeader) {
        setError(headerErr?.message ?? 'Bill changed while editing. Reload before saving.')
        setSaving(false)
        return
      }

      for (const line of linePayloads) {
        const { id: lineId, ...fields } = line
        const { data: savedLine, error: lineErr } = await supabase
          .from('invoice_items')
          .update(fields)
          .eq('id', lineId)
          .eq('invoice_id', bill.id)
          .select('id')
          .maybeSingle()

        if (lineErr || !savedLine) {
          setError(`Some changes may have saved. Reload before retrying. ${lineErr?.message ?? 'Line item no longer available.'}`)
          setSaving(false)
          return
        }
      }

      navigate(`/bills/${bill.id}`)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  if (!isOrgAdmin || isVendor) {
    return <div className="p-6 text-gray-300">Only admins can edit Open bills.</div>
  }

  if (loading) {
    return <div className="p-6 text-gray-400">Loading bill...</div>
  }

  if (!bill) {
    return (
      <div className="p-6">
        <p className="text-gray-300">{error ?? 'Bill not found.'}</p>
        <Link to="/bills" className="mt-3 inline-block text-accent">Back to bills</Link>
      </div>
    )
  }

  if (
    !canEditOpenBill({
      isOrgAdmin,
      isVendor,
      direction: bill.direction,
      orgId: bill.org_id,
      currentOrgId: currentOrg?.id,
      status: bill.status,
    })
  ) {
    return (
      <div className="p-6">
        <p className="text-gray-300">{error ?? 'This bill cannot be edited.'}</p>
        <Link to={`/bills/${bill.id}`} className="mt-3 inline-block text-accent">Back to bill</Link>
      </div>
    )
  }

  const amountPaid = roundMoney(Number(bill.amount_paid ?? 0))
  const project = projectName(bill.projects)

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto" data-testid="edit-bill-page">
      <Link
        to={`/bills/${bill.id}`}
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Back to bill
      </Link>

      <div className="mb-5">
        <h1 className="text-xl font-semibold text-white">Edit bill</h1>
        <p className="text-sm text-gray-400 mt-1">
          {billNumber(bill)} · {billStatusLabel(bill.status)}
          {vendorLabel ? ` · ${vendorLabel}` : ''}
          {project ? ` · ${project}` : ''}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Bill number, billing source, status, and payments are preserved. Line links to time logs stay unchanged.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-lg border border-border bg-surface-elevated p-5 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Issue date</label>
              <DateInput
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                required
                disabled={saving}
                className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Billing period start</label>
              <DateInput
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                required
                disabled={saving}
                className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Billing period end</label>
              <DateInput
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                required
                disabled={saving}
                className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              disabled={saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500"
              placeholder="Optional notes for this bill"
            />
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface-elevated p-5 space-y-4">
          <h2 className="text-sm font-medium text-white">Line items</h2>
          {lines.map((line, index) => {
            const qty = parseFloat(line.quantity) || 0
            const rate = parseFloat(line.unit_price) || 0
            const { total } = computeBillLineAmounts(qty, rate, line.tax_amount)
            return (
              <div
                key={line.id}
                className="rounded-lg border border-border bg-surface-muted/40 p-4 space-y-3"
                data-testid={`edit-bill-line-${line.id}`}
              >
                <div className="text-xs text-gray-500">Line {index + 1}</div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Description</label>
                  <input
                    type="text"
                    value={line.description}
                    onChange={(e) => updateLine(line.id, { description: e.target.value })}
                    required
                    disabled={saving}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Long description</label>
                  <textarea
                    value={line.long_description}
                    onChange={(e) => updateLine(line.id, { long_description: e.target.value })}
                    rows={3}
                    disabled={saving}
                    className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500"
                    placeholder="Optional details"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.id, { quantity: e.target.value })}
                      required
                      disabled={saving}
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Rate</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.unit_price}
                      onChange={(e) => updateLine(line.id, { unit_price: e.target.value })}
                      required
                      disabled={saving}
                      className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Amount</label>
                    <div className="w-full rounded-lg border border-border bg-surface-muted/60 px-3 py-2 text-sm text-white">
                      {formatCurrency(total)}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="rounded-lg border border-border bg-surface-elevated p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-400 space-y-1">
            <div>Preview total: <span className="text-white font-medium tabular-nums">{formatCurrency(previewTotal)}</span></div>
            {amountPaid > 0 && (
              <div>
                Already paid: <span className="text-green-400 tabular-nums">{formatCurrency(amountPaid)}</span>
                {' '}· edited total must stay above this amount
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50"
              data-testid="edit-bill-save"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <Link
              to={`/bills/${bill.id}`}
              className="px-4 py-2 rounded-lg border border-border text-sm text-gray-300 hover:text-white"
            >
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </div>
  )
}
