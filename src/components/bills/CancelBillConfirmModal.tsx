import { useEffect, useState } from 'react'
import { appendBillCancellationNote } from '@/lib/billStatus'
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
  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setReason('')
    setCancelling(false)
    setError(null)
    setReasonError(null)
  }, [open, billId])

  if (!open) return null

  const handleConfirm = async () => {
    if (cancelling) return

    const trimmedReason = reason.trim()
    if (!trimmedReason) {
      setReasonError('Enter a cancellation reason before confirming.')
      return
    }

    setCancelling(true)
    setError(null)
    setReasonError(null)

    const { data: existing, error: fetchError } = await supabase
      .from('invoices')
      .select('notes')
      .eq('id', billId)
      .eq('org_id', orgId)
      .eq('direction', 'inbound')
      .maybeSingle()

    if (fetchError) {
      setError(fetchError.message || 'Failed to load bill notes.')
      setCancelling(false)
      return
    }

    const notes = appendBillCancellationNote(existing?.notes ?? null, trimmedReason)

    const { data, error: updateError } = await supabase
      .from('invoices')
      .update({ status: 'cancelled', notes })
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
        <div className="mt-4">
          <label htmlFor="cancel-bill-reason" className="block text-xs font-medium text-gray-400 mb-1">
            Cancellation reason <span className="text-red-400">*</span>
          </label>
          <textarea
            id="cancel-bill-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              if (reasonError) setReasonError(null)
            }}
            rows={3}
            disabled={cancelling}
            placeholder="Why is this bill being cancelled?"
            className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            data-testid="cancel-bill-reason"
          />
          {reasonError && (
            <p className="text-sm text-red-400 mt-1" data-testid="cancel-bill-reason-error">
              {reasonError}
            </p>
          )}
        </div>
        {error && <p className="text-sm text-red-400 mt-3" data-testid="cancel-bill-error">{error}</p>}
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
