import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, AlertCircle } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import {
  INVOICE_SEND_KIND_QUERY,
  type InvoiceEmailKind,
  type InvoiceInboxDraftKind,
} from '@/lib/invoiceEmailContent'
import { createInvoiceInboxDraft } from '@/lib/invoiceResendDraft'

function parsePreferredKind(searchParams: URLSearchParams): InvoiceEmailKind | undefined {
  const raw = searchParams.get(INVOICE_SEND_KIND_QUERY)
  if (raw === 'overdue_followup') return 'overdue_followup'
  if (raw === 'resend') return 'resend'
  return undefined
}

export type InvoiceDraftNavigationState = {
  invoiceDraft: {
    invoiceId: string
    kind: InvoiceEmailKind
    status: string
    draftMessageId: string
    openEditor: boolean
  }
}

export default function InvoiceEmailDraft() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const preferredKind = parsePreferredKind(searchParams)
  const { currentOrg, isVendor } = useOrg()
  const startedRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id || !currentOrg?.id || startedRef.current) return
    startedRef.current = true

    if (isVendor) {
      setError('Vendors cannot send invoices.')
      return
    }

    void (async () => {
      const { result, error: draftErr } = await createInvoiceInboxDraft(
        id,
        currentOrg.id,
        preferredKind as InvoiceInboxDraftKind | undefined,
      )
      if (draftErr || !result) {
        setError(draftErr ?? 'Could not create invoice draft.')
        return
      }

      navigate(`/inbox/${result.threadId}`, {
        replace: true,
        state: {
          invoiceDraft: {
            invoiceId: result.invoiceId,
            kind: result.kind,
            status: result.status,
            draftMessageId: result.messageId,
            openEditor: true,
          },
        } satisfies InvoiceDraftNavigationState,
      })
    })()
  }, [currentOrg?.id, id, isVendor, navigate, preferredKind])

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link to={id ? `/invoices/${id}` : '/invoices'} className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1 mb-4">
          <ArrowLeft size={16} /> Back to Invoice
        </Link>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-300 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      </div>
    )
  }

  return <div className="p-6 text-sm text-gray-400">Preparing invoice draft in Inbox…</div>
}
