/** Shared inbox thread resolution — disambiguate sibling copies by mailbox/recipient. */

/** Normalize Message-ID for consistent threading (strip angle brackets, trim). */
export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id?.trim()) return null
  const s = id.trim().replace(/^</, '').replace(/>$/, '').trim()
  return s || null
}

export function normalizeEmail(addr: string): string {
  if (!addr?.trim()) return ''
  const m = addr.trim().match(/<([^>]+)>/)
  return (m ? m[1] : addr).trim().toLowerCase()
}

export function normalizeSubject(subject: string): string {
  return (subject ?? '').replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
}

/** Mailbox dimension: inbound recipient or outbound sender (our address). */
export function deriveMailboxAddress(
  direction: 'inbound' | 'outbound',
  toAddr: string,
  fromAddr: string,
  accountEmail?: string | null,
): string {
  // Prefer the synced mailbox account itself. Message headers can show an alias or the
  // original recipient when mail was forwarded/copied, which is exactly the Jay-vs-Chris
  // collision case. The account email is the stable thread ownership dimension.
  const accountMailbox = normalizeEmail(accountEmail ?? '')
  if (accountMailbox) return accountMailbox
  return direction === 'inbound' ? normalizeEmail(toAddr) : normalizeEmail(fromAddr)
}

export function refMapKey(externalId: string, mailboxAddress: string): string {
  return `${externalId}\0${mailboxAddress}`
}

export function subjectMapKey(normSubject: string, mailboxAddress: string): string {
  return `${normSubject}\0${mailboxAddress}`
}

type RefRow = {
  external_id: string
  thread_id: string
  inbox_threads: { imap_account_id: string | null; mailbox_address: string | null } | null
}

/**
 * Build reference map keyed by external_id+mailbox_address.
 * Rows are already scoped to the syncing account via message imap_account_id; map each ref
 * under the thread mailbox and the account email so sent copies resolve even when the thread
 * mailbox differs (e.g. thread owned by jay@coacho.com, sent via jay@jaylogan.com account).
 * Legacy external_id-only entries are included only when unambiguous (single thread).
 */
export function buildRefThreadMap(refRows: RefRow[], accountEmail?: string | null): Map<string, string> {
  const map = new Map<string, string>()
  const legacyCounts = new Map<string, number>()
  const legacyWinner = new Map<string, string>()
  const accountMailbox = normalizeEmail(accountEmail ?? '')

  for (const r of refRows) {
    if (!r.external_id) continue
    const threadMailbox = normalizeEmail(r.inbox_threads?.mailbox_address ?? '')
    const mailboxes = new Set<string>()
    if (threadMailbox) mailboxes.add(threadMailbox)
    if (accountMailbox) mailboxes.add(accountMailbox)
    if (mailboxes.size > 0) {
      for (const mailbox of mailboxes) {
        map.set(refMapKey(r.external_id, mailbox), r.thread_id)
      }
    } else {
      const n = (legacyCounts.get(r.external_id) ?? 0) + 1
      legacyCounts.set(r.external_id, n)
      if (n === 1) legacyWinner.set(r.external_id, r.thread_id)
      else legacyWinner.delete(r.external_id)
    }
  }

  for (const [extId, count] of legacyCounts) {
    if (count === 1 && legacyWinner.has(extId)) map.set(extId, legacyWinner.get(extId)!)
  }
  return map
}

type SubjectThread = { id: string; subject: string | null; mailbox_address: string | null }

export function buildSubjectThreadMap(threads: SubjectThread[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of threads) {
    const norm = normalizeSubject(t.subject ?? '')
    if (!norm) continue
    const mailbox = normalizeEmail(t.mailbox_address ?? '')
    if (mailbox) {
      const key = subjectMapKey(norm, mailbox)
      if (!map.has(key)) map.set(key, t.id)
    } else if (!map.has(norm)) {
      map.set(norm, t.id)
    }
  }
  return map
}

/** Resolve thread from refs/subject maps. Conservative: no mailbox-agnostic fallback when mailbox is known. */
export function resolveThreadIdFromMaps(args: {
  inReplyTo: string | null
  refsList: string[]
  subject: string
  mailboxAddress: string
  refMap: Map<string, string>
  subjectThreadMap: Map<string, string>
}): string | undefined {
  const { inReplyTo, refsList, subject, mailboxAddress, refMap, subjectThreadMap } = args
  const mailbox = normalizeEmail(mailboxAddress)

  for (const refId of [inReplyTo, ...refsList]) {
    if (!refId) continue
    if (mailbox) {
      const key = refMapKey(refId, mailbox)
      if (refMap.has(key)) return refMap.get(key)
      continue
    }
    if (refMap.has(refId)) return refMap.get(refId)
  }

  const normSubject = normalizeSubject(subject)
  if (!normSubject) return undefined
  if (mailbox) {
    const key = subjectMapKey(normSubject, mailbox)
    if (subjectThreadMap.has(key)) return subjectThreadMap.get(key)
    return undefined
  }
  if (subjectThreadMap.has(normSubject)) return subjectThreadMap.get(normSubject)
  return undefined
}
