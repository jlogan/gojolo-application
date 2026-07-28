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
export const DRAFT_MATCH_MIN_SCORE = 2
const DRAFT_SENT_WINDOW_MS = 5 * 60 * 1000
const MAX_BODY_LENGTH = 50000

export function isGmailHost(host: string): boolean {
  return host.toLowerCase().includes('gmail.com')
}

export function getDraftsMailboxPath(host: string): string {
  return isGmailHost(host) ? '[Gmail]/Drafts' : 'Drafts'
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

export class DraftsEnvelopeCache {
  private envelopes: Array<{ uid: number; envelope: ImapEnvelope }> | null = null
  private lock: { release: () => Promise<void> } | null = null

  constructor(
    private client: ImapFlow,
    private host: string,
  ) {}

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
        return
      }
      const start = Math.max(1, uidNext - RECENT_DRAFTS_LIMIT)
      const rows = await this.client.fetchAll(`${start}:*`, { envelope: true, uid: true }, { uid: true })
      this.envelopes = rows.map((e) => ({
        uid: e.uid as number,
        envelope: (e.envelope ?? {}) as ImapEnvelope,
      }))
    } catch (err) {
      console.log('[inboxGmailDraftIngest] recent drafts envelope fetch failed', { error: (err as Error).message })
      this.envelopes = []
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
