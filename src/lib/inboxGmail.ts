/** Gmail web deep links via RFC822 Message-ID search (IMAP X-GM-THRID is not usable in #inbox/{id}). */

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

/** Gmail web search URL: finds the message (and thread) anywhere in the mailbox. */
export function buildGmailRfc822SearchUrl(messageId: string): string {
  const id = normalizeRfc822MessageId(messageId)
  if (!id) throw new Error('buildGmailRfc822SearchUrl requires a valid RFC822 Message-ID')
  const query = `in:anywhere rfc822msgid:${id}`
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`
}

type GmailThreadLinkThread = {
  imap_account_id?: string | null
}

type GmailThreadLinkAccount = {
  id: string
  host: string
}

export type GmailLinkMessage = {
  external_id?: string | null
  message_id_header?: string | null
  is_draft?: boolean | null
  received_at?: string | null
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
    for (const raw of [m.message_id_header, m.external_id]) {
      if (isRfc822MessageId(raw)) return normalizeRfc822MessageId(raw)
    }
  }
  return null
}

/** Returns a Gmail web URL when the thread belongs to a Gmail IMAP account and a Message-ID is available. */
export function getGmailThreadUrlForThread(
  thread: GmailThreadLinkThread,
  imapAccounts: GmailThreadLinkAccount[],
  messages: GmailLinkMessage[] = [],
): string | null {
  const account = imapAccounts.find((a) => a.id === thread.imap_account_id)
  if (!account || !isGmailImapHost(account.host)) return null
  const messageId = pickRfc822MessageIdForGmailLink(messages)
  if (!messageId) return null
  return buildGmailRfc822SearchUrl(messageId)
}
