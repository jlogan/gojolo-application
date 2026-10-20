/** Gmail web deep links: stored X-GM-THRID / X-GM-MSGID when available, else RFC822 Message-ID search. */

const GMAIL_WEB_BASE = 'https://mail.google.com/mail/u/0/'

export function isGmailImapHost(host: string | null | undefined): boolean {
  return !!host && host.toLowerCase().includes('gmail.com')
}

/** Synthetic external_id values from IMAP sync/backfill — not real RFC822 Message-IDs. */
export function isSyntheticExternalId(id: string): boolean {
  const s = id.trim()
  return /^uid-/i.test(s) || /^draft-heal-/i.test(s)
}

/** Strip angle brackets and whitespace from a Message-ID header value. */
export function normalizeRfc822MessageId(id: string | null | undefined): string | null {
  if (!id?.trim()) return null
  const s = id.trim().replace(/^</, '').replace(/>$/, '').trim()
  return s || null
}

/** True when value looks like a real RFC822 Message-ID (local@domain), not a uid-* placeholder. */
export function isRfc822MessageId(id: string | null | undefined): boolean {
  const normalized = normalizeRfc822MessageId(id)
  if (!normalized || isSyntheticExternalId(normalized)) return false
  return /^[^\s@<>]+@[^\s@<>]+/.test(normalized)
}

/** Gmail X-GM-THRID / X-GM-MSGID from IMAP (ImapFlow); decimal strings for #inbox/… links. */
export function normalizeGmailImapId(id: string | null | undefined): string | null {
  if (!id?.trim()) return null
  const s = id.trim()
  if (!/^\d+$/.test(s)) return null
  return s
}

/** Gmail web search URL: finds the message (and thread) anywhere in the mailbox. */
export function buildGmailRfc822SearchUrl(messageId: string): string {
  const id = normalizeRfc822MessageId(messageId)
  if (!id) throw new Error('buildGmailRfc822SearchUrl requires a valid RFC822 Message-ID')
  const query = `in:anywhere rfc822msgid:${id}`
  return `${GMAIL_WEB_BASE}#search/${encodeURIComponent(query)}`
}

export function buildGmailInboxThreadUrl(gmailThreadId: string): string {
  const id = normalizeGmailImapId(gmailThreadId)
  if (!id) throw new Error('buildGmailInboxThreadUrl requires a valid Gmail thread id')
  return `${GMAIL_WEB_BASE}#inbox/${id}`
}

export function buildGmailInboxMessageUrl(gmailThreadId: string, gmailMessageId: string): string {
  const threadId = normalizeGmailImapId(gmailThreadId)
  const messageId = normalizeGmailImapId(gmailMessageId)
  if (!threadId || !messageId) {
    throw new Error('buildGmailInboxMessageUrl requires valid Gmail thread and message ids')
  }
  return `${GMAIL_WEB_BASE}#inbox/${threadId}/${messageId}`
}

type GmailThreadLinkThread = {
  imap_account_id?: string | null
  gmail_thread_id?: string | null
}

type GmailThreadLinkAccount = {
  id: string
  host: string
}

export type GmailLinkMessage = {
  imap_account_id?: string | null
  external_id?: string | null
  message_id_header?: string | null
  gmail_thread_id?: string | null
  gmail_message_id?: string | null
  is_draft?: boolean | null
  received_at?: string | null
}

function resolveGmailImapAccount(
  imapAccountId: string | null | undefined,
  imapAccounts: GmailThreadLinkAccount[],
): GmailThreadLinkAccount | null {
  if (!imapAccountId) return null
  const account = imapAccounts.find((a) => a.id === imapAccountId)
  if (!account || !isGmailImapHost(account.host)) return null
  return account
}

function pickRfc822MessageIdFromMessage(message: GmailLinkMessage): string | null {
  for (const raw of [message.message_id_header, message.external_id]) {
    if (isRfc822MessageId(raw)) return normalizeRfc822MessageId(raw)
  }
  return null
}

/** Pick the latest non-draft message with a real RFC822 id; fall back to drafts, then older messages. */
export function pickRfc822MessageIdForGmailLink(messages: GmailLinkMessage[]): string | null {
  if (messages.length === 0) return null

  const sorted = [...messages].sort(
    (a, b) => new Date(b.received_at ?? 0).getTime() - new Date(a.received_at ?? 0).getTime(),
  )
  const candidates = [
    ...sorted.filter((m) => !m.is_draft),
    ...sorted.filter((m) => m.is_draft),
  ]

  for (const m of candidates) {
    const id = pickRfc822MessageIdFromMessage(m)
    if (id) return id
  }
  return null
}

/** Per-message Gmail URL when the row belongs to Gmail IMAP and ids or RFC822 are available. */
export function getGmailMessageUrlForMessage(
  message: GmailLinkMessage,
  thread: GmailThreadLinkThread,
  imapAccounts: GmailThreadLinkAccount[],
): string | null {
  const imapAccountId = message.imap_account_id ?? thread.imap_account_id
  if (!resolveGmailImapAccount(imapAccountId, imapAccounts)) return null

  const gmailThreadId =
    normalizeGmailImapId(message.gmail_thread_id) ?? normalizeGmailImapId(thread.gmail_thread_id)
  const gmailMessageId = normalizeGmailImapId(message.gmail_message_id)
  if (gmailThreadId && gmailMessageId) {
    return buildGmailInboxMessageUrl(gmailThreadId, gmailMessageId)
  }

  const rfc822 = pickRfc822MessageIdFromMessage(message)
  if (rfc822) return buildGmailRfc822SearchUrl(rfc822)

  return null
}

/** Returns a Gmail web URL when the thread belongs to a Gmail IMAP account. */
export function getGmailThreadUrlForThread(
  thread: GmailThreadLinkThread,
  imapAccounts: GmailThreadLinkAccount[],
  messages: GmailLinkMessage[] = [],
): string | null {
  const account = imapAccounts.find((a) => a.id === thread.imap_account_id)
  if (!account || !isGmailImapHost(account.host)) return null

  const gmailThreadId = normalizeGmailImapId(thread.gmail_thread_id)
  if (gmailThreadId) return buildGmailInboxThreadUrl(gmailThreadId)

  const messageId = pickRfc822MessageIdForGmailLink(messages)
  if (!messageId) return null
  return buildGmailRfc822SearchUrl(messageId)
}
