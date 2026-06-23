import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { CheckCheck, XCircle, AlertCircle } from 'lucide-react'

type PublicInvoiceData = {
  invoice: {
    id: string
    number: number | null
    prefix: string | null
    status: string
    issue_date: string
    due_date: string | null
    subtotal: number
    tax_total: number
    discount_total: number
    adjustment: number
    total: number
    amount_paid: number
    amount_due: number
    notes: string | null
    terms: string | null
    hash: string | null
  }
  org: { name: string }
  billTo: { company: string | null; contact: string | null; email: string | null }
  items: Array<{
    id: string
    description: string
    long_description: string | null
    quantity: number
    unit: string | null
    unit_price: number
    subtotal: number
    total: number
    sort_order: number
  }>
  paymentMethods?: { stripe?: boolean; paypal?: boolean }
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-300',
  sent: 'bg-blue-500/20 text-blue-300',
  viewed: 'bg-purple-500/20 text-purple-300',
  partial: 'bg-yellow-500/20 text-yellow-300',
  partially_paid: 'bg-yellow-500/20 text-yellow-300',
  paid: 'bg-green-500/20 text-green-300',
  overdue: 'bg-red-500/20 text-red-300',
  cancelled: 'bg-gray-600/20 text-gray-400',
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function PublicInvoice() {
  const { hash } = useParams<{ hash: string }>()
  const [searchParams] = useSearchParams()
  const paymentResult = searchParams.get('payment')
  const provider = searchParams.get('provider') || 'stripe'
  const stripeSessionId = searchParams.get('session_id')
  const paypalOrderId = searchParams.get('token')

  const [data, setData] = useState<PublicInvoiceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [payLoading, setPayLoading] = useState<'stripe' | 'paypal' | null>(null)
  const [confirming, setConfirming] = useState(false)

  const loadInvoice = useCallback(async () => {
    if (!hash) return null
    const { data: result, error: err } = await supabase.rpc('get_public_invoice', { p_hash: hash })
    if (err || !result || result.error) {
      setError('Invoice not found or no longer available.')
      return null
    }
    const payload = result as PublicInvoiceData
    setData(payload)
    setError(null)
    return payload
  }, [hash])

  useEffect(() => {
    if (!hash) return
    setLoading(true)
    loadInvoice().finally(() => setLoading(false))
  }, [hash, loadInvoice])

  useEffect(() => {
    if (!data?.invoice.id || paymentResult !== 'success') return

    let cancelled = false
    ;(async () => {
      setConfirming(true)
      try {
        if (provider === 'paypal' && paypalOrderId) {
          await supabase.functions.invoke('capture-paypal-payment', {
            body: { invoiceId: data.invoice.id, orderId: paypalOrderId },
          })
        } else if (stripeSessionId) {
          await supabase.functions.invoke('confirm-stripe-payment', {
            body: { invoiceId: data.invoice.id, sessionId: stripeSessionId },
          })
        }

        // Refetch/poll briefly so the DB trigger can update amount_paid/status.
        for (let i = 0; i < 8 && !cancelled; i += 1) {
          const latest = await loadInvoice()
          if (latest?.invoice.status === 'paid') break
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      } finally {
        if (!cancelled) setConfirming(false)
      }
    })()

    return () => { cancelled = true }
  }, [data?.invoice.id, paymentResult, provider, paypalOrderId, stripeSessionId, loadInvoice])

  const handleStripePay = async () => {
    if (!data?.invoice.id) return
    setPayLoading('stripe')
    const { data: checkout, error: fnErr } = await supabase.functions.invoke('create-stripe-checkout', {
      body: {
        invoiceId: data.invoice.id,
        successUrl: `${window.location.origin}/invoice/${hash}?payment=success&provider=stripe&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${window.location.origin}/invoice/${hash}?payment=cancelled&provider=stripe`,
      },
    })
    if (!fnErr && checkout?.url) {
      window.location.href = checkout.url
    } else {
      setPayLoading(null)
      alert(checkout?.error || 'Online card payment is not configured yet. Please contact us to arrange payment.')
    }
  }

  const handlePayPalPay = async () => {
    if (!data?.invoice.id) return
    setPayLoading('paypal')
    const { data: checkout, error: fnErr } = await supabase.functions.invoke('create-paypal-checkout', {
      body: {
        invoiceId: data.invoice.id,
        successUrl: `${window.location.origin}/invoice/${hash}?payment=success&provider=paypal`,
        cancelUrl: `${window.location.origin}/invoice/${hash}?payment=cancelled&provider=paypal`,
      },
    })
    if (!fnErr && checkout?.url) {
      window.location.href = checkout.url
    } else {
      setPayLoading(null)
      alert(checkout?.error || 'PayPal is not configured yet. Please contact us to arrange payment.')
    }
  }

  const invoiceNumber = data
    ? `${(data.invoice.prefix ?? 'INV-').replace(/-+$/, '')}-${String(data.invoice.number ?? '').padStart(4, '0')}`
    : ''

  const showPayButton =
    data &&
    !['paid', 'cancelled', 'draft'].includes(data.invoice.status) &&
    data.invoice.amount_due > 0

  const statusLabel = data?.invoice.status === 'partially_paid' ? 'partial' : data?.invoice.status

  return (
    <div className="min-h-screen bg-[#0f0f0f] px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500 mb-1">
              {loading ? '…' : (data?.org.name ?? '')}
            </p>
            <h1 className="text-2xl font-bold text-white">
              {loading ? 'Loading…' : (error ? 'Invoice' : `Invoice ${invoiceNumber}`)}
            </h1>
          </div>
          {data && (
            <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide ${
              STATUS_COLORS[data.invoice.status] ?? 'bg-gray-500/20 text-gray-300'
            }`}>
              {statusLabel}
            </span>
          )}
        </div>

        {/* Error state */}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-5 py-8 text-center">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-red-300 font-medium">{error}</p>
            <p className="text-gray-500 text-sm mt-1">Check the link and try again, or contact your account manager.</p>
          </div>
        )}

        {/* Payment result banners */}
        {paymentResult === 'success' && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300 flex items-center gap-2">
            <CheckCheck size={16} />
            {data?.invoice.status === 'paid'
              ? 'Payment received — thank you! This invoice is now paid.'
              : confirming
                ? 'Payment received — confirming your invoice status…'
                : 'Payment received — thank you! This invoice will be marked as paid once confirmed.'}
          </div>
        )}
        {paymentResult === 'cancelled' && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300 flex items-center gap-2">
            <XCircle size={16} />
            Payment was not completed. You can try again below.
          </div>
        )}

        {data && (
          <>
            {/* Invoice meta */}
            <div className="rounded-xl border border-white/10 bg-white/5 p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Bill To</h3>
                {data.billTo.company && <p className="text-white font-medium">{data.billTo.company}</p>}
                {data.billTo.contact && <p className="text-gray-300 text-sm">{data.billTo.contact}</p>}
                {data.billTo.email && <p className="text-gray-400 text-sm">{data.billTo.email}</p>}
                {!data.billTo.company && !data.billTo.contact && <p className="text-gray-500 text-sm">—</p>}
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Issue Date</span>
                  <span className="text-white">{fmtDate(data.invoice.issue_date)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Due Date</span>
                  <span className="text-white">{fmtDate(data.invoice.due_date)}</span>
                </div>
                {data.invoice.amount_paid > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Amount Paid</span>
                    <span className="text-green-400">{fmt(data.invoice.amount_paid)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Line items */}
            <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 grid grid-cols-[1fr_80px_100px_100px] gap-2 text-xs font-medium uppercase text-gray-500">
                <div>Description</div>
                <div className="text-right">Qty</div>
                <div className="text-right">Unit Price</div>
                <div className="text-right">Subtotal</div>
              </div>
              {data.items.map((item) => (
                <div key={item.id} className="px-4 py-3 border-b border-white/5 grid grid-cols-[1fr_80px_100px_100px] gap-2">
                  <div>
                    <p className="text-sm text-white">{item.description || '—'}</p>
                    {item.long_description && (
                      <p className="text-xs text-gray-400 mt-0.5 whitespace-pre-wrap">{item.long_description}</p>
                    )}
                  </div>
                  <div className="text-sm text-gray-300 text-right tabular-nums">
                    {item.quantity} {item.unit ? <span className="text-gray-500">{item.unit}</span> : null}
                  </div>
                  <div className="text-sm text-gray-300 text-right tabular-nums">{fmt(item.unit_price)}</div>
                  <div className="text-sm text-white text-right tabular-nums font-medium">{fmt(item.subtotal)}</div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-full max-w-xs space-y-2 text-sm rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex justify-between">
                  <span className="text-gray-400">Subtotal</span>
                  <span className="text-white tabular-nums">{fmt(data.invoice.subtotal)}</span>
                </div>
                {data.invoice.discount_total > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Discount</span>
                    <span className="text-red-400 tabular-nums">-{fmt(data.invoice.discount_total)}</span>
                  </div>
                )}
                {data.invoice.adjustment !== 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Adjustment</span>
                    <span className="text-white tabular-nums">
                      {data.invoice.adjustment > 0 ? '+' : ''}{fmt(data.invoice.adjustment)}
                    </span>
                  </div>
                )}
                <div className="border-t border-white/10 pt-2 flex justify-between font-semibold">
                  <span className="text-gray-200">Total</span>
                  <span className="text-white tabular-nums text-base">{fmt(data.invoice.total)}</span>
                </div>
                {data.invoice.amount_due !== data.invoice.total && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Amount Due</span>
                    <span className="text-white tabular-nums font-semibold">{fmt(data.invoice.amount_due)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Payment buttons */}
            {showPayButton && (
              <div className="flex flex-col sm:flex-row justify-end gap-3">
                {data.paymentMethods?.stripe !== false && (
                  <button
                    onClick={handleStripePay}
                    disabled={payLoading !== null}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-60 px-6 py-3 text-sm font-semibold text-white transition-colors"
                  >
                    {payLoading === 'stripe' ? 'Redirecting…' : `Pay by Card ${fmt(data.invoice.amount_due)}`}
                  </button>
                )}
                {data.paymentMethods?.paypal && (
                  <button
                    onClick={handlePayPalPay}
                    disabled={payLoading !== null}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#ffc439] hover:bg-[#f4b800] disabled:opacity-60 px-6 py-3 text-sm font-semibold text-black transition-colors"
                  >
                    {payLoading === 'paypal' ? 'Redirecting…' : 'Pay with PayPal'}
                  </button>
                )}
              </div>
            )}
            {data.invoice.status === 'paid' && (
              <div className="flex justify-end">
                <div className="inline-flex items-center gap-2 rounded-lg bg-green-500/10 border border-green-500/30 px-6 py-3 text-sm font-semibold text-green-300">
                  <CheckCheck size={16} /> Paid in full
                </div>
              </div>
            )}

            {/* Notes / Terms */}
            {(data.invoice.notes || data.invoice.terms) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.invoice.notes && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Notes</h3>
                    <p className="text-sm text-gray-300 whitespace-pre-wrap">{data.invoice.notes}</p>
                  </div>
                )}
                {data.invoice.terms && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Terms</h3>
                    <p className="text-sm text-gray-300 whitespace-pre-wrap">{data.invoice.terms}</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <p className="text-center text-xs text-gray-600 pt-4">Powered by Jolo</p>
      </div>
    </div>
  )
}
