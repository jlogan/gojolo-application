/** Gmail X-GM-THRID / X-GM-MSGID helpers for ImapFlow ingest (no Gmail API). */

import { isGmailHost } from './inboxGmailLabels.ts'

export type GmailIdState = {
  gmail_thread_id: string | null
  gmail_message_id: string | null
}

type ImapGmailIdSource = {
  threadId?: unknown
  emailId?: unknown
}

function normalizeGmailId(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  return s || null
}

export function extractGmailIds(isGmail: boolean, msg: ImapGmailIdSource): GmailIdState {
  if (!isGmail) {
    return { gmail_thread_id: null, gmail_message_id: null }
  }
  return {
    gmail_thread_id: normalizeGmailId(msg.threadId),
    gmail_message_id: normalizeGmailId(msg.emailId),
  }
}

/** Merge Gmail IMAP id fetch keys into an ImapFlow fetch query (no-op for non-Gmail). */
export function withGmailImapIdFetch<T extends Record<string, unknown>>(isGmail: boolean, query: T): T {
  if (!isGmail) return query
  return { ...query, threadId: true, emailId: true }
}

export function gmailIdMessageFields(state: GmailIdState): {
  gmail_thread_id?: string
  gmail_message_id?: string
} {
  const fields: { gmail_thread_id?: string; gmail_message_id?: string } = {}
  if (state.gmail_thread_id) fields.gmail_thread_id = state.gmail_thread_id
  if (state.gmail_message_id) fields.gmail_message_id = state.gmail_message_id
  return fields
}

type SupabaseRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data?: unknown; error: { message?: string } | null }>
}

export async function refreshGmailIdsForEnvelopes(
  service: SupabaseRpcClient,
  imapAccountId: string,
  host: string,
  envelopes: Array<{ uid?: unknown; threadId?: unknown; emailId?: unknown }>,
  logPrefix = '[gmail-ids]',
): Promise<void> {
  if (!isGmailHost(host) || envelopes.length === 0) return

  const states: Array<{ uid: number; gmail_thread_id: string | null; gmail_message_id: string | null }> = []
  const seenUids = new Set<number>()
  for (const msg of envelopes) {
    const uid = Number(msg.uid)
    if (!uid || Number.isNaN(uid) || seenUids.has(uid)) continue
    seenUids.add(uid)
    const ids = extractGmailIds(true, msg)
    if (!ids.gmail_thread_id && !ids.gmail_message_id) continue
    states.push({ uid, ...ids })
  }
  if (states.length === 0) return

  const { error } = await service.rpc('refresh_inbox_message_gmail_id_states', {
    p_imap_account_id: imapAccountId,
    p_states: states,
  })
  if (error) console.log(logPrefix, 'refresh_inbox_message_gmail_id_states', error.message ?? error)
}

export async function syncThreadGmailIds(
  service: SupabaseRpcClient,
  threadId: string,
  logPrefix = '[gmail-ids]',
): Promise<void> {
  const { error } = await service.rpc('sync_inbox_thread_gmail_ids', { p_thread_id: threadId })
  if (error) console.log(logPrefix, 'sync_inbox_thread_gmail_ids', threadId, error.message ?? error)
}

export async function syncThreadGmailIdsBatch(
  service: SupabaseRpcClient,
  threadIds: Iterable<string>,
  logPrefix = '[gmail-ids]',
): Promise<void> {
  const unique = Array.from(new Set(threadIds))
  for (const threadId of unique) {
    await syncThreadGmailIds(service, threadId, logPrefix)
  }
}
