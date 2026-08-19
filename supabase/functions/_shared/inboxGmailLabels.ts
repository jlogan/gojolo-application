/** Gmail label / Inbox-flag helpers for ImapFlow ingest (no Gmail API). */

const GMAIL_SYSTEM_LABELS = new Set([
  '\\Inbox',
  '\\Sent',
  '\\Draft',
  '\\Trash',
  '\\Important',
  '\\Starred',
  '\\Snoozed',
  '\\Muted',
  '\\Chat',
  '\\Opened',
  '\\Unread',
  '\\Spam',
  'Inbox',
  'Sent',
  'Draft',
  'Trash',
  'Important',
  'Starred',
  'Snoozed',
  'Muted',
  'Chat',
  'Opened',
  'Unread',
  'Spam',
])

export function isGmailHost(host: string | null | undefined): boolean {
  return !!host && host.toLowerCase().includes('gmail.com')
}

export type GmailLabelState = {
  gmail_labels: string[]
  in_gmail_inbox: boolean
}

function collectLabelStrings(
  flags: Set<string> | undefined,
  labels: Set<string> | string[] | undefined,
): Set<string> {
  const all = new Set<string>()
  if (flags instanceof Set) {
    for (const f of Array.from(flags)) all.add(f)
  }
  if (labels instanceof Set) {
    for (const l of Array.from(labels)) all.add(l)
  } else if (Array.isArray(labels)) {
    for (const l of labels) all.add(l)
  }
  return all
}

export function extractGmailLabelState(
  isGmail: boolean,
  flags: Set<string> | undefined,
  labels: Set<string> | string[] | undefined,
): GmailLabelState {
  if (!isGmail) {
    return { gmail_labels: [], in_gmail_inbox: true }
  }

  const allLabels = collectLabelStrings(flags, labels)
  const inGmailInbox = allLabels.has('\\Inbox') || allLabels.has('Inbox')

  const customLabels: string[] = []
  for (const label of Array.from(allLabels)) {
    if (GMAIL_SYSTEM_LABELS.has(label)) continue
    if (label.startsWith('\\')) continue
    customLabels.push(label)
  }
  customLabels.sort()

  return { gmail_labels: customLabels, in_gmail_inbox: inGmailInbox }
}

export function gmailLabelMessageFields(state: GmailLabelState): {
  gmail_labels: string[] | null
  in_gmail_inbox: boolean
} {
  return {
    gmail_labels: state.gmail_labels.length > 0 ? state.gmail_labels : null,
    in_gmail_inbox: state.in_gmail_inbox,
  }
}

type SupabaseRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data?: unknown; error: { message?: string } | null }>
}

export async function refreshGmailLabelsForEnvelopes(
  service: SupabaseRpcClient,
  imapAccountId: string,
  host: string,
  envelopes: Array<{ uid?: unknown; flags?: Set<string>; labels?: Set<string> }>,
  logPrefix = '[gmail-labels]',
): Promise<void> {
  if (!isGmailHost(host) || envelopes.length === 0) return

  const states: Array<{ uid: number; gmail_labels: string[]; in_gmail_inbox: boolean }> = []
  const seenUids = new Set<number>()
  for (const msg of envelopes) {
    const uid = Number(msg.uid)
    if (!uid || Number.isNaN(uid) || seenUids.has(uid)) continue
    seenUids.add(uid)
    const labelState = extractGmailLabelState(true, msg.flags, msg.labels)
    states.push({ uid, ...labelState })
  }
  if (states.length === 0) return

  const { error } = await service.rpc('refresh_inbox_message_gmail_label_states', {
    p_imap_account_id: imapAccountId,
    p_states: states,
  })
  if (error) console.log(logPrefix, 'refresh_inbox_message_gmail_label_states', error.message ?? error)
}

export async function syncThreadGmailLabels(
  service: SupabaseRpcClient,
  threadId: string,
  logPrefix = '[gmail-labels]',
): Promise<void> {
  const { error } = await service.rpc('sync_inbox_thread_gmail_labels', { p_thread_id: threadId })
  if (error) console.log(logPrefix, 'sync_inbox_thread_gmail_labels', threadId, error.message ?? error)
}

export async function syncThreadGmailLabelsBatch(
  service: SupabaseRpcClient,
  threadIds: Iterable<string>,
  logPrefix = '[gmail-labels]',
): Promise<void> {
  const unique = Array.from(new Set(threadIds))
  for (const threadId of unique) {
    await syncThreadGmailLabels(service, threadId, logPrefix)
  }
}
