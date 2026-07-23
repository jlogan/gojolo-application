import { normalizeEmail, normalizeSubject } from './inboxThreadResolve.ts'

const OUTBOUND_APP_DEDUP_WINDOW_MS = 10 * 60 * 1000

type AppRow = {
  thread_id: string
  from_identifier: string
  to_identifier: string | null
  inbox_threads: { subject: string | null } | null
}

/** Find a recent app-inserted outbound row (no IMAP UID yet) to reuse its thread. */
export async function findOutboundAppThreadId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  args: {
    imapAccountId: string
    fromAddr: string
    toAddr: string
    subject: string
    receivedAt: Date
  },
): Promise<string | undefined> {
  const cutoff = new Date(args.receivedAt.getTime() - OUTBOUND_APP_DEDUP_WINDOW_MS).toISOString()
  const { data: rows } = await service.from('inbox_messages')
    .select('thread_id, from_identifier, to_identifier, inbox_threads(subject)')
    .eq('imap_account_id', args.imapAccountId)
    .eq('direction', 'outbound')
    .is('external_uid', null)
    .gte('received_at', cutoff)
    .order('received_at', { ascending: false })
    .limit(20)

  if (!rows?.length) return undefined

  const normFrom = normalizeEmail(args.fromAddr)
  const normTo = normalizeEmail(args.toAddr)
  const normSubject = normalizeSubject(args.subject)

  for (const row of rows as AppRow[]) {
    if (normalizeEmail(row.from_identifier) !== normFrom) continue
    if (normalizeEmail(row.to_identifier ?? '') !== normTo) continue
    if (normSubject) {
      const rowSubject = normalizeSubject(row.inbox_threads?.subject ?? '')
      if (rowSubject && rowSubject !== normSubject) continue
    }
    return row.thread_id
  }
  return undefined
}

export { OUTBOUND_APP_DEDUP_WINDOW_MS }
