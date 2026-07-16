import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  BILL_PAYMENT_METHODS,
  DEFAULT_BILL_PAYMENT_METHOD,
  type BillPaymentMethod,
} from '@/lib/billPaymentMethods'

type Props = {
  open: boolean
  billId: string
  billLabel: string
  defaultAmount: number
  onClose: () => void
  onSuccess: () => void
}

export default function RecordBillPaymentModal({
  open,
  billId,
  billLabel,
  defaultAmount,
  onClose,
  onSuccess,
}: Props) {
  const { user } = useAuth()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<BillPaymentMethod>(DEFAULT_BILL_PAYMENT_METHOD)
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [transactionId, setTransactionId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setAmount(defaultAmount > 0 ? String(defaultAmount) : '')
    setMethod(DEFAULT_BILL_PAYMENT_METHOD)
    setPaymentDate(new Date().toISOString().slice(0, 10))
    setTransactionId('')
    setError(null)
    setSaving(false)
  }, [open, billId, defaultAmount])

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.id || saving) return

    const parsed = parseFloat(amount)
    if (Number.isNaN(parsed) || parsed <= 0) {
      setError('Enter a valid payment amount.')
      return
    }

    setSaving(true)
    setError(null)
    const { error: insertError } = await supabase.from('invoice_payments').insert({
      invoice_id: billId,
      amount: parsed,
      payment_method: method,
      payment_date: paymentDate,
      transaction_id: transactionId.trim() || null,
      recorded_by: user.id,
    })

    if (insertError) {
      setError(insertError.message || 'Failed to record payment.')
      setSaving(false)
      return
    }

    onSuccess()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-bill-payment-title"
      data-testid="record-bill-payment-modal"
    >
      <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 id="record-bill-payment-title" className="text-lg font-semibold text-white">
            Record payment
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-surface-muted shrink-0 disabled:opacity-50"
            aria-label="Close record payment dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-400 mb-4">{billLabel}</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="bill-pay-date" className="block text-xs font-medium text-gray-400 mb-1">
              Payment date *
            </label>
            <input
              id="bill-pay-date"
              type="date"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="bill-payment-date"
            />
          </div>
          <div>
            <label htmlFor="bill-pay-amount" className="block text-xs font-medium text-gray-400 mb-1">
              Amount *
            </label>
            <input
              id="bill-pay-amount"
              type="number"
              step="0.01"
              min="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="bill-payment-amount"
            />
          </div>
          <div>
            <label htmlFor="bill-pay-method" className="block text-xs font-medium text-gray-400 mb-1">
              Payment method *
            </label>
            <select
              id="bill-pay-method"
              required
              value={method}
              onChange={(e) => setMethod(e.target.value as BillPaymentMethod)}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="bill-payment-method"
            >
              {BILL_PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bill-pay-txn" className="block text-xs font-medium text-gray-400 mb-1">
              Transaction / reference number
            </label>
            <input
              id="bill-pay-txn"
              type="text"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid="bill-payment-transaction-id"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400" data-testid="bill-payment-error">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-2 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50"
              data-testid="bill-payment-submit"
            >
              {saving ? 'Saving…' : 'Record payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
