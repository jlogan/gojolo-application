/**
 * Gmail draft revision ingest: All Mail copies often lack \Draft after edits.
 * Match against thread is_draft rows and the provider Drafts mailbox; never touch thread as sent.
 */
import { ImapFlow } from 'npm:imapflow'
import PostalMime from 'npm:postal-mime'
import {
  deriveMailboxAddress,
  normalizeEmail,
  normalizeSubject,
  refMapKey,
  resolveThreadIdFromMaps,
  subjectMapKey,
} from './inboxThreadResolve.ts'

export const RECENT_DRAFTS_LIMIT = 100
export const RECENT_SENT_LIMIT = 150
export const DRAFT_MATCH_MIN_SCORE = 2
const DRAFT_SENT_WINDOW_MS = 5 * 60 * 1000
const MAX_BODY_LENGTH = 50000

export function isGmailHost(host: string): boolean {
  return host.toLowerCase().includes('gmail.com')
}

export function getDraftsMailboxPath(host: string): string {
  return isGmailHost(host) ? '[Gmail]/Drafts' : 'Drafts'
}

export function getSentMailboxPath(host: string): string {
  return isGmailHost(host) ? '[Gmail]/Sent Mail' : 'Sent'
}

/** Ordered Sent mailbox paths to try when LIST special-use is unavailable. */
export function getSentMailboxCandidates(host: string): string[] {
  if (isGmailHost(host)) {
    return ['[Gmail]/Sent Mail', 'Sent Mail', 'Sent', '[Gmail]/Sent']
  }
  return ['Sent', 'Sent Mail', 'Sent Items', '[Gmail]/Sent Mail', '[Gmail]/Sent Mail']
}

function mailboxHasSentSpecialUse(specialUse: string | string[] | undefined): boolean {
  if (!specialUse) return false
  const flags = Array.isArray(specialUse) ? specialUse : [specialUse]
  return flags.some((f) => f.replace(/\\/g, '').toLowerCase() === 'sent')
}

/** Resolve Sent mailbox via LIST \\Sent, then fall back to known candidate paths. */
export async function resolveSentMailboxPath(client: ImapFlow, host: string): Promise<string | null> {
  try {
    for await (const mb of client.list()) {
      if (mailboxHasSentSpecialUse(mb.specialUse) && mb.path) {
        return mb.path
      }
    }
  } catch (err) {
    console.log('[inboxGmailDraftIngest] sent mailbox LIST failed', { error: (err as Error).message })
  }

  for (const candidate of getSentMailboxCandidates(host)) {
    try {
      await client.status(candidate, { messages: true })
      return candidate
    } catch {
      /* try next candidate */
    }
  }
  return null
}

export function recipientsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  const aParts = (a ?? '').split(',').map((s) => normalizeEmail(s)).filter(Boolean).sort()
  const bParts = (b ?? '').split(',').map((s) => normalizeEmail(s)).filter(Boolean).sort()
  if (!aParts.length && !bParts.length) return true
  if (aParts.join(',') === bParts.join(',')) return true
  const overlap = aParts.filter((t) => bParts.includes(t)).length
  return overlap > 0 && (overlap === aParts.length || overlap === bParts.length)
}

/** Strip Gmail/full-document HTML chrome so stored drafts don't reload with white/Times wrappers. */
export function normalizeDraftHtml(html: string | null | undefined): string | null {
  if (html == null) return null
  let h = html.trim()
  if (!h) return null

  const bodyMatch = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) h = bodyMatch[1]

  h = h
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .trim()

  return h || null
}

type PostalAddress = { address?: string; name?: string }

export type ImapEnvelope = {
  subject?: string
  from?: PostalAddress[]
  to?: PostalAddress[]
}

export type ParsedEnvelopeMeta = {
  uid: number
  messageId: string | null
  inReplyTo: string | null
  refsList: string[]
  fromAddr: string
  toAddr: string
  ccAddr: string | null
  bccAddr: string | null
  subject: string
  date: Date
  externalId: string
  isDraft: boolean
}

export type DraftIngestContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any }
  client: ImapFlow
  imapAccountId: string
  orgId: string
  host: string
  accountEmail: string
  ourAddressesSet: Set<string>
  refMap: Map<string, string>
  subjectThreadMap: Map<string, string>
  logPrefix: string
}

export function scoreDraftEnvelopeMatch(
  fromAddr: string,
  toAddr: string,
  subject: string,
  envelope: ImapEnvelope,
  threadSubjectNorm: string,
): number {
  let score = 0
  const envSubject = normalizeSubject(envelope.subject ?? '')
  if (threadSubjectNorm && envSubject) {
    if (envSubject === threadSubjectNorm) score += 4
    else if (envSubject.includes(threadSubjectNorm) || threadSubjectNorm.includes(envSubject)) score += 2
  }
  const msgSubject = normalizeSubject(subject)
  if (msgSubject && envSubject && msgSubject === envSubject) score += 3

  const dbFrom = normalizeEmail(fromAddr)
  const envFrom = normalizeEmail(envelope.from?.[0]?.address ?? '')
  if (dbFrom && envFrom && dbFrom === envFrom) score += 2

  const dbToParts = toAddr.split(',').map((s) => normalizeEmail(s)).filter(Boolean)
  const envToParts = (envelope.to ?? []).map((a) => normalizeEmail(a.address ?? '')).filter(Boolean)
  if (dbToParts.length && envToParts.length) {
    const overlap = dbToParts.filter((t) => envToParts.includes(t)).length
    if (overlap === dbToParts.length || overlap === envToParts.length) score += 2
    else if (overlap > 0) score += 1
  }
  return score
}

function scoreSentSubjectOnly(threadSubjectNorm: string, envelope: ImapEnvelope): number {
  const envSubject = normalizeSubject(envelope.subject ?? '')
  if (!threadSubjectNorm || !envSubject) return 0
  if (envSubject === threadSubjectNorm) return 4
  if (envSubject.includes(threadSubjectNorm) || threadSubjectNorm.includes(envSubject)) return 2
  return 0
}

/** Sent heal scoring: subject match alone is enough when from/to are absent or unhelpful. */
export function scoreSentEnvelopeMatch(
  fromAddr: string,
  toAddr: string,
  subject: string,
  envelope: ImapEnvelope,
  threadSubjectNorm: string,
): number {
  const subjectScore = scoreSentSubjectOnly(threadSubjectNorm, envelope)
  const hasFrom = !!normalizeEmail(fromAddr)
  const hasTo = !!toAddr.trim()
  if (!hasFrom && !hasTo) return subjectScore
  const fullScore = scoreDraftEnvelopeMatch(fromAddr, toAddr, subject, envelope, threadSubjectNorm)
  return Math.max(fullScore, subjectScore)
}

export class DraftsEnvelopeCache {
  private envelopes: Array<{ uid: number; envelope: ImapEnvelope }> | null = null
  private lock: { release: () => Promise<void> } | null = null
  /** True after Drafts mailbox was opened and enumerated (including empty). False on IMAP failure. */
  private verified = false

  constructor(
    private client: ImapFlow,
    private host: string,
  ) {}

  /** Whether the provider Drafts mailbox was checked successfully this session. */
  async wasVerified(): Promise<boolean> {
    await this.ensureLoaded()
    return this.verified
  }

  async findMatchingDraft(
    fromAddr: string,
    toAddr: string,
    subject: string,
    threadSubjectNorm: string,
  ): Promise<{ uid: number; score: number } | null> {
    await this.ensureLoaded()
    if (!this.envelopes?.length) return null

    const scored = this.envelopes
      .map((c) => ({
        uid: c.uid,
        score: scoreDraftEnvelopeMatch(fromAddr, toAddr, subject, c.envelope, threadSubjectNorm),
      }))
      .filter((c) => c.score >= DRAFT_MATCH_MIN_SCORE)
      .sort((a, b) => b.score - a.score || b.uid - a.uid)

    return scored[0] ?? null
  }

  private async ensureLoaded(): Promise<void> {
    if (this.envelopes) return
    const draftsPath = getDraftsMailboxPath(this.host)
    this.lock = await this.client.getMailboxLock(draftsPath)
    try {
      const status = await this.client.status(draftsPath, { uidNext: true, messages: true })
      const uidNext = (status?.uidNext as number) ?? 1
      const msgCount = (status?.messages as number) ?? 0
      if (msgCount === 0) {
        this.envelopes = []
        this.verified = true
        return
      }
      const start = Math.max(1, uidNext - RECENT_DRAFTS_LIMIT)
      const rows = await this.client.fetchAll(`${start}:*`, { envelope: true, uid: true }, { uid: true })
      this.envelopes = rows.map((e) => ({
        uid: e.uid as number,
        envelope: (e.envelope ?? {}) as ImapEnvelope,
      }))
      this.verified = true
    } catch (err) {
      console.log('[inboxGmailDraftIngest] recent drafts envelope fetch failed', { error: (err as Error).message })
      this.envelopes = []
      this.verified = false
    }
  }

  async release(): Promise<void> {
    if (this.lock) {
      try { await this.lock.release() } catch { /* connection may be dead */ }
      this.lock = null
    }
  }
}

export class SentEnvelopeCache {
  private envelopes: Array<{ uid: number; envelope: ImapEnvelope; date: Date | null }> | null = null
  private lock: { release: () => Promise<void> } | null = null
  private verified = false
  private mailboxPath: string | null = null

  constructor(
    private client: ImapFlow,
    private host: string,
  ) {}

  /** Resolved Sent mailbox path after ensureLoaded(); null if unresolved or failed. */
  getMailboxPath(): string | null {
    return this.mailboxPath
  }

  async wasVerified(): Promise<boolean> {
    await this.ensureLoaded()
    return this.verified
  }

  async findMatchingSent(
    fromAddr: string,
    toAddr: string,
    subject: string,
    threadSubjectNorm: string,
  ): Promise<{ uid: number; score: number; envelope: ImapEnvelope } | null> {
    await this.ensureLoaded()
    if (!this.envelopes?.length) return null

    const scored = this.envelopes
      .map((c) => ({
        uid: c.uid,
        envelope: c.envelope,
        date: c.date,
        score: scoreSentEnvelopeMatch(fromAddr, toAddr, subject, c.envelope, threadSubjectNorm),
      }))
      .filter((c) => c.score >= DRAFT_MATCH_MIN_SCORE)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        const aTime = a.date?.getTime() ?? 0
        const bTime = b.date?.getTime() ?? 0
        if (bTime !== aTime) return bTime - aTime
        return b.uid - a.uid
      })

    return scored[0] ?? null
  }

  /** Explicit recovery fallback: latest Sent item when subject/address scoring failed. */
  async findLatestSent(): Promise<{ uid: number; score: number; envelope: ImapEnvelope } | null> {
    await this.ensureLoaded()
    if (!this.envelopes?.length) return null
    const latest = [...this.envelopes]
      .sort((a, b) => {
        const aTime = a.date?.getTime() ?? 0
        const bTime = b.date?.getTime() ?? 0
        if (bTime !== aTime) return bTime - aTime
        return b.uid - a.uid
      })[0]
    return latest ? { uid: latest.uid, score: 1, envelope: latest.envelope } : null
  }


  private async ensureLoaded(): Promise<void> {
    if (this.envelopes) return

    const sentPath = await resolveSentMailboxPath(this.client, this.host)
    if (!sentPath) {
      console.log('[inboxGmailDraftIngest] could not resolve Sent mailbox', { host: this.host })
      this.envelopes = []
      this.mailboxPath = null
      this.verified = false
      return
    }
    this.mailboxPath = sentPath

    this.lock = await this.client.getMailboxLock(sentPath)
    try {
      const status = await this.client.status(sentPath, { uidNext: true, messages: true })
      const uidNext = (status?.uidNext as number) ?? 1
      const msgCount = (status?.messages as number) ?? 0
      if (msgCount === 0) {
        this.envelopes = []
        this.verified = true
        return
      }
      const start = Math.max(1, uidNext - RECENT_SENT_LIMIT)
      const rows = await this.client.fetchAll(`${start}:*`, { envelope: true, uid: true }, { uid: true })
      this.envelopes = rows.map((e) => {
        const env = (e.envelope ?? {}) as ImapEnvelope & { date?: Date }
        return {
          uid: e.uid as number,
          envelope: env,
          date: env.date ? new Date(env.date) : null,
        }
      })
      this.verified = true
      console.log('[inboxGmailDraftIngest] loaded recent Sent envelopes', {
        mailboxPath: sentPath,
        count: this.envelopes.length,
      })
    } catch (err) {
      console.log('[inboxGmailDraftIngest] recent sent envelope fetch failed', {
        mailboxPath: sentPath,
        error: (err as Error).message,
      })
      this.envelopes = []
      this.verified = false
    }
  }

  async release(): Promise<void> {
    if (this.lock) {
      try { await this.lock.release() } catch { /* connection may be dead */ }
      this.lock = null
    }
  }
}

function resolveThreadId(ctx: DraftIngestContext, p: ParsedEnvelopeMeta): string | undefined {
  const direction = ctx.ourAddressesSet.has(normalizeEmail(p.fromAddr)) ? 'outbound' : 'inbound'
  const mailboxAddress = deriveMailboxAddress(direction, p.toAddr, p.fromAddr, ctx.accountEmail)
  return resolveThreadIdFromMaps({
    inReplyTo: p.inReplyTo,
    refsList: p.refsList,
    subject: p.subject,
    mailboxAddress,
    refMap: ctx.refMap,
    subjectThreadMap: ctx.subjectThreadMap,
  })
}

async function threadHasRecentSentOutbound(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  imapAccountId: string,
  threadId: string,
  cutoffIso: string,
  excludeUid?: number,
): Promise<boolean> {
  const { data: rows } = await service.from('inbox_messages')
    .select('id, external_uid')
    .eq('thread_id', threadId)
    .eq('imap_account_id', imapAccountId)
    .eq('direction', 'outbound')
    .eq('is_draft', false)
    .gte('received_at', cutoffIso)
    .limit(5)

  if (!rows?.length) return false
  if (excludeUid == null) return true
  return (rows as { id: string; external_uid: number | null }[]).some(
    (r) => r.external_uid != null && r.external_uid !== excludeUid,
  )
}

async function fetchParsedBodyFromMailbox(
  client: ImapFlow,
  mailboxPath: string,
  uid: number,
): Promise<{ body: string | null; htmlBody: string | null } | null> {
  let lock: { release: () => Promise<void> } | null = null
  try {
    lock = await client.getMailboxLock(mailboxPath)
    const fetched = await client.fetchAll(String(uid), { source: true, uid: true }, { uid: true })
    const source = fetched[0]?.source as Uint8Array | undefined
    if (!source) return null
    const parsed = await PostalMime.parse(source)
    let bodyText = (parsed.text ?? '').trim() || null
    let htmlBody = normalizeDraftHtml(parsed.html ?? null)
    if (bodyText && bodyText.length > MAX_BODY_LENGTH) bodyText = bodyText.slice(0, MAX_BODY_LENGTH)
    if (htmlBody && htmlBody.length > MAX_BODY_LENGTH) htmlBody = htmlBody.slice(0, MAX_BODY_LENGTH)
    if (!bodyText && htmlBody) {
      bodyText = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_LENGTH) || null
    }
    return { body: bodyText, htmlBody }
  } catch (err) {
    console.log('[inboxGmailDraftIngest] body fetch failed', { uid, mailboxPath, error: (err as Error).message })
    return null
  } finally {
    if (lock) {
      try { await lock.release() } catch { /* ignore */ }
    }
  }
}

type DraftRow = {
  id: string
  is_draft?: boolean | null
  from_identifier: string
  to_identifier: string | null
  external_uid?: number | null
}

function pickMatchingDraftRow(
  rows: DraftRow[],
  fromAddr: string,
  toAddr: string,
): DraftRow | undefined {
  return rows.find((dr) =>
    normalizeEmail(dr.from_identifier) === normalizeEmail(fromAddr)
    && recipientsOverlap(dr.to_identifier, toAddr),
  )
}

/**
 * Handle Gmail draft envelopes (\Draft) or draftless All Mail revisions.
 * Returns true when the message was handled as a draft (caller must skip touch/insert/sent dedup).
 */
export async function handleGmailDraftRevision(
  ctx: DraftIngestContext,
  p: ParsedEnvelopeMeta,
  draftsCache: DraftsEnvelopeCache,
  options: { hasDraftFlag: boolean },
): Promise<boolean> {
  if (!isGmailHost(ctx.host)) return false

  const direction = ctx.ourAddressesSet.has(normalizeEmail(p.fromAddr)) ? 'outbound' : 'inbound'
  if (direction !== 'outbound') return false

  // Only treat draftless All Mail copies as drafts when they look like draft revisions.
  if (!options.hasDraftFlag && p.isDraft) return false
  if (options.hasDraftFlag && !p.isDraft) return false

  const draftCutoff = new Date(p.date.getTime() - DRAFT_SENT_WINDOW_MS).toISOString()
  const threadId = resolveThreadId(ctx, p)
  const threadSubjectNorm = normalizeSubject(p.subject)

  if (threadId) {
    const hasSent = await threadHasRecentSentOutbound(
      ctx.service,
      ctx.imapAccountId,
      threadId,
      draftCutoff,
      options.hasDraftFlag ? undefined : p.uid,
    )
    if (hasSent) {
      console.log(ctx.logPrefix, 'skip draft revision — thread already has sent outbound', { uid: p.uid, threadId })
      return options.hasDraftFlag
    }
  }

  let draftRow: DraftRow | undefined
  if (threadId) {
    const { data: draftRows } = await ctx.service.from('inbox_messages')
      .select('id, is_draft, from_identifier, to_identifier, external_uid')
      .eq('thread_id', threadId)
      .eq('imap_account_id', ctx.imapAccountId)
      .eq('direction', 'outbound')
      .eq('is_draft', true)

    draftRow = pickMatchingDraftRow((draftRows ?? []) as DraftRow[], p.fromAddr, p.toAddr)
  }

  const draftsMatch = await draftsCache.findMatchingDraft(
    p.fromAddr,
    p.toAddr,
    p.subject,
    threadSubjectNorm,
  )

  if (!draftRow && !draftsMatch) {
    // Envelopes with \Draft must never be ingested as sent even without a DB/Drafts match.
    return options.hasDraftFlag
  }

  const draftsUid = draftsMatch?.uid ?? null
  const storeUid = draftsUid ?? p.uid

  let bodyPayload: { body: string | null; htmlBody: string | null } | null = null
  if (draftsUid != null) {
    bodyPayload = await fetchParsedBodyFromMailbox(
      ctx.client,
      getDraftsMailboxPath(ctx.host),
      draftsUid,
    )
  }
  if (!bodyPayload?.body && !bodyPayload?.htmlBody) {
    const allMailPath = isGmailHost(ctx.host) ? '[Gmail]/All Mail' : 'INBOX'
    bodyPayload = await fetchParsedBodyFromMailbox(ctx.client, allMailPath, p.uid)
  }

  const updateFields: Record<string, unknown> = {
    external_id: p.externalId,
    external_uid: storeUid,
    is_draft: true,
  }
  if (bodyPayload?.body) updateFields.body = bodyPayload.body
  if (bodyPayload?.htmlBody) updateFields.html_body = bodyPayload.htmlBody

  if (draftRow) {
    console.log(ctx.logPrefix, 'update existing draft row for Gmail revision', {
      rowId: draftRow.id,
      uid: p.uid,
      storeUid,
      threadId,
    })
    await ctx.service.from('inbox_messages')
      .update(updateFields)
      .eq('id', draftRow.id)
      .eq('is_draft', true)
    return true
  }

  if (!threadId) {
    console.log(ctx.logPrefix, 'draft revision matched Drafts mailbox but no thread — skip insert', { uid: p.uid })
    return true
  }

  // Convert phantom outbound non-draft row or insert fresh draft row.
  const { data: phantoms } = await ctx.service.from('inbox_messages')
    .select('id, from_identifier, to_identifier, is_draft')
    .eq('thread_id', threadId)
    .eq('imap_account_id', ctx.imapAccountId)
    .eq('direction', 'outbound')
    .eq('is_draft', false)

  const phantom = pickMatchingDraftRow((phantoms ?? []) as DraftRow[], p.fromAddr, p.toAddr)
  if (phantom) {
    console.log(ctx.logPrefix, 'convert phantom outbound row to draft', {
      rowId: phantom.id,
      uid: p.uid,
      storeUid,
      threadId,
    })
    await ctx.service.from('inbox_messages')
      .update(updateFields)
      .eq('id', phantom.id)
    return true
  }

  console.log(ctx.logPrefix, 'insert Gmail draft revision row', { uid: p.uid, storeUid, threadId })
  await ctx.service.from('inbox_messages').insert({
    thread_id: threadId,
    channel: 'email',
    direction: 'outbound',
    from_identifier: p.fromAddr,
    to_identifier: p.toAddr,
    cc: p.ccAddr ?? null,
    bcc: p.bccAddr ?? null,
    body: bodyPayload?.body ?? null,
    html_body: bodyPayload?.htmlBody ?? null,
    external_id: p.externalId,
    external_uid: storeUid,
    imap_account_id: ctx.imapAccountId,
    received_at: p.date.toISOString(),
    is_draft: true,
  })
  return true
}

/** Re-classify an existing DB row (same external_uid) that was ingested as sent but matches Drafts. */
export async function healExistingUidPhantomIfNeeded(
  ctx: DraftIngestContext,
  p: ParsedEnvelopeMeta,
  draftsCache: DraftsEnvelopeCache,
): Promise<boolean> {
  if (!isGmailHost(ctx.host)) return false
  if (p.isDraft) return false
  const direction = ctx.ourAddressesSet.has(normalizeEmail(p.fromAddr)) ? 'outbound' : 'inbound'
  if (direction !== 'outbound') return false

  const { data: existingRow } = await ctx.service.from('inbox_messages')
    .select('id, is_draft, thread_id, from_identifier, to_identifier, body, html_body')
    .eq('imap_account_id', ctx.imapAccountId)
    .eq('external_uid', p.uid)
    .maybeSingle()

  const row = existingRow as {
    id: string
    is_draft?: boolean | null
    thread_id: string
    from_identifier: string
    to_identifier: string | null
    body: string | null
    html_body: string | null
  } | null

  if (!row || row.is_draft) return false

  const { data: draftSiblings } = await ctx.service.from('inbox_messages')
    .select('id')
    .eq('thread_id', row.thread_id)
    .eq('is_draft', true)
    .limit(1)
  if (draftSiblings?.length) return false

  const threadSubjectNorm = normalizeSubject(p.subject)
  const draftsMatch = await draftsCache.findMatchingDraft(
    p.fromAddr,
    p.toAddr,
    p.subject,
    threadSubjectNorm,
  )
  if (!draftsMatch) return false

  const healed = await healPhantomOutboundAsDraft(
    ctx.service,
    ctx.client,
    ctx.host,
    row.thread_id,
    {
      id: row.id,
      external_uid: p.uid,
      from_identifier: row.from_identifier,
      to_identifier: row.to_identifier,
      body: row.body,
      html_body: row.html_body,
    },
    threadSubjectNorm,
    draftsCache,
  )
  if (healed.healed) {
    console.log(ctx.logPrefix, 'healed existing UID phantom as draft', { rowId: row.id, uid: p.uid })
  }
  return healed.healed
}

/** Self-heal: outbound non-draft row that matches a server Drafts message → is_draft true. */
export async function healPhantomOutboundAsDraft(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  client: ImapFlow,
  host: string,
  threadId: string,
  row: {
    id: string
    external_uid: number
    from_identifier: string
    to_identifier: string | null
    body: string | null
    html_body: string | null
  },
  threadSubjectNorm: string,
  draftsCache: DraftsEnvelopeCache,
): Promise<{ healed: boolean; body: string | null; htmlBody: string | null }> {
  const match = await draftsCache.findMatchingDraft(
    row.from_identifier,
    row.to_identifier ?? '',
    threadSubjectNorm,
    threadSubjectNorm,
  )
  if (!match) return { healed: false, body: row.body, htmlBody: row.html_body }

  const draftsUid = match.uid
  let bodyPayload = await fetchParsedBodyFromMailbox(client, getDraftsMailboxPath(host), draftsUid)
  if (!bodyPayload?.body && !bodyPayload?.htmlBody) {
    const allMailPath = isGmailHost(host) ? '[Gmail]/All Mail' : 'INBOX'
    bodyPayload = await fetchParsedBodyFromMailbox(client, allMailPath, row.external_uid)
  }

  const updateFields: Record<string, unknown> = {
    is_draft: true,
    external_uid: draftsUid,
  }
  if (bodyPayload?.body) updateFields.body = bodyPayload.body
  if (bodyPayload?.htmlBody) updateFields.html_body = bodyPayload.htmlBody

  const { error: updErr } = await service.from('inbox_messages')
    .update(updateFields)
    .eq('id', row.id)

  if (updErr) {
    console.log('[inboxGmailDraftIngest] phantom heal update failed', { rowId: row.id, error: updErr.message })
    return { healed: false, body: row.body, htmlBody: row.html_body }
  }

  // Re-open thread closed by mistaken outbound touch.
  await service.from('inbox_threads')
    .update({ status: 'open', updated_at: new Date().toISOString() })
    .eq('id', threadId)
    .eq('status', 'closed')

  console.log('[inboxGmailDraftIngest] healed phantom outbound as draft', { rowId: row.id, draftsUid })
  return {
    healed: true,
    body: (bodyPayload?.body ?? row.body) as string | null,
    htmlBody: (bodyPayload?.htmlBody ?? row.html_body) as string | null,
  }
}

/** True when thread still has a local is_draft row (optional account scope). */
export async function threadHasDraftRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  threadId: string,
  imapAccountId?: string,
): Promise<boolean> {
  let q = service.from('inbox_messages').select('id').eq('thread_id', threadId).eq('is_draft', true).limit(1)
  if (imapAccountId) q = q.eq('imap_account_id', imapAccountId)
  const { data } = await q
  return !!data?.length
}

/**
 * Skip archive / stale-UID cleanup when drafts exist locally or a likely Drafts mailbox match exists.
 */
export async function shouldSkipArchiveForDrafts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  draftsCache: DraftsEnvelopeCache,
  host: string,
  threadId: string,
  imapAccountId: string,
  threadSubject: string | null,
  fromAddress: string | null,
): Promise<boolean> {
  if (await threadHasDraftRow(service, threadId, imapAccountId)) return true
  if (!isGmailHost(host)) return false
  const threadSubjectNorm = normalizeSubject(threadSubject ?? '')
  const match = await draftsCache.findMatchingDraft(
    fromAddress ?? '',
    '',
    threadSubject ?? '',
    threadSubjectNorm,
  )
  return match != null
}

export type EmptyThreadDraftHealRow = {
  id: string
  subject: string | null
  from_address: string | null
  status?: string | null
  mailbox_address?: string | null
}

/**
 * Self-heal: empty thread with a matching Gmail Drafts message → insert is_draft row and reopen thread.
 */
export async function healEmptyThreadFromDrafts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  client: ImapFlow,
  host: string,
  imapAccountId: string,
  orgId: string,
  thread: EmptyThreadDraftHealRow,
  draftsCache?: DraftsEnvelopeCache,
  logPrefix = '[inboxGmailDraftIngest]',
): Promise<{ healed: boolean; messageId?: string }> {
  if (!isGmailHost(host)) return { healed: false }

  const { count } = await service.from('inbox_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', thread.id)
  if ((count ?? 0) > 0) return { healed: false }

  const ownCache = draftsCache ?? new DraftsEnvelopeCache(client, host)
  const threadSubjectNorm = normalizeSubject(thread.subject ?? '')
  const fromAddr = (thread.from_address ?? '').trim()
  const match = await ownCache.findMatchingDraft(fromAddr, '', thread.subject ?? '', threadSubjectNorm)
  if (!match) {
    if (!draftsCache) await ownCache.release()
    return { healed: false }
  }

  // Release the Drafts mailbox lock before fetching source/envelope for the match.
  // Holding the cache lock while re-locking the same mailbox deadlocks on ImapFlow and
  // was the cause of the targeted heal timing out in Edge.
  await ownCache.release()

  const bodyPayload = await fetchParsedBodyFromMailbox(client, getDraftsMailboxPath(host), match.uid)
  const draftsPath = getDraftsMailboxPath(host)
  let toAddr = ''
  const receivedAt = new Date().toISOString()
  try {
    const lock = await client.getMailboxLock(draftsPath)
    try {
      const fetched = await client.fetchAll(String(match.uid), { envelope: true, uid: true }, { uid: true })
      const env = fetched[0]?.envelope as ImapEnvelope | undefined
      if (env?.to?.length) {
        toAddr = env.to.map((a) => a.address ?? '').filter(Boolean).join(', ')
      }
    } finally {
      try { await lock.release() } catch { /* ignore */ }
    }
  } catch (err) {
    console.log(logPrefix, 'empty-thread draft heal envelope fetch failed', { threadId: thread.id, error: (err as Error).message })
  }

  const { data: inserted, error: insErr } = await service.from('inbox_messages')
    .insert({
      thread_id: thread.id,
      channel: 'email',
      direction: 'outbound',
      from_identifier: fromAddr || thread.mailbox_address || '',
      to_identifier: toAddr || null,
      cc: null,
      bcc: null,
      body: bodyPayload?.body ?? null,
      html_body: bodyPayload?.htmlBody ?? null,
      external_id: `draft-heal-${imapAccountId}-${match.uid}`,
      external_uid: match.uid,
      imap_account_id: imapAccountId,
      received_at: receivedAt,
      is_draft: true,
    })
    .select('id')
    .single()

  if (insErr || !inserted) {
    console.log(logPrefix, 'empty-thread draft heal insert failed', { threadId: thread.id, error: insErr?.message })
    return { healed: false }
  }

  const msgId = (inserted as { id: string }).id
  const touchPayload: Record<string, unknown> = {
    last_message_at: receivedAt,
    updated_at: new Date().toISOString(),
  }
  if (thread.status === 'archived' || thread.status === 'closed') {
    touchPayload.status = 'open'
  }
  await service.from('inbox_threads').update(touchPayload).eq('id', thread.id)

  console.log(logPrefix, 'healed empty thread from Gmail Drafts', {
    threadId: thread.id,
    messageId: msgId,
    draftsUid: match.uid,
    score: match.score,
    orgId,
  })
  return { healed: true, messageId: msgId }
}

function normalizeMessageIdHeader(id: string | null | undefined): string | null {
  if (!id?.trim()) return null
  const s = id.trim().replace(/^</, '').replace(/>$/, '').trim()
  return s || null
}

/**
 * Self-heal: empty thread with a matching Sent mailbox message → insert outbound sent row and close thread.
 */
export async function healEmptyThreadFromSentMail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }> },
  client: ImapFlow,
  host: string,
  imapAccountId: string,
  orgId: string,
  thread: EmptyThreadDraftHealRow,
  sentCache?: SentEnvelopeCache,
  logPrefix = '[inboxGmailDraftIngest]',
): Promise<{ healed: boolean; messageId?: string }> {
  const { data: existingMsgs } = await service.from('inbox_messages')
    .select('id, is_draft')
    .eq('thread_id', thread.id)
  if (existingMsgs?.length) {
    const allDrafts = (existingMsgs as { is_draft?: boolean | null }[]).every((m) => m.is_draft)
    if (!allDrafts) return { healed: false }
  }

  const { data: accRow } = await service.from('imap_accounts')
    .select('email')
    .eq('id', imapAccountId)
    .maybeSingle()
  const accountEmail = ((accRow as { email?: string } | null)?.email ?? '').trim()

  const ownCache = sentCache ?? new SentEnvelopeCache(client, host)
  const threadSubjectNorm = normalizeSubject(thread.subject ?? '')
  const fromAddr = accountEmail || (thread.from_address ?? '').trim()
  let matchFromAddr = (thread.from_address ?? '').trim()
  let matchToAddr = (thread.mailbox_address ?? '').trim()
  if (matchToAddr && accountEmail && normalizeEmail(matchToAddr) === normalizeEmail(accountEmail)) {
    matchToAddr = ''
  }
  if (!matchFromAddr && accountEmail) matchFromAddr = accountEmail
  if (matchFromAddr && matchToAddr && normalizeEmail(matchFromAddr) === normalizeEmail(matchToAddr)) {
    matchToAddr = ''
  }

  let match = await ownCache.findMatchingSent(
    matchFromAddr,
    matchToAddr,
    thread.subject ?? '',
    threadSubjectNorm,
  )
  if (!match) {
    // This helper is only used by explicit empty-thread Sent recovery paths. If Gmail
    // label/address metadata is missing or normalized differently, use the newest
    // Sent message as a last-resort recovery instead of leaving the thread empty.
    match = await ownCache.findLatestSent()
    if (match) {
      console.log(logPrefix, 'empty-thread sent heal using latest Sent fallback', {
        threadId: thread.id,
        sentUid: match.uid,
        subject: match.envelope.subject ?? null,
      })
    }
  }
  if (!match) {
    if (!sentCache) await ownCache.release()
    return { healed: false }
  }

  const sentPath = ownCache.getMailboxPath()
  if (!sentPath) {
    if (!sentCache) await ownCache.release()
    console.log(logPrefix, 'empty-thread sent heal skipped — Sent mailbox unresolved', { threadId: thread.id })
    return { healed: false }
  }

  // Release the Sent mailbox lock before fetching source/envelope for the match.
  // Re-entering getMailboxLock on the same mailbox while the cache owns it will hang.
  await ownCache.release()

  const bodyPayload = await fetchParsedBodyFromMailbox(client, sentPath, match.uid)

  let toIdentifier = ''
  let fromIdentifier = fromAddr || accountEmail
  let receivedAt = new Date().toISOString()
  let externalId = `sent-heal-${imapAccountId}-${match.uid}`

  try {
    const lock = await client.getMailboxLock(sentPath)
    try {
      const fetched = await client.fetchAll(
        String(match.uid),
        { envelope: true, headers: ['message-id'], uid: true },
        { uid: true },
      )
      const env = fetched[0]?.envelope as ImapEnvelope | undefined
      if (env?.to?.length) {
        toIdentifier = env.to.map((a) => a.address ?? '').filter(Boolean).join(', ')
      }
      if (env?.from?.length) {
        const envFrom = env.from.map((a) => a.address ?? '').filter(Boolean).join(', ')
        if (envFrom) fromIdentifier = envFrom
      }
      const envDate = (fetched[0]?.envelope as { date?: Date } | undefined)?.date
      if (envDate) receivedAt = new Date(envDate).toISOString()

      const rawHdrs = fetched[0]?.headers ? new TextDecoder().decode(fetched[0].headers as Uint8Array) : ''
      const msgIdMatch = rawHdrs.match(/^message-id:\s*(.+)/im)
      const messageId = normalizeMessageIdHeader(msgIdMatch?.[1] ?? null)
      if (messageId) externalId = messageId
    } finally {
      try { await lock.release() } catch { /* ignore */ }
    }
  } catch (err) {
    console.log(logPrefix, 'empty-thread sent heal envelope fetch failed', { threadId: thread.id, error: (err as Error).message })
    if (match.envelope.to?.length) {
      toIdentifier = match.envelope.to.map((a) => a.address ?? '').filter(Boolean).join(', ')
    }
    if (match.envelope.from?.length) {
      const envFrom = match.envelope.from.map((a) => a.address ?? '').filter(Boolean).join(', ')
      if (envFrom) fromIdentifier = envFrom
    }
  }

  if (!fromIdentifier) fromIdentifier = fromAddr || accountEmail

  const { data: inserted, error: insErr } = await service.from('inbox_messages')
    .insert({
      thread_id: thread.id,
      channel: 'email',
      direction: 'outbound',
      from_identifier: fromIdentifier,
      to_identifier: toIdentifier || null,
      cc: null,
      bcc: null,
      body: bodyPayload?.body ?? null,
      html_body: bodyPayload?.htmlBody ?? null,
      external_id: externalId,
      // Gmail UIDs are mailbox-scoped. A Sent UID can collide with an All Mail/INBOX UID
      // already stored for the same account, so do not persist it in the shared external_uid column.
      external_uid: null,
      imap_account_id: imapAccountId,
      received_at: receivedAt,
      is_draft: false,
    })
    .select('id')
    .single()

  if (insErr || !inserted) {
    console.log(logPrefix, 'empty-thread sent heal insert failed', { threadId: thread.id, error: insErr?.message })
    return { healed: false }
  }

  await service.from('inbox_messages')
    .delete()
    .eq('thread_id', thread.id)
    .eq('is_draft', true)

  const msgId = (inserted as { id: string }).id

  if (service.rpc) {
    const { error: touchErr } = await service.rpc('touch_inbox_thread_on_new_message', {
      p_thread_id: thread.id,
      p_last_message_at: receivedAt,
      p_is_inbound: false,
    })
    if (touchErr) {
      console.log(logPrefix, 'empty-thread sent heal touch failed', { threadId: thread.id, error: touchErr.message })
    }
  }

  const threadUpdates: Record<string, unknown> = { imap_account_id: imapAccountId }
  if (!thread.mailbox_address && accountEmail) {
    threadUpdates.mailbox_address = normalizeEmail(accountEmail)
  }
  await service.from('inbox_threads').update(threadUpdates).eq('id', thread.id)

  console.log(logPrefix, 'healed empty thread from Sent Mail', {
    threadId: thread.id,
    messageId: msgId,
    sentUid: match.uid,
    sentMailboxPath: sentPath,
    score: match.score,
    orgId,
  })
  return { healed: true, messageId: msgId }
}

/** Heal recent empty threads for an account (sync-time, no UI required). */
export async function healRecentEmptyThreadsFromDrafts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { from: (table: string) => any },
  client: ImapFlow,
  host: string,
  imapAccountId: string,
  orgId: string,
  logPrefix: string,
  limit = 5,
): Promise<number> {
  if (!isGmailHost(host)) return 0

  const { data: candidates } = await service.from('inbox_threads')
    .select('id, subject, from_address, status, mailbox_address')
    .eq('imap_account_id', imapAccountId)
    .eq('org_id', orgId)
    .eq('channel', 'email')
    .gte('last_message_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('last_message_at', { ascending: false })
    .limit(Math.min(limit * 3, 15))

  if (!candidates?.length) return 0

  const draftsCache = new DraftsEnvelopeCache(client, host)
  let healedCount = 0
  try {
    for (const row of candidates as EmptyThreadDraftHealRow[]) {
      if (healedCount >= limit) break
      const result = await healEmptyThreadFromDrafts(
        service,
        client,
        host,
        imapAccountId,
        orgId,
        row,
        draftsCache,
        logPrefix,
      )
      if (result.healed) healedCount++
    }
  } finally {
    await draftsCache.release()
  }
  return healedCount
}
