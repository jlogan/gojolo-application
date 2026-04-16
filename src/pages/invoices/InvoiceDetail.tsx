import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { downloadInvoicePdf } from '@/lib/invoicePdf'
import {
  ArrowLeft, Pencil, Download, CreditCard, Send, XCircle,
  Plus, ChevronUp, FileText, DollarSign, Calendar,
  Building2, User, Hash,
} from 'lucide-react'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Invoice = {
  id: string
  org_id: string
  direction: 'outbound' | 'inbound'
  number: number | null
  prefix: string | null
  status: string
  company_id: string | null
  contact_id: string | null
  vendor_user_id: string | null
  project_id: string | null
  issue_date: string
  due_date: string | null
  paid_date: string | null
  subtotal: number
  tax_total: number
  discount_type: string | null
  discount_value: number
  discount_total: number
  adjustment: number
  total: number
  amount_paid: number
  amount_due: number
  notes: string | null
  terms: string | null
  hash: string | null
  created_by: string | null
  created_at: string
}

type InvoiceItem = {
  id: string
  invoice_id: string
  description: string
  long_description: string | null
  quantity: number
  unit_price: number
  unit: string | null
  tax_rate_id: string | null
  tax_amount: number
  subtotal: number
  total: number
  sort_order: number
}

type InvoicePayment = {
  id: string
  invoice_id: string
  amount: number
  payment_method: string | null
  transaction_id: string | null
  payment_date: string
  note: string | null
  recorded_by: string | null
  created_at: string
}

type CompanyInfo = { id: string; name: string }
type ContactInfo = { id: string; name: string; email: string | null }
type ProjectInfo = { id: string; name: string }

/* ------------------------------------------------------------------ */
/*  Status badge                                                       */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-300',
  sent: 'bg-blue-500/20 text-blue-300',
  unpaid: 'bg-yellow-500/20 text-yellow-300',
  partially_paid: 'bg-orange-500/20 text-orange-300',
  paid: 'bg-green-500/20 text-green-300',
  overdue: 'bg-red-500/20 text-red-300',
  cancelled: 'bg-slate-500/20 text-slate-400',
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STATUS_COLORS[status] ?? 'bg-gray-500/20 text-gray-300'
      }`}
    >
      {label}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value ?? 0)
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>()
  const { currentOrg, isVendor } = useOrg()
  const { user } = useAuth()

  const printRef = useRef<HTMLDivElement>(null)

  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [items, setItems] = useState<InvoiceItem[]>([])
  const [payments, setPayments] = useState<InvoicePayment[]>([])
  const [company, setCompany] = useState<CompanyInfo | null>(null)
  const [contact, setContact] = useState<ContactInfo | null>(null)
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [loading, setLoading] = useState(true)

  // Payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('bank_transfer')
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [payTransactionId, setPayTransactionId] = useState('')
  const [payNote, setPayNote] = useState('')
  const [paySaving, setPaySaving] = useState(false)

  // Action states
  const [actionLoading, setActionLoading] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)

  /* ---------- Fetch ---------- */

  const fetchInvoice = useCallback(async () => {
    if (!id || !currentOrg?.id) return
    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .eq('org_id', currentOrg.id)
      .single()
    if (error || !data) {
      setLoading(false)
      return
    }
    setInvoice(data as Invoice)
    setLoading(false)
  }, [id, currentOrg?.id])

  const fetchItems = useCallback(async () => {
    if (!id) return
    const { data } = await supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', id)
      .order('sort_order', { ascending: true })
    setItems((data as InvoiceItem[]) ?? [])
  }, [id])

  const fetchPayments = useCallback(async () => {
    if (!id) return
    const { data } = await supabase
      .from('invoice_payments')
      .select('*')
      .eq('invoice_id', id)
      .order('payment_date', { ascending: false })
    setPayments((data as InvoicePayment[]) ?? [])
  }, [id])

  const fetchRelated = useCallback(async (inv: Invoice) => {
    if (inv.company_id) {
      const { data } = await supabase
        .from('companies')
        .select('id, name')
        .eq('id', inv.company_id)
        .single()
      setCompany(data as CompanyInfo | null)
    }
    if (inv.contact_id) {
      const { data } = await supabase
        .from('contacts')
        .select('id, name, email')
        .eq('id', inv.contact_id)
        .single()
      setContact(data as ContactInfo | null)
    }
    if (inv.project_id) {
      const { data } = await supabase
        .from('projects')
        .select('id, name')
        .eq('id', inv.project_id)
        .single()
      setProject(data as ProjectInfo | null)
    }
  }, [])

  useEffect(() => {
    fetchInvoice()
    fetchItems()
    fetchPayments()
  }, [fetchInvoice, fetchItems, fetchPayments])

  useEffect(() => {
    if (invoice) fetchRelated(invoice)
  }, [invoice, fetchRelated])

  /* ---------- Record payment ---------- */

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !user?.id || paySaving) return

    const amount = parseFloat(payAmount)
    if (isNaN(amount) || amount <= 0) return

    setPaySaving(true)
    const { error } = await supabase.from('invoice_payments').insert({
      invoice_id: id,
      amount,
      payment_method: payMethod || null,
      transaction_id: payTransactionId || null,
      payment_date: payDate,
      note: payNote || null,
      recorded_by: user.id,
    })

    if (!error) {
      setShowPaymentForm(false)
      setPayAmount('')
      setPayMethod('bank_transfer')
      setPayDate(new Date().toISOString().slice(0, 10))
      setPayTransactionId('')
      setPayNote('')
      // Refresh invoice (totals updated by trigger) and payments
      await Promise.all([fetchInvoice(), fetchPayments()])
    }
    setPaySaving(false)
  }

  /* ---------- Status actions ---------- */

  const updateStatus = async (newStatus: string) => {
    if (!id || actionLoading) return
    setActionLoading(true)
    const { error } = await supabase
      .from('invoices')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (!error) await fetchInvoice()
    setActionLoading(false)
  }

  /* ---------- Delete invoice ---------- */

  const handleDelete = async () => {
    if (!id || actionLoading) return
    if (!confirm(`Delete ${directionLabel} ${invoiceNumber}? This cannot be undone.`)) return
    setActionLoading(true)
    const { error } = await supabase
      .from('invoices')
      .delete()
      .eq('id', id)
    if (!error) {
      // Redirect to invoices list
      window.location.href = '/invoices'
    } else {
      console.error('Delete failed:', error)
      setActionLoading(false)
    }
  }

  /* ---------- PDF download ---------- */

  const handleDownloadPdf = async () => {
    if (!printRef.current || !invoice || pdfLoading) return
    setPdfLoading(true)
    try {
      const invoiceNum = `${invoice.prefix ?? 'INV-'}${String(invoice.number ?? '').padStart(4, '0')}`
      await downloadInvoicePdf(printRef.current, `${invoiceNum}.pdf`)
    } catch (err) {
      console.error('PDF generation failed:', err)
    }
    setPdfLoading(false)
  }

  /* ---------- Render ---------- */

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-white/10" />
          <div className="h-64 rounded bg-white/5" />
        </div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="p-6">
        <Link to="/invoices" className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1 mb-4">
          <ArrowLeft size={16} /> Back to Invoices
        </Link>
        <p className="text-gray-400">Invoice not found.</p>
      </div>
    )
  }

  const invoiceNumber = `${invoice.prefix ?? 'INV-'}${String(invoice.number ?? '').padStart(4, '0')}`
  const directionLabel = invoice.direction === 'outbound' ? 'Invoice' : 'Bill'
  const canEdit = !isVendor && ['draft'].includes(invoice.status)
  const canMarkSent = !isVendor && ['draft'].includes(invoice.status)
  const canMarkCancelled = !isVendor && !['paid', 'cancelled'].includes(invoice.status)
  const canDelete = !isVendor && ['draft'].includes(invoice.status)
  const showStripeButton = isVendor && invoice.direction === 'inbound' && !['paid', 'cancelled'].includes(invoice.status)
  const canRecordPayment = !isVendor && !['paid', 'cancelled'].includes(invoice.status)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back link */}
      <Link
        to="/invoices"
        className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft size={16} /> Back to Invoices
      </Link>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <h1 className="text-2xl font-semibold text-white mr-auto flex items-center gap-3">
          <FileText size={24} className="text-gray-400" />
          {invoiceNumber}
          <InvoiceStatusBadge status={invoice.status} />
          <span className="text-sm font-normal text-gray-500">{directionLabel}</span>
        </h1>

        {/* PDF */}
        <button
          onClick={handleDownloadPdf}
          disabled={pdfLoading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-50"
        >
          <Download size={14} />
          {pdfLoading ? 'Generating…' : 'PDF'}
        </button>

        {/* Edit */}
        {canEdit && (
          <Link
            to={`/invoices/${invoice.id}/edit`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10"
          >
            <Pencil size={14} /> Edit
          </Link>
        )}

        {/* Mark as Sent */}
        {canMarkSent && (
          <button
            onClick={() => updateStatus('sent')}
            disabled={actionLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Send size={14} /> Mark as Sent
          </button>
        )}

        {/* Mark as Cancelled */}
        {canMarkCancelled && (
          <button
            onClick={() => updateStatus('cancelled')}
            disabled={actionLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            <XCircle size={14} /> Cancel
          </button>
        )}

        {/* Delete (draft only) */}
        {canDelete && (
          <button
            onClick={handleDelete}
            disabled={actionLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-600/50 bg-red-600/10 px-3 py-1.5 text-sm text-red-400 hover:bg-red-600/20 disabled:opacity-50"
          >
            <XCircle size={14} /> Delete
          </button>
        )}

        {/* Pay with Stripe (vendor placeholder) */}
        {showStripeButton && (
          <button
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
            onClick={() => alert('Stripe payment coming soon')}
          >
            <CreditCard size={14} /> Pay with Stripe
          </button>
        )}
      </div>

      {/* ============= Printable invoice area ============= */}
      <div ref={printRef} className="space-y-6">
        {/* Header card */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Company / Contact */}
            <div>
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">
                {invoice.direction === 'outbound' ? 'Bill To' : 'From'}
              </h3>
              {company && (
                <div className="flex items-center gap-2 text-white">
                  <Building2 size={14} className="text-gray-400" />
                  <Link to={`/companies/${company.id}`} className="hover:underline">
                    {company.name}
                  </Link>
                </div>
              )}
              {contact && (
                <div className="flex items-center gap-2 text-gray-300 mt-1">
                  <User size={14} className="text-gray-400" />
                  <span>{contact.name}</span>
                  {contact.email && (
                    <span className="text-gray-500 text-sm">({contact.email})</span>
                  )}
                </div>
              )}
              {!company && !contact && (
                <span className="text-gray-500 text-sm">No company/contact set</span>
              )}
            </div>

            {/* Project */}
            <div>
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Project</h3>
              {project ? (
                <Link
                  to={`/projects/${project.id}`}
                  className="text-white hover:underline inline-flex items-center gap-1.5"
                >
                  <Hash size={14} className="text-gray-400" />
                  {project.name}
                </Link>
              ) : (
                <span className="text-gray-500 text-sm">No project linked</span>
              )}
            </div>

            {/* Dates */}
            <div className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Dates</h3>
              <div className="flex items-center gap-2 text-sm">
                <Calendar size={14} className="text-gray-400" />
                <span className="text-gray-400 w-20">Issued:</span>
                <span className="text-white">{fmtDate(invoice.issue_date)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Calendar size={14} className="text-gray-400" />
                <span className="text-gray-400 w-20">Due:</span>
                <span className="text-white">{fmtDate(invoice.due_date)}</span>
              </div>
              {invoice.paid_date && (
                <div className="flex items-center gap-2 text-sm">
                  <Calendar size={14} className="text-green-400" />
                  <span className="text-gray-400 w-20">Paid:</span>
                  <span className="text-green-400">{fmtDate(invoice.paid_date)}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Line items table */}
        <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase text-gray-500">
                <th className="px-4 py-3 w-[40%]">Description</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Unit Price</th>
                <th className="px-4 py-3 text-right">Tax</th>
                <th className="px-4 py-3 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    No line items
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="text-white">{item.description}</div>
                      {item.long_description && (
                        <div className="text-xs text-gray-500 mt-0.5">{item.long_description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-300">
                      {item.quantity}
                      {item.unit && <span className="text-gray-500 ml-1">{item.unit}</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-300">{fmtCurrency(item.unit_price)}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{fmtCurrency(item.tax_amount)}</td>
                    <td className="px-4 py-3 text-right text-white font-medium">{fmtCurrency(item.subtotal)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-6">
          <div className="max-w-xs ml-auto space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Subtotal</span>
              <span className="text-white">{fmtCurrency(invoice.subtotal)}</span>
            </div>
            {invoice.tax_total !== 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">Tax</span>
                <span className="text-white">{fmtCurrency(invoice.tax_total)}</span>
              </div>
            )}
            {invoice.discount_total !== 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">
                  Discount
                  {invoice.discount_type === 'percent'
                    ? ` (${invoice.discount_value}%)`
                    : ''}
                </span>
                <span className="text-red-400">-{fmtCurrency(invoice.discount_total)}</span>
              </div>
            )}
            {invoice.adjustment !== 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">Adjustment</span>
                <span className="text-white">{fmtCurrency(invoice.adjustment)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-white/10 pt-2 text-base font-semibold">
              <span className="text-gray-300">Total</span>
              <span className="text-white">{fmtCurrency(invoice.total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Amount Paid</span>
              <span className="text-green-400">{fmtCurrency(invoice.amount_paid)}</span>
            </div>
            <div className="flex justify-between border-t border-white/10 pt-2 text-base font-semibold">
              <span className="text-gray-300">Amount Due</span>
              <span className={invoice.amount_due > 0 ? 'text-yellow-400' : 'text-green-400'}>
                {fmtCurrency(invoice.amount_due)}
              </span>
            </div>
          </div>
        </div>

        {/* Notes & Terms */}
        {(invoice.notes || invoice.terms) && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
            {invoice.notes && (
              <div>
                <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Notes</h3>
                <p className="text-gray-300 text-sm whitespace-pre-wrap">{invoice.notes}</p>
              </div>
            )}
            {invoice.terms && (
              <div>
                <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Terms</h3>
                <p className="text-gray-300 text-sm whitespace-pre-wrap">{invoice.terms}</p>
              </div>
            )}
          </div>
        )}
      </div>
      {/* ============= End printable area ============= */}

      {/* Payment history */}
      <div className="mt-6 rounded-xl border border-white/10 bg-white/5 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-sm font-medium text-white flex items-center gap-2">
            <DollarSign size={16} className="text-gray-400" />
            Payment History
          </h2>
          {canRecordPayment && (
            <button
              onClick={() => setShowPaymentForm(!showPaymentForm)}
              className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-2.5 py-1 text-xs text-white hover:bg-green-700"
            >
              {showPaymentForm ? <ChevronUp size={12} /> : <Plus size={12} />}
              {showPaymentForm ? 'Hide' : 'Record Payment'}
            </button>
          )}
        </div>

        {/* Record payment form */}
        {showPaymentForm && canRecordPayment && (
          <form
            onSubmit={handleRecordPayment}
            className="border-b border-white/10 bg-white/[0.02] p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3"
          >
            <div>
              <label className="block text-xs text-gray-500 mb-1">Amount *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                placeholder={String(invoice.amount_due > 0 ? invoice.amount_due : 0)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Method</label>
              <select
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="credit_card">Credit Card</option>
                <option value="stripe">Stripe</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Date</label>
              <input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Transaction ID</label>
              <input
                type="text"
                value={payTransactionId}
                onChange={(e) => setPayTransactionId(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-1">
              <label className="block text-xs text-gray-500 mb-1">Note</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="Optional"
                  className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  disabled={paySaving}
                  className="rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {paySaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Payments table */}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase text-gray-500">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Transaction ID</th>
              <th className="px-4 py-3">Note</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  No payments recorded
                </td>
              </tr>
            ) : (
              payments.map((p) => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                  <td className="px-4 py-3 text-gray-300">{fmtDate(p.payment_date)}</td>
                  <td className="px-4 py-3 text-right text-green-400 font-medium">
                    {fmtCurrency(p.amount)}
                  </td>
                  <td className="px-4 py-3 text-gray-400 capitalize">
                    {p.payment_method?.replace(/_/g, ' ') ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                    {p.transaction_id || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{p.note || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
