import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Props = {
  open: boolean
  billId: string
  billLabel: string
  paymentId: string | null
  paymentLabel: string
  onClose: () => void
  onSuccess: () => void
}

export default function DeleteBillPaymentConfirmModal({
  open,
  billId,
  billLabel,
  paymentId,
  paymentLabel,
  onClose,
  onSuccess,
}: Props) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDeleting(false)
    setError(null)
  }, [open, paymentId])

  if (!open || !paymentId) return null

  const handleConfirm = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)

    const { error: deleteError } = await supabase
      .from('invoice_payments')
      .delete()
      .eq('id', paymentId)
      .eq('invoice_id', billId)

    if (deleteError) {
      setError(deleteError.message || 'Failed to delete payment.')
      setDeleting(false)
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
      aria-labelledby="delete-bill-payment-title"
      data-testid="delete-bill-payment-modal"
    >
      <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
        <h2 id="delete-bill-payment-title" className="text-lg font-semibold text-white">
          Delete payment?
        </h2>
        <p className="text-sm text-gray-400 mt-2">
          Remove <span className="text-gray-300">{paymentLabel}</span> from{' '}
          <span className="text-gray-300">{billLabel}</span>. Amount due and bill status will be recalculated.
        </p>
        {error && (
          <p className="text-sm text-red-400 mt-3" data-testid="delete-bill-payment-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="px-4 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm disabled:opacity-50"
          >
            Keep payment
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={deleting}
            className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-50"
            data-testid="delete-bill-payment-confirm"
          >
            {deleting ? 'Deleting…' : 'Delete payment'}
          </button>
        </div>
      </div>
    </div>
  )
}
