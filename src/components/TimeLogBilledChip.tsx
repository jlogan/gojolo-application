import { Link } from 'react-router-dom'
import { formatInvoiceNumber, getTimeLogBillingTooltipText, type TimeLogInvoiceSummary } from '@/lib/timeLogBilling'

type TimeLogBilledChipProps = {
  billed: boolean
  invoices?: TimeLogInvoiceSummary[]
  manualOnly?: boolean
  /** Clickable toggle (Timesheets page). */
  interactive?: boolean
  onClick?: () => void
  disabled?: boolean
  toggling?: boolean
}

function BilledTooltip({
  invoices,
  manualOnly,
}: {
  invoices: TimeLogInvoiceSummary[]
  manualOnly: boolean
}) {
  return (
    <span
      role="tooltip"
      className="pointer-events-auto absolute top-full left-1/2 z-20 mt-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-left text-xs text-gray-200 shadow-lg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {manualOnly ? (
        <span className="text-gray-300">Manually marked as billed</span>
      ) : (
        <span className="flex flex-col gap-1">
          {invoices.map((inv) => (
            <Link
              key={inv.id}
              to={`/invoices/${inv.id}`}
              className="text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {formatInvoiceNumber(inv)}
              <span className="text-gray-500"> · {inv.status.replace(/_/g, ' ')}</span>
            </Link>
          ))}
        </span>
      )}
    </span>
  )
}

export default function TimeLogBilledChip({
  billed,
  invoices = [],
  manualOnly = false,
  interactive = false,
  onClick,
  disabled = false,
  toggling = false,
}: TimeLogBilledChipProps) {
  const label = toggling ? '…' : billed ? '✓ Billed' : '○ Unbilled'
  const showBillingTooltip = billed && (manualOnly || invoices.length > 0)
  const billingTitle = showBillingTooltip
    ? getTimeLogBillingTooltipText(billed, invoices)
    : undefined

  const chipClass = `inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
    billed
      ? interactive
        ? 'bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400 transition-colors disabled:opacity-50'
        : 'bg-green-500/20 text-green-400'
      : interactive
        ? 'bg-gray-500/20 text-gray-500 hover:bg-green-500/20 hover:text-green-400 transition-colors disabled:opacity-50'
        : 'bg-gray-500/20 text-gray-500'
  }`

  const chip = interactive ? (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || toggling}
      title={showBillingTooltip ? billingTitle : billed ? 'Mark as unbilled' : 'Mark as billed'}
      className={chipClass}
    >
      {label}
    </button>
  ) : (
    <span className={chipClass} title={billingTitle}>{label}</span>
  )

  if (!showBillingTooltip) return chip

  return (
    <span className="relative inline-flex group">
      {chip}
      <BilledTooltip invoices={invoices} manualOnly={manualOnly} />
    </span>
  )
}
