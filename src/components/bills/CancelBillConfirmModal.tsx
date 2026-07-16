import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Props = {
  open: boolean
  billId: string
  billLabel: string
  orgId: string
  onClose: () => void
  onSuccess: () => void
}

export default function CancelBillConfirmModal({
  open,
  billId,
  billLabel,
  orgId,
  onClose,
  onSuccess,
}: Props) {
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCancelling(false)
    setError(null)
  }, [open, billId])

  if (!open) return null

  const handleConfirm = async () => {
    if (cancelling) return
    setCancelling(true)
    setError(null)

    const { data, error: updateError } = await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', billId)
      .eq('org_id', orgId)
      .eq('direction', 'inbound')
      .in('status', ['draft', 'approved', 'partially_paid'])
      .select('id')

    if (updateError) {
      setError(updateError.message || 'Failed to cancel bill.')
      setCancelling(false)
      return
    }

    if (!data?.length) {
      setError('This bill could not be cancelled. It may already be paid or cancelled.')
      setCancelling(false)
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
      aria-labelledby="cancel-bill-title"
      data-testid="cancel-bill-modal"
    >
      <div className="bg-surface-elevated border border-border rounded-xl max-w-md w-full p-5 shadow-xl">
        <h2 id="cancel-bill-title" className="text-lg font-semibold text-white">
          Cancel this bill?
        </h2>
        <p className="text-sm text-gray-400 mt-2">
          <span className="text-gray-300">{billLabel}</span> will be marked cancelled. This cannot be undone from the bills list.
        </p>
        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={cancelling}
            className="px-4 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm disabled:opacity-50"
          >
            Keep bill
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={cancelling}
            className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-50"
            data-testid="cancel-bill-confirm"
          >
            {cancelling ? 'Cancelling…' : 'Cancel bill'}
          </button>
        </div>
      </div>
    </div>
  )
}
