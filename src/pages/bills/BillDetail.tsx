import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import RecordBillPaymentModal, { type BillPaymentFormValues } from '@/components/bills/RecordBillPaymentModal'
import DeleteBillPaymentConfirmModal from '@/components/bills/DeleteBillPaymentConfirmModal'
import CancelBillConfirmModal from '@/components/bills/CancelBillConfirmModal'
import { billPaymentMethodLabel } from '@/lib/billPaymentMethods'
import { billStatusLabel, canCancelBill, canRecordBillPayment } from '@/lib/billStatus'
import { supabase } from '@/lib/supabase'

type Bill = {
  id: string
  number: number | null
  prefix: string | null
  status: string
  issue_date: string | null
  paid_date: string | null
  subtotal: number | null
  tax_total: number | null
  adjustment: number | null
  total: number | null
  amount_due: number | null
  amount_paid: number | null
  notes: string | null
  vendor_user_id: string | null
  billing_period_start: string | null
  billing_period_end: string | null
  billing_source: string | null
  projects: { name: string } | { name: string }[] | null
}

type Item = { id: string; description: string; long_description: string | null; quantity: number; unit_price: number; unit: string | null; total: number; sort_order: number }
type Profile = { id: string; display_name: string | null; email: string | null }
type BillPayment = {
  id: string
  amount: number
  payment_method: string | null
  payment_date: string
  transaction_id: string | null
}

function formatCurrency(amount: number | null | undefined) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(amount ?? 0))
}
function formatDate(date: string | null | undefined) {
  if (!date) return '-'
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function billNumber(bill: Bill) {
  const prefix = (bill.prefix ?? 'BILL-').replace(/-+$/, '')
  return bill.number ? `${prefix}-${String(bill.number).padStart(4, '0')}` : 'Bill'
}
function projectName(projects: Bill['projects']) {
  if (!projects) return '-'
  return Array.isArray(projects) ? projects[0]?.name ?? '-' : projects.name
}

export default function BillDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { currentOrg, isVendor, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [bill, setBill] = useState<Bill | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [vendor, setVendor] = useState<Profile | null>(null)
  const [payments, setPayments] = useState<BillPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [savingStatus, setSavingStatus] = useState<string | null>(null)
  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const [editPayment, setEditPayment] = useState<BillPaymentFormValues | null>(null)
  const [deletePayment, setDeletePayment] = useState<BillPayment | null>(null)
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadBill = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!id || !currentOrg?.id || !user?.id) return
    setLoading(true)
    let query = supabase
      .from('invoices')
      .select('id, number, prefix, status, issue_date, paid_date, subtotal, tax_total, adjustment, total, amount_due, amount_paid, notes, vendor_user_id, billing_period_start, billing_period_end, billing_source, projects(name)')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .eq('direction', 'inbound')
    if (isVendor) query = query.eq('vendor_user_id', user.id)
    const { data, error } = await query.maybeSingle()
    if (signal?.cancelled) return
    if (error || !data) {
      setBill(null)
      setItems([])
      setPayments([])
      setLoading(false)
      return
    }
    const loadedBill = data as unknown as Bill
    setBill(loadedBill)
    const [{ data: itemRows }, { data: vendorRows }, { data: paymentRows }] = await Promise.all([
      supabase.from('invoice_items').select('id, description, long_description, quantity, unit_price, unit, total, sort_order').eq('invoice_id', loadedBill.id).order('sort_order'),
      loadedBill.vendor_user_id ? supabase.from('profiles').select('id, display_name, email').eq('id', loadedBill.vendor_user_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from('invoice_payments').select('id, amount, payment_method, payment_date, transaction_id').eq('invoice_id', loadedBill.id).order('payment_date', { ascending: false }),
    ])
    if (!signal?.cancelled) {
      setItems((itemRows ?? []) as Item[])
      setVendor((vendorRows ?? null) as Profile | null)
      setPayments((paymentRows ?? []) as BillPayment[])
      setLoading(false)
    }
  }, [id, currentOrg?.id, user?.id, isVendor])

  useEffect(() => {
    const signal = { cancelled: false }
    loadBill(signal)
    return () => { signal.cancelled = true }
  }, [loadBill])

  const updateStatus = async (status: string) => {
    if (!bill || !isOrgAdmin || isVendor || !currentOrg?.id) return
    setSavingStatus(status)
    setStatusMessage(null)
    const patch: Record<string, string | null> = { status }
    const { error } = await supabase
      .from('invoices')
      .update(patch)
      .eq('id', bill.id)
      .eq('org_id', currentOrg.id)
      .eq('direction', 'inbound')
    if (error) {
      setStatusMessage({ type: 'error', text: error.message || 'Failed to update bill status.' })
    } else {
      setBill({ ...bill, status })
    }
    setSavingStatus(null)
  }

  const canAdminBillActions = isOrgAdmin && !isVendor
  const canRecordPayment = canAdminBillActions && bill != null && canRecordBillPayment(bill.status)

  if (loading) return <div className="p-6 text-gray-400">Loading bill...</div>
  if (!bill) {
    return <div className="p-6"><p className="text-gray-300">Bill not found.</p><button onClick={() => navigate('/bills')} className="mt-3 text-accent">Back to bills</button></div>
  }

  const defaultPaymentAmount = bill.amount_due != null && bill.amount_due > 0 ? bill.amount_due : Number(bill.total ?? 0)
  const displayAmountDue = bill.status === 'paid' ? 0 : Number(bill.amount_due ?? bill.total ?? 0)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <Link to="/bills" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-4"><ArrowLeft className="w-4 h-4" /> Back to bills</Link>
      <div className="rounded-lg border border-border bg-surface-elevated p-5 mb-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">{billNumber(bill)}</h1>
            <p className="text-sm text-gray-400 mt-1">{vendor?.display_name || vendor?.email || 'Vendor'} / {projectName(bill.projects)}</p>
            <p className="text-sm text-gray-500 mt-1">Period: {formatDate(bill.billing_period_start)} - {formatDate(bill.billing_period_end)}</p>
            {bill.paid_date && bill.status === 'paid' && (
              <p className="text-sm text-green-400 mt-1">Paid on {formatDate(bill.paid_date)}</p>
            )}
          </div>
          <div className="text-left md:text-right md:min-w-[220px]">
            <div className="text-sm text-gray-400 mb-3">{billStatusLabel(bill.status)}</div>
            <div className="rounded-lg border border-border bg-surface-muted/40 p-3 space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Total</span>
                <span className="text-white font-medium tabular-nums">{formatCurrency(bill.total)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Paid</span>
                <span className={`tabular-nums ${(bill.amount_paid ?? 0) > 0 ? 'text-green-400' : 'text-gray-300'}`}>
                  {formatCurrency(bill.amount_paid)}
                </span>
              </div>
              <div className="flex justify-between gap-4 border-t border-border pt-2">
                <span className="text-gray-300 font-medium">Amount Due</span>
                <span
                  className={`text-base font-semibold tabular-nums ${
                    bill.status === 'cancelled'
                      ? 'text-gray-400'
                      : displayAmountDue > 0
                        ? 'text-amber-400'
                        : 'text-green-400'
                  }`}
                >
                  {formatCurrency(displayAmountDue)}
                </span>
              </div>
            </div>
          </div>
        </div>
        {canAdminBillActions && (
          <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-border">
            {bill.status === 'draft' && (
              <button
                disabled={savingStatus === 'approved'}
                onClick={() => updateStatus('approved')}
                className="px-3 py-2 rounded-lg bg-accent text-white text-sm disabled:opacity-50"
              >
                Move to Open
              </button>
            )}
            {canRecordPayment && (
              <button
                type="button"
                onClick={() => {
                  setEditPayment(null)
                  setPaymentModalOpen(true)
                }}
                className="px-3 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700"
                data-testid="bill-record-payment"
              >
                Record Payment
              </button>
            )}
            {canCancelBill(bill.status) && (
              <button
                type="button"
                onClick={() => {
                  setStatusMessage(null)
                  setCancelModalOpen(true)
                }}
                className="px-3 py-2 rounded-lg border border-red-500/40 text-red-300 text-sm font-medium hover:bg-red-500/10"
                data-testid="bill-cancel"
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {statusMessage && (
          <p className={`mt-3 text-sm ${statusMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
            {statusMessage.text}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-surface-elevated overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted/70 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Description</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Rate</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="px-4 py-3 text-gray-200">
                  <div>{item.description}</div>
                  {item.long_description && <pre className="mt-1 whitespace-pre-wrap text-xs text-gray-500 font-sans">{item.long_description}</pre>}
                </td>
                <td className="px-4 py-3 text-right text-gray-300">{item.quantity} {item.unit ?? ''}</td>
                <td className="px-4 py-3 text-right text-gray-300">{formatCurrency(item.unit_price)}</td>
                <td className="px-4 py-3 text-right text-white">{formatCurrency(item.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-border p-4 space-y-1 text-sm max-w-sm ml-auto">
          <div className="flex justify-between text-gray-400"><span>Subtotal</span><span>{formatCurrency(bill.subtotal)}</span></div>
          <div className="flex justify-between text-gray-400"><span>Adjustments</span><span>{formatCurrency(bill.adjustment)}</span></div>
          <div className="flex justify-between text-white font-semibold text-base pt-2"><span>Total</span><span>{formatCurrency(bill.total)}</span></div>
        </div>
      </div>

      {bill.notes?.trim() && (
        <div className="rounded-lg border border-border bg-surface-elevated p-4 mb-4">
          <h2 className="text-sm font-medium text-white mb-2">Notes</h2>
          <p className="text-gray-300 text-sm whitespace-pre-wrap">{bill.notes}</p>
        </div>
      )}

      {payments.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-elevated overflow-hidden">
          <h2 className="px-4 py-3 text-sm font-medium text-white border-b border-border">Payment history</h2>
          <table className="w-full text-sm">
            <thead className="bg-surface-muted/70 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-left">Method</th>
                <th className="px-4 py-3 text-left">Reference</th>
                {canAdminBillActions && <th className="px-4 py-3 text-right w-24">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 text-gray-300">{formatDate(p.payment_date)}</td>
                  <td className="px-4 py-3 text-right text-green-400">{formatCurrency(p.amount)}</td>
                  <td className="px-4 py-3 text-gray-300">{billPaymentMethodLabel(p.payment_method)}</td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.transaction_id || '—'}</td>
                  {canAdminBillActions && (
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditPayment({
                              id: p.id,
                              amount: p.amount,
                              payment_method: p.payment_method,
                              payment_date: p.payment_date,
                              transaction_id: p.transaction_id,
                            })
                            setPaymentModalOpen(true)
                          }}
                          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-surface-muted"
                          aria-label="Edit payment"
                          data-testid={`bill-payment-edit-${p.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletePayment(p)}
                          className="p-1.5 rounded text-gray-400 hover:text-red-300 hover:bg-red-500/10"
                          aria-label="Delete payment"
                          data-testid={`bill-payment-delete-${p.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RecordBillPaymentModal
        open={paymentModalOpen}
        billId={bill.id}
        billLabel={billNumber(bill)}
        defaultAmount={defaultPaymentAmount}
        editPayment={editPayment}
        onClose={() => {
          setPaymentModalOpen(false)
          setEditPayment(null)
        }}
        onSuccess={() => {
          setStatusMessage(
            editPayment
              ? { type: 'success', text: 'Payment updated.' }
              : { type: 'success', text: 'Payment recorded.' },
          )
          loadBill()
        }}
      />

      <DeleteBillPaymentConfirmModal
        open={deletePayment != null}
        billId={bill.id}
        billLabel={billNumber(bill)}
        paymentId={deletePayment?.id ?? null}
        paymentLabel={
          deletePayment
            ? `${formatCurrency(deletePayment.amount)} on ${formatDate(deletePayment.payment_date)}`
            : ''
        }
        onClose={() => setDeletePayment(null)}
        onSuccess={() => {
          setStatusMessage({ type: 'success', text: 'Payment deleted.' })
          loadBill()
        }}
      />

      {currentOrg?.id && (
        <CancelBillConfirmModal
          open={cancelModalOpen}
          billId={bill.id}
          billLabel={billNumber(bill)}
          orgId={currentOrg.id}
          onClose={() => setCancelModalOpen(false)}
          onSuccess={() => {
            setCancelModalOpen(false)
            setStatusMessage({ type: 'success', text: 'Bill cancelled.' })
            loadBill()
          }}
        />
      )}
    </div>
  )
}
