import { supabase } from '@/lib/supabase'
import {
  isInvoiceEmailHtml,
  resolveInvoiceDraftDisplayKind,
  type InvoiceEmailKind,
} from '@/lib/invoiceEmailContent'

export type InvoiceInboxNavigationSendContext = {
  invoiceId: string
  kind: InvoiceEmailKind
  status: string
}

export type ThreadInvoiceLinkForSend = {
  invoice_id: string
  invoice?: { status: string } | null
}

/** Resolve invoice send metadata when replying in a thread (navigation ref or thread link fallback). */
export function resolveInvoiceEmailSendOnThreadReply(args: {
  navigationContext?: InvoiceInboxNavigationSendContext | null
  threadInvoiceLinks: ThreadInvoiceLinkForSend[]
  subject?: string | null
  html?: string | null
}): InvoiceInboxNavigationSendContext | null {
  const nav = args.navigationContext
  const linked = args.threadInvoiceLinks[0]
  const invoiceId = nav?.invoiceId ?? linked?.invoice_id ?? null
  if (!invoiceId) return null

  if (!nav && !isInvoiceEmailHtml(args.html)) return null

  return {
    invoiceId,
    kind: nav?.kind ?? resolveInvoiceDraftDisplayKind({
      contextKind: null,
      subject: args.subject,
      html: args.html,
    }),
    status: nav?.status ?? linked?.invoice?.status ?? 'draft',
  }
}

export type InboxMessageThreadCheck = {
  is_draft?: boolean | null
}

/** True when the row represents a sent or received message (not an app/IMAP draft). */
export function isRealInboxThreadMessage(msg: InboxMessageThreadCheck): boolean {
  return !msg.is_draft
}

export async function threadHasRealMessages(threadId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('inbox_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId)
    .eq('is_draft', false)

  if (error) {
    console.warn('[invoiceEmailThread] threadHasRealMessages failed', error.message)
    return false
  }
  return (count ?? 0) > 0
}

/** Returns the thread id only when it contains at least one non-draft message. */
export async function resolveUsableInvoiceSentThreadId(
  emailSentThreadId: string | null | undefined,
): Promise<string | null> {
  if (!emailSentThreadId) return null
  return (await threadHasRealMessages(emailSentThreadId)) ? emailSentThreadId : null
}

export async function linkInvoiceToThread(
  invoiceId: string,
  threadId: string,
  userId?: string | null,
): Promise<void> {
  await supabase
    .from('inbox_thread_invoices')
    .upsert(
      { thread_id: threadId, invoice_id: invoiceId, ...(userId ? { created_by: userId } : {}) },
      { onConflict: 'thread_id,invoice_id' },
    )
}

/** Updates invoice send metadata and links the thread without overwriting the primary sent thread on resend/follow-up. */
export async function recordInvoiceEmailSend(args: {
  invoiceId: string
  threadId: string
  userId?: string | null
  kind: InvoiceEmailKind
  status?: string
}): Promise<void> {
  const sentUpdate: Record<string, string> = {
    updated_at: new Date().toISOString(),
    email_sent_at: new Date().toISOString(),
  }
  if (args.kind === 'initial') {
    sentUpdate.email_sent_thread_id = args.threadId
  }
  if (args.status === 'draft') {
    sentUpdate.status = 'unpaid'
  }
  await supabase.from('invoices').update(sentUpdate).eq('id', args.invoiceId)
  await linkInvoiceToThread(args.invoiceId, args.threadId, args.userId)
}

export async function clearStaleInvoiceSentThreadLink(
  invoiceId: string,
  threadId: string,
): Promise<void> {
  await supabase
    .from('inbox_thread_invoices')
    .delete()
    .eq('thread_id', threadId)
    .eq('invoice_id', invoiceId)

  await supabase
    .from('invoices')
    .update({ email_sent_thread_id: null, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('email_sent_thread_id', threadId)
}

async function clearInvoiceLinksForOrphanThread(threadId: string, invoiceId?: string | null): Promise<void> {
  if (invoiceId) {
    await clearStaleInvoiceSentThreadLink(invoiceId, threadId)
    return
  }

  const { data: linkedInvoices } = await supabase
    .from('invoices')
    .select('id')
    .eq('email_sent_thread_id', threadId)

  for (const row of linkedInvoices ?? []) {
    await clearStaleInvoiceSentThreadLink(row.id, threadId)
  }

  await supabase.from('inbox_thread_invoices').delete().eq('thread_id', threadId)
}

/**
 * Removes a draft-only / empty inbox thread and any invoice links pointing at it.
 * Returns true when the thread row was deleted.
 */
export async function cleanupOrphanDraftThread(
  threadId: string,
  options?: { invoiceId?: string | null },
): Promise<boolean> {
  if (await threadHasRealMessages(threadId)) return false

  const { count, error: countErr } = await supabase
    .from('inbox_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId)

  if (countErr) {
    console.warn('[invoiceEmailThread] cleanupOrphanDraftThread count failed', countErr.message)
    return false
  }
  if ((count ?? 0) > 0) return false

  await clearInvoiceLinksForOrphanThread(threadId, options?.invoiceId)

  const { error } = await supabase.from('inbox_threads').delete().eq('id', threadId)
  if (error) {
    console.warn('[invoiceEmailThread] cleanupOrphanDraftThread delete failed', error.message)
    return false
  }
  return true
}

/**
 * After removing a draft message, delete the thread when no real or draft messages remain.
 */
export async function cleanupThreadAfterDraftRemoved(
  threadId: string,
  options?: { invoiceId?: string | null },
): Promise<boolean> {
  if (await threadHasRealMessages(threadId)) return false

  const { count, error: countErr } = await supabase
    .from('inbox_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId)

  if (countErr) {
    console.warn('[invoiceEmailThread] cleanupThreadAfterDraftRemoved count failed', countErr.message)
    return false
  }
  if ((count ?? 0) > 0) return false

  return cleanupOrphanDraftThread(threadId, options)
}
