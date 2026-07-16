import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, Plus, Search, Settings } from 'lucide-react'
import RecordBillPaymentModal from '@/components/bills/RecordBillPaymentModal'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { BILL_OPEN_STATUSES, BILL_STATUS_CLASSES, billStatusLabel, canRecordBillPayment } from '@/lib/billStatus'

type BillRow = {
  id: string
  number: number | null
  prefix: string | null
  status: string
  issue_date: string | null
  paid_date: string | null
  total: number | null
  amount_due: number | null
  billing_period_start: string | null
  billing_period_end: string | null
  billing_source: string | null
  created_at: string
  vendor_user_id: string | null
  projects: { name: string } | { name: string }[] | null
}

type ProfileRow = { id: string; display_name: string | null; email: string | null }
type StatusFilter = 'all' | 'draft' | 'approved' | 'paid' | 'cancelled'

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'approved', label: 'Open' },
  { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' },
]

function formatCurrency(amount: number | null | undefined) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(amount ?? 0))
}

function formatDate(date: string | null | undefined) {
  if (!date) return '-'
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function billNumber(bill: BillRow) {
  const prefix = (bill.prefix ?? 'BILL-').replace(/-+$/, '')
  return bill.number ? `${prefix}-${String(bill.number).padStart(4, '0')}` : '-'
}

function projectName(projects: BillRow['projects']) {
  if (!projects) return '-'
  return Array.isArray(projects) ? projects[0]?.name ?? '-' : projects.name
}

export default function BillsList() {
  const { currentOrg, isVendor, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [bills, setBills] = useState<BillRow[]>([])
  const [profiles, setProfiles] = useState<Record<string, ProfileRow>>({})
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [bulkMessage, setBulkMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [paymentBill, setPaymentBill] = useState<BillRow | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const canBulkEdit = isOrgAdmin && !isVendor
  const canRecordPayment = isOrgAdmin && !isVendor

  const loadBills = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!currentOrg?.id || !user?.id) return
    setLoading(true)

    let query = supabase
      .from('invoices')
      .select('id, number, prefix, status, issue_date, paid_date, total, amount_due, billing_period_start, billing_period_end, billing_source, created_at, vendor_user_id, projects(name)')
      .eq('org_id', currentOrg.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })

    if (isVendor) query = query.eq('vendor_user_id', user.id)
    if (status === 'approved') query = query.in('status', [...BILL_OPEN_STATUSES])
    else if (status !== 'all') query = query.eq('status', status)

    const { data, error } = await query
    if (signal?.cancelled) return
    if (error) {
      setBills([])
      setProfiles({})
      setLoading(false)
      return
    }

    const rows = (data ?? []) as unknown as BillRow[]
    setBills(rows)
    const vendorIds = [...new Set(rows.map((b) => b.vendor_user_id).filter(Boolean))] as string[]
    if (vendorIds.length) {
      const { data: profileRows } = await supabase.from('profiles').select('id, display_name, email').in('id', vendorIds)
      if (!signal?.cancelled) {
        setProfiles(Object.fromEntries(((profileRows ?? []) as ProfileRow[]).map((p) => [p.id, p])))
      }
    } else {
      setProfiles({})
    }
    setLoading(false)
  }, [currentOrg?.id, user?.id, isVendor, status])

  useEffect(() => {
    const signal = { cancelled: false }
    loadBills(signal)
    return () => { signal.cancelled = true }
  }, [loadBills, refreshKey])

  useEffect(() => {
    setSelectedIds(new Set())
    setBulkMessage(null)
  }, [status, search])

  useEffect(() => {
    setSelectedIds((prev) => {
      const draftIds = new Set(bills.filter((b) => b.status === 'draft').map((b) => b.id))
      const next = new Set([...prev].filter((id) => draftIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [bills])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return bills
    return bills.filter((bill) => {
      const vendor = bill.vendor_user_id ? profiles[bill.vendor_user_id] : null
      return [billNumber(bill), projectName(bill.projects), vendor?.display_name, vendor?.email, bill.status, billStatusLabel(bill.status)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    })
  }, [bills, profiles, search])

  const draftVisible = useMemo(
    () => filtered.filter((bill) => bill.status === 'draft'),
    [filtered],
  )

  const selectedDraftCount = useMemo(
    () => draftVisible.filter((bill) => selectedIds.has(bill.id)).length,
    [draftVisible, selectedIds],
  )

  const allDraftVisibleSelected = draftVisible.length > 0 && selectedDraftCount === draftVisible.length
  const someDraftVisibleSelected = selectedDraftCount > 0 && !allDraftVisibleSelected

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someDraftVisibleSelected
    }
  }, [someDraftVisibleSelected])

  const toggleSelect = (id: string) => {
    setBulkMessage(null)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllVisible = () => {
    setBulkMessage(null)
    if (allDraftVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const bill of draftVisible) next.delete(bill.id)
        return next
      })
      return
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const bill of draftVisible) next.add(bill.id)
      return next
    })
  }

  const bulkApprove = async () => {
    if (!canBulkEdit || !currentOrg?.id || selectedIds.size === 0 || bulkUpdating) return
    const ids = [...selectedIds]
    setBulkUpdating(true)
    setBulkMessage(null)

    const { data, error } = await supabase
      .from('invoices')
      .update({ status: 'approved' })
      .in('id', ids)
      .eq('org_id', currentOrg.id)
      .eq('direction', 'inbound')
      .eq('status', 'draft')
      .select('id')

    setBulkUpdating(false)

    if (error) {
      setBulkMessage({ type: 'error', text: error.message || 'Failed to update bills.' })
      return
    }

    const updatedCount = data?.length ?? 0
    if (updatedCount === 0) {
      setBulkMessage({ type: 'error', text: 'No draft bills were updated. They may have already moved to another status.' })
      setSelectedIds(new Set())
      setRefreshKey((k) => k + 1)
      return
    }

    setBulkMessage({
      type: 'success',
      text: updatedCount === 1
        ? '1 bill moved to Open.'
        : `${updatedCount} bills moved to Open.`,
    })
    setSelectedIds(new Set())
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="p-4 md:p-6" data-testid="bills-page">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-white">Bills</h1>
          <p className="text-sm text-gray-400">Vendor bills generated every Monday at 6:00 AM Eastern for the previous Monday-Sunday week.</p>
        </div>
        {isOrgAdmin && (
          <div className="flex flex-wrap gap-2">
            <Link to="/bills/new" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90" data-testid="bill-create">
              <Plus className="w-4 h-4" /> Create bill
            </Link>
            <Link to="/admin/vendor-billing" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-gray-200 hover:bg-surface-muted">
              <Settings className="w-4 h-4" /> Vendor billing setup
            </Link>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 mb-4 border-b border-border pb-3">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatus(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              status === f.id
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search vendor, project, bill number..."
          className="w-full rounded-lg border border-border bg-surface-muted pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {canBulkEdit && selectedIds.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 mb-4 px-4 py-3 rounded-lg border border-accent/30 bg-accent/5"
          data-testid="bills-bulk-bar"
        >
          <span className="text-sm text-gray-200">
            {selectedIds.size} draft {selectedIds.size === 1 ? 'bill' : 'bills'} selected
          </span>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => { setSelectedIds(new Set()); setBulkMessage(null) }}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-gray-400 hover:text-white hover:bg-surface-muted"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={bulkApprove}
              disabled={bulkUpdating}
              className="px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50"
              data-testid="bills-bulk-approve"
            >
              {bulkUpdating ? 'Updating…' : 'Move to Open'}
            </button>
          </div>
        </div>
      )}

      {bulkMessage && (
        <p
          className={`mb-4 text-sm ${bulkMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}
          data-testid="bills-bulk-message"
        >
          {bulkMessage.text}
        </p>
      )}

      <div className="rounded-lg border border-border overflow-hidden bg-surface-elevated">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading bills...</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-gray-400">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-60" />
            <p className="text-white font-medium">No bills yet</p>
            <p className="text-sm mt-1">Bills will appear after the Monday morning vendor billing run.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted/70 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  {canBulkEdit && (
                    <th className="px-3 py-3 w-10">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allDraftVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        disabled={draftVisible.length === 0}
                        aria-label="Select all visible draft bills"
                        className="rounded border-gray-600 bg-surface-muted text-accent focus:ring-accent disabled:opacity-40"
                        data-testid="bills-select-all"
                      />
                    </th>
                  )}
                  <th className="px-4 py-3 text-left">Bill</th>
                  <th className="px-4 py-3 text-left">Vendor</th>
                  <th className="px-4 py-3 text-left">Project</th>
                  <th className="px-4 py-3 text-left">Period</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  {canRecordPayment && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((bill) => {
                  const vendor = bill.vendor_user_id ? profiles[bill.vendor_user_id] : null
                  const isDraft = bill.status === 'draft'
                  const isSelected = selectedIds.has(bill.id)
                  return (
                    <tr key={bill.id} className={`hover:bg-surface-muted/40 ${isSelected ? 'bg-accent/5' : ''}`}>
                      {canBulkEdit && (
                        <td className="px-3 py-3">
                          {isDraft ? (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelect(bill.id)}
                              aria-label={`Select ${billNumber(bill)}`}
                              className="rounded border-gray-600 bg-surface-muted text-accent focus:ring-accent"
                              data-testid={`bill-select-${bill.id}`}
                            />
                          ) : null}
                        </td>
                      )}
                      <td className="px-4 py-3"><Link to={`/bills/${bill.id}`} className="text-accent hover:underline font-medium">{billNumber(bill)}</Link></td>
                      <td className="px-4 py-3 text-gray-200">{vendor?.display_name || vendor?.email || 'Vendor'}</td>
                      <td className="px-4 py-3 text-gray-300">{projectName(bill.projects)}</td>
                      <td className="px-4 py-3 text-gray-400">{formatDate(bill.billing_period_start)} - {formatDate(bill.billing_period_end)}</td>
                      <td className="px-4 py-3"><span className={`inline-flex px-2 py-0.5 rounded-full border text-xs ${BILL_STATUS_CLASSES[bill.status] ?? BILL_STATUS_CLASSES.draft}`}>{billStatusLabel(bill.status)}</span></td>
                      <td className="px-4 py-3 text-right text-white font-medium">{formatCurrency(bill.total)}</td>
                      {canRecordPayment && (
                        <td className="px-4 py-3 text-right">
                          {canRecordBillPayment(bill.status) ? (
                            <button
                              type="button"
                              onClick={() => setPaymentBill(bill)}
                              className="text-xs text-green-400 hover:text-green-300"
                              data-testid={`bill-record-payment-${bill.id}`}
                            >
                              Record payment
                            </button>
                          ) : (
                            <span className="text-xs text-gray-600">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {paymentBill && (
        <RecordBillPaymentModal
          open
          billId={paymentBill.id}
          billLabel={billNumber(paymentBill)}
          defaultAmount={
            paymentBill.amount_due != null && paymentBill.amount_due > 0
              ? paymentBill.amount_due
              : Number(paymentBill.total ?? 0)
          }
          onClose={() => setPaymentBill(null)}
          onSuccess={() => {
            setPaymentBill(null)
            setRefreshKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}
