/**
 * LinkedInvoices — reusable section that shows invoices (+ payments) linked
 * to a Contact, Company, or Project.
 *
 * Usage:
 *   <LinkedInvoices contactId={id} />
 *   <LinkedInvoices companyId={id} />
 *   <LinkedInvoices projectId={id} />
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { FileText, ChevronDown, ChevronUp, DollarSign } from 'lucide-react'

interface Invoice {
  id: string
  number: number | null
  prefix: string | null
  status: string
  issue_date: string
  due_date: string | null
  total: number
  amount_due: number
  amount_paid: number
  payments: Payment[]
}

interface Payment {
  id: string
  amount: number
  payment_method: string | null
  payment_date: string
  transaction_id: string | null
  note: string | null
}

interface Props {
  contactId?: string
  companyId?: string
  projectId?: string
  orgId?: string
}

const STATUS_STYLES: Record<string, string> = {
  paid:      'bg-green-500/10 text-green-400 border-green-500/20',
  unpaid:    'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  draft:     'bg-gray-500/10 text-gray-400 border-gray-500/20',
  cancelled: 'bg-red-500/10 text-red-400 border-red-500/20',
  overdue:   'bg-red-500/10 text-red-400 border-red-500/20',
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n ?? 0)
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function invoiceLabel(inv: Invoice) {
  return `${(inv.prefix ?? 'INV-').replace(/-+$/, '')}-${String(inv.number ?? '').padStart(4, '0')}`
}

export default function LinkedInvoices({ contactId, companyId, projectId }: Props) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (!contactId && !companyId && !projectId) {
      setLoading(false)
      return
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, companyId, projectId])

  async function load() {
    setLoading(true)
    try {
      let query = supabase
        .from('invoices')
        .select(`
          id, number, prefix, status,
          issue_date, due_date,
          total, amount_due, amount_paid,
          invoice_payments (
            id, amount, payment_method,
            payment_date, transaction_id, note
          )
        `)
        .order('issue_date', { ascending: false })

      if (contactId) {
        // invoices linked via contact_id OR invoice_contacts junction
        const { data: junctionIds } = await supabase
          .from('invoice_contacts')
          .select('invoice_id')
          .eq('contact_id', contactId)
        const ids = (junctionIds ?? []).map((r: { invoice_id: string }) => r.invoice_id)
        // combine contact_id direct link + junction table
        query = supabase
          .from('invoices')
          .select(`
            id, number, prefix, status,
            issue_date, due_date,
            total, amount_due, amount_paid,
            invoice_payments (
              id, amount, payment_method,
              payment_date, transaction_id, note
            )
          `)
          .or(`contact_id.eq.${contactId}${ids.length ? `,id.in.(${ids.join(',')})` : ''}`)
          .order('issue_date', { ascending: false })
      } else if (companyId) {
        query = query.eq('company_id', companyId)
      } else if (projectId) {
        query = query.eq('project_id', projectId)
      }

      const { data, error } = await query
      if (error) throw error

      setInvoices(
        (data ?? []).map((inv: Record<string, unknown>) => ({
          ...(inv as Omit<Invoice, 'payments'>),
          payments: (inv.invoice_payments as Payment[]) ?? [],
        }))
      )
    } catch (err) {
      console.error('LinkedInvoices load error:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <h3 className="text-xs font-semibold uppercase text-gray-500 mb-3 flex items-center gap-2">
          <FileText size={13} /> Invoices
        </h3>
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <h3 className="text-xs font-semibold uppercase text-gray-500 mb-3 flex items-center gap-2">
        <FileText size={13} /> Invoices
        {invoices.length > 0 && (
          <span className="ml-auto text-gray-600 font-normal normal-case">{invoices.length}</span>
        )}
      </h3>

      {invoices.length === 0 ? (
        <p className="text-sm text-gray-500">No invoices yet.</p>
      ) : (
        <div className="space-y-2">
          {invoices.map((inv) => (
            <div key={inv.id} className="rounded-lg border border-white/5 bg-white/5 overflow-hidden">
              {/* Invoice row */}
              <div className="flex items-center gap-3 px-3 py-2.5">
                <Link
                  to={`/invoices/${inv.id}`}
                  className="text-sm font-medium text-blue-400 hover:text-blue-300 shrink-0"
                >
                  {invoiceLabel(inv)}
                </Link>
                <span
                  className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${STATUS_STYLES[inv.status] ?? STATUS_STYLES['draft']}`}
                >
                  {inv.status}
                </span>
                <span className="text-sm text-gray-300 ml-auto">{fmt(inv.total)}</span>
                {inv.payments.length > 0 && (
                  <button
                    onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                    className="text-gray-500 hover:text-gray-300 ml-1"
                    title="Toggle payments"
                  >
                    {expandedId === inv.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                )}
              </div>

              {/* Dates sub-row */}
              <div className="px-3 pb-2 flex gap-4 text-xs text-gray-500">
                <span>Issued {fmtDate(inv.issue_date)}</span>
                {inv.due_date && <span>Due {fmtDate(inv.due_date)}</span>}
                {inv.amount_paid > 0 && (
                  <span className="text-green-500 ml-auto">Paid {fmt(inv.amount_paid)}</span>
                )}
                {inv.amount_due > 0 && inv.status !== 'paid' && (
                  <span className="text-yellow-500 ml-auto">Due {fmt(inv.amount_due)}</span>
                )}
              </div>

              {/* Payments expanded */}
              {expandedId === inv.id && inv.payments.length > 0 && (
                <div className="border-t border-white/5 px-3 py-2 space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase text-gray-600 flex items-center gap-1.5">
                    <DollarSign size={10} /> Payments
                  </p>
                  {inv.payments.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="text-green-400 font-medium">{fmt(p.amount)}</span>
                      <span>{fmtDate(p.payment_date)}</span>
                      {p.payment_method && (
                        <span className="capitalize text-gray-500">{p.payment_method}</span>
                      )}
                      {p.transaction_id && (
                        <span className="text-gray-600 truncate max-w-[120px]">#{p.transaction_id}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
