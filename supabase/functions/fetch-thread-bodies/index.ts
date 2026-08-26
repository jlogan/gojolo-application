/**
 * Fetches email bodies (and attachments) for all messages in a thread, and reconciles DB drafts.
 * - If body already exists in DB: returns from database
 * - If body/html empty (non-draft): fetches from IMAP All Mail/INBOX (by external_uid), parses, stores body + attachments
 * - For is_draft rows: verifies each still exists in the provider Drafts mailbox; tries external_uid first,
 *   then searches recent Drafts messages by subject/recipients/body snippet; refreshes body and external_uid
 *   when matched, or deletes the DB row only when Drafts was checked successfully and no likely match exists
 * - Empty threads: attempts self-heal from Gmail Drafts, then Sent Mail, before returning
 *
 * POST { threadId } — returns { messages: [{ id, body, htmlBody, attachments, from_identifier?, to_identifier?, cc? }], deletedMessageIds?, hasMore? }
 * Requires: ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY. Auth: user must have access to thread's org.
 *
 * Limits: processes at most MAX_FETCH_PER_REQUEST non-draft body fetches per call to avoid 546 WORKER_LIMIT.
 * Client can call again; already-fetched messages will be returned from DB.
 */
const MAX_FETCH_PER_REQUEST = 15

import { createClient } from 'npm:@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import PostalMime from 'npm:postal-mime'
import { corsHeaders } from '../_shared/cors.ts'
import { normalizeEmail, normalizeSubject } from '../_shared/inboxThreadResolve.ts'
import {
  DraftsEnvelopeCache,
  getDraftsMailboxPath,
  healEmptyThreadFromDrafts,
  healEmptyThreadFromSentMail,
  healPhantomOutboundAsDraft,
  normalizeDraftHtml,
  scoreDraftEnvelopeMatch,
  RECENT_DRAFTS_LIMIT,
  DRAFT_MATCH_MIN_SCORE,
  type ImapEnvelope,
} from '../_shared/inboxGmailDraftIngest.ts'
import { isUnavailableBodyText, unavailableBodyText } from '../_shared/inboxBodyUnavailable.ts'
import {
  extractGmailIds,
  gmailIdMessageFields,
  syncThreadGmailIds,
  withGmailImapIdFetch,
} from '../_shared/inboxGmailIds.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

async function decrypt(ct: string, keyHex: string): Promise<string> {
  const kb = new Uint8Array(32)
  for (let i = 0; i < 32; i++) kb[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', kb, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 },
      key,
      combined.slice(12)
    )
  )
}

function jsonRes(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/**
 * Make a filename safe for a Supabase Storage object key. Spaces / special chars
 * silently break uploads. Original name kept in inbox_attachments.file_name.
 */

type PostalAddress = { address?: string; name?: string }

function asAddressList(addrs: unknown): PostalAddress[] {
  if (!addrs) return []
  if (Array.isArray(addrs)) {
    return addrs.filter((a): a is PostalAddress => !!a && typeof a === 'object' && !Array.isArray(a))
  }
  if (typeof addrs === 'object') return [addrs as PostalAddress]
  return []
}

function formatAddress(addr: unknown): string {
  if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return ''
  const a = addr as PostalAddress
  const address = typeof a.address === 'string' ? a.address.trim() : ''
  if (!address) return ''
  const name = typeof a.name === 'string' ? a.name.trim() : ''
  if (name) return `${name} <${address}>`
  return address
}

function formatAddressList(addrs: unknown): string | null {
  const list = asAddressList(addrs)
  if (!list.length) return null
  const formatted = list.map(formatAddress).filter(Boolean)
  return formatted.length ? formatted.join(', ') : null
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function bodySnippet(text: string | null | undefined, html: string | null | undefined, maxLen = 80): string {
  const raw = (text?.trim() || stripHtmlToText(html ?? '') || '').replace(/\s+/g, ' ').trim()
  return raw.slice(0, maxLen).toLowerCase()
}

function scoreDraftForRow(
  dbDraft: { from_identifier: string; to_identifier: string | null; subject?: string },
  envelope: ImapEnvelope,
  threadSubjectNorm: string,
): number {
  return scoreDraftEnvelopeMatch(
    dbDraft.from_identifier,
    dbDraft.to_identifier ?? '',
    dbDraft.subject ?? threadSubjectNorm,
    envelope,
    threadSubjectNorm,
  )
}

function bodySnippetsMatch(
  dbDraft: { body: string | null; html_body: string | null },
  parsed: { text?: string | null; html?: string | null },
): boolean {
  const dbSnip = bodySnippet(dbDraft.body, dbDraft.html_body, 60)
  const srvSnip = bodySnippet(parsed.text ?? null, parsed.html ?? null, 60)
  if (dbSnip.length < 15 || srvSnip.length < 15) return false
  return dbSnip === srvSnip || srvSnip.includes(dbSnip) || dbSnip.includes(srvSnip)
}

async function fetchRecentDraftEnvelopes(
  client: ImapFlow,
  draftsPath: string,
): Promise<{ envelopes: Array<{ uid: number; envelope: ImapEnvelope }>; verified: boolean }> {
  try {
    const status = await client.status(draftsPath, { uidNext: true, messages: true })
    const uidNext = (status?.uidNext as number) ?? 1
    const msgCount = (status?.messages as number) ?? 0
    if (msgCount === 0) return { envelopes: [], verified: true }
    const start = Math.max(1, uidNext - RECENT_DRAFTS_LIMIT)
    const envelopes = await client.fetchAll(`${start}:*`, { envelope: true, uid: true }, { uid: true })
    return {
      envelopes: envelopes.map((e) => ({
        uid: e.uid as number,
        envelope: (e.envelope ?? {}) as ImapEnvelope,
      })),
      verified: true,
    }
  } catch (err) {
    console.log('[fetch-thread-bodies] recent drafts envelope fetch failed', { error: (err as Error).message })
    return { envelopes: [], verified: false }
  }
}

function sanitizeStorageName(name: string): string {
  const base = (name || 'attachment')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .trim()
  const safe = base.length === 0 ? 'attachment' : base
  return safe.length > 180 ? safe.slice(0, 180) : safe
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const tStart = performance.now()

  const auth = req.headers.get('Authorization')
  if (!auth) return jsonRes({ error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const { threadId } = body as { threadId?: string }
  console.log('[fetch-thread-bodies] request', { threadId, t0: 0 })
  if (!threadId) return jsonRes({ error: 'threadId required' }, 400)

  const service = createClient(supabaseUrl, serviceKey)

  // Get thread and verify user has access
  const { data: thread, error: threadErr } = await service
    .from('inbox_threads')
    .select('id, org_id, subject, from_address, status, imap_account_id, mailbox_address')
    .eq('id', threadId)
    .single()
  if (threadErr || !thread) {
    console.log('[fetch-thread-bodies] thread not found', { threadId, error: threadErr?.message })
    return jsonRes({ error: 'Thread not found' }, 404)
  }

  const token = auth.replace('Bearer ', '')
  const { data: { user }, error: uErr } = await service.auth.getUser(token)
  if (uErr || !user?.id) {
    console.log('[fetch-thread-bodies] invalid token', { error: uErr?.message })
    return jsonRes({ error: 'Invalid token' }, 401)
  }
  console.log('[fetch-thread-bodies] auth ok', { userId: user.id, threadId, orgId: thread.org_id, elapsedMs: Math.round(performance.now() - tStart) })

  const { data: membership } = await service
    .from('organization_users')
    .select('user_id')
    .eq('org_id', thread.org_id)
    .eq('user_id', user.id)
    .limit(1)
  if (!membership?.length) {
    console.log('[fetch-thread-bodies] forbidden: no org access', { userId: user.id, orgId: thread.org_id })
    return jsonRes({ error: 'Forbidden: no access to this thread' }, 403)
  }

  // Get all messages for thread (ordered by received_at)
  let { data: messages, error: msgErr } = await service
    .from('inbox_messages')
    .select('id, external_uid, imap_account_id, thread_id, body, html_body, direction, is_draft, from_identifier, to_identifier, cc')
    .eq('thread_id', threadId)
    .order('received_at', { ascending: true })

  // Self-heal empty thread from Gmail Drafts when draft reconcile deleted the last row.
  if (!msgErr && (!messages || messages.length === 0) && encryptionKeyHex && encryptionKeyHex.length >= 64) {
    const threadRow = thread as {
      org_id: string
      subject: string | null
      from_address: string | null
      status: string | null
      imap_account_id: string | null
      mailbox_address: string | null
    }
    let healAccountId = threadRow.imap_account_id
    if (!healAccountId) {
      const { data: accPick } = await service.from('imap_accounts')
        .select('id').eq('org_id', threadRow.org_id).eq('is_active', true).limit(1)
      healAccountId = (accPick as { id: string }[] | null)?.[0]?.id ?? null
    }
    if (healAccountId) {
      const { data: acc } = await service
        .from('imap_accounts')
        .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
        .eq('id', healAccountId)
        .single()
      if (acc) {
        try {
          const password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
          const secure = (acc.imap_encryption as string) === 'ssl' || (acc.imap_encryption as string) === 'tls'
          const healClient = new ImapFlow({
            host: acc.host as string,
            port: Number(acc.port) || 993,
            secure,
            auth: { user: acc.imap_username as string, pass: password },
            logger: false,
          })
          await healClient.connect()
          const healThreadRow = {
            id: threadId,
            subject: threadRow.subject,
            from_address: threadRow.from_address,
            status: threadRow.status,
            mailbox_address: threadRow.mailbox_address,
          }
          let healResult = await healEmptyThreadFromDrafts(
            service,
            healClient,
            acc.host as string,
            healAccountId,
            threadRow.org_id,
            healThreadRow,
            undefined,
            '[fetch-thread-bodies]',
          )
          if (!healResult.healed) {
            healResult = await healEmptyThreadFromSentMail(
              service,
              healClient,
              acc.host as string,
              healAccountId,
              threadRow.org_id,
              healThreadRow,
              undefined,
              '[fetch-thread-bodies]',
            )
          }
          await healClient.logout().catch(() => { try { healClient.close() } catch { /* ignore */ } })
          if (healResult.healed) {
            const reloaded = await service
              .from('inbox_messages')
              .select('id, external_uid, imap_account_id, thread_id, body, html_body, direction, is_draft, from_identifier, to_identifier, cc')
              .eq('thread_id', threadId)
              .order('received_at', { ascending: true })
            messages = reloaded.data
            msgErr = reloaded.error
            console.log('[fetch-thread-bodies] empty thread healed from Drafts or Sent', { threadId, messageId: healResult.messageId })
          }
        } catch (healErr) {
          console.log('[fetch-thread-bodies] empty thread heal failed', { threadId, error: (healErr as Error).message })
        }
      }
    }
  }

  if (msgErr || !messages?.length) {
    console.log('[fetch-thread-bodies] no messages', { threadId, error: msgErr?.message })
    return jsonRes({ messages: [] }, 200)
  }
  console.log('[fetch-thread-bodies] messages loaded', { threadId, count: messages.length, elapsedMs: Math.round(performance.now() - tStart) })

  // Get attachments for all messages in thread (from DB)
  const { data: attRows } = await service
    .from('inbox_attachments')
    .select('message_id, file_name, file_path')
    .eq('thread_id', threadId)
  const attsByMsg = new Map<string, { file_name: string; file_path: string }[]>()
  for (const a of (attRows ?? []) as { message_id: string; file_name: string; file_path: string }[]) {
    const list = attsByMsg.get(a.message_id) ?? []
    list.push({ file_name: a.file_name, file_path: a.file_path })
    attsByMsg.set(a.message_id, list)
  }

  const threadSubjectNorm = normalizeSubject((thread as { subject?: string | null }).subject ?? '')

  type MessageResult = {
    id: string
    body: string | null
    htmlBody: string | null
    attachments: { file_name: string; file_path: string }[]
    from_identifier?: string | null
    to_identifier?: string | null
    cc?: string | null
    isDraft?: boolean
  }
  const result: MessageResult[] = []
  const deletedMessageIds: string[] = []

  type DraftReconcileRow = {
    id: string
    external_uid: number
    imap_account_id: string
    thread_id: string
    body: string | null
    html_body: string | null
    from_identifier: string
    to_identifier: string | null
    cc: string | null
  }

  const pushExistingDraftResult = (msg: DraftReconcileRow) => {
    result.push({
      id: msg.id,
      body: msg.body,
      htmlBody: msg.html_body,
      attachments: attsByMsg.get(msg.id) ?? [],
      from_identifier: msg.from_identifier,
      to_identifier: msg.to_identifier,
      cc: msg.cc,
    })
  }

  /** imap-sync inserts inbound + outbound with null bodies; bodies are lazy-loaded from IMAP by UID (same mailbox as sync: All Mail / INBOX). */
  const isBodyEmpty = (m: { body: unknown; html_body: unknown }) => {
    if (isUnavailableBodyText(m.body)) return false
    const b = m.body
    const h = m.html_body
    const bodyEmpty = b == null || (typeof b === 'string' && !b.trim())
    const htmlEmpty = h == null || (typeof h === 'string' && !h.trim())
    return bodyEmpty && htmlEmpty
  }

  const markBodyUnavailable = async (
    msgId: string,
    reason: 'missing' | 'empty' | 'error',
  ): Promise<string> => {
    const text = unavailableBodyText(reason)
    await service.from('inbox_messages').update({ body: text, html_body: null }).eq('id', msgId)
    return text
  }

  const isDraftRow = (m: { is_draft?: boolean | null }) => !!m.is_draft

  const normNullableStr = (s: string | null | undefined) => {
    const t = (s ?? '').trim()
    return t || null
  }

  const recipientsOverlap = (a: string | null, b: string | null): boolean => {
    const aParts = (a ?? '').split(',').map((s) => normalizeEmail(s)).filter(Boolean).sort()
    const bParts = (b ?? '').split(',').map((s) => normalizeEmail(s)).filter(Boolean).sort()
    if (!aParts.length && !bParts.length) return true
    if (aParts.join(',') === bParts.join(',')) return true
    const overlap = aParts.filter((t) => bParts.includes(t)).length
    return overlap > 0 && (overlap === aParts.length || overlap === bParts.length)
  }

  const isPhantomOutboundDuplicate = (
    draft: { from_identifier: string; to_identifier: string | null; body: string | null; html_body: string | null },
    cand: {
      id: string
      direction?: string
      is_draft?: boolean | null
      from_identifier: string
      to_identifier: string | null
      body: string | null
      html_body: string | null
    },
    reconciled: { body: string | null; htmlBody: string | null },
  ): boolean => {
    if (cand.id === (draft as { id?: string }).id) return false
    if (cand.direction !== 'outbound' || cand.is_draft) return false
    if (normalizeEmail(draft.from_identifier) !== normalizeEmail(cand.from_identifier)) return false
    if (!recipientsOverlap(draft.to_identifier, cand.to_identifier)) return false
    const candEmpty = isBodyEmpty(cand)
    const draftEmpty = isBodyEmpty({ body: reconciled.body, html_body: reconciled.htmlBody })
    if (!candEmpty && !draftEmpty) {
      return bodySnippetsMatch(
        { body: reconciled.body, html_body: reconciled.htmlBody },
        { text: cand.body, html: cand.html_body },
      )
    }
    return true
  }

  const deletePhantomOutboundDuplicates = async (
    draft: DraftReconcileRow,
    reconciled: { body: string | null; htmlBody: string | null; fromIdentifier: string; toIdentifier: string | null },
  ): Promise<void> => {
    const candidates = messages.filter((m) =>
      m.id !== draft.id
      && m.thread_id === draft.thread_id
      && m.direction === 'outbound'
      && !m.is_draft
      && m.imap_account_id === draft.imap_account_id
    )
    for (const cand of candidates) {
      if (!isPhantomOutboundDuplicate(
        { ...draft, body: reconciled.body, html_body: reconciled.htmlBody },
        cand as typeof cand & { direction: string; is_draft?: boolean | null },
        reconciled,
      )) continue
      const { error: delErr } = await service.from('inbox_messages').delete().eq('id', cand.id)
      if (delErr) {
        console.log('[fetch-thread-bodies] phantom outbound delete failed', { draftId: draft.id, phantomId: cand.id, error: delErr.message })
        continue
      }
      deletedMessageIds.push(cand.id)
      console.log('[fetch-thread-bodies] deleted phantom outbound duplicate of draft', { draftId: draft.id, phantomId: cand.id, uid: cand.external_uid })
    }
  }

  const applyDraftReconcile = async (
    msg: DraftReconcileRow,
    source: Uint8Array,
    resolvedUid: number,
    gmailIdFields: ReturnType<typeof gmailIdMessageFields> = {},
  ): Promise<boolean> => {
    const parsed = await PostalMime.parse(source)
    let bodyText = parsed.text ?? ''
    let htmlBody = normalizeDraftHtml(parsed.html ?? null)
    const fromIdentifier = formatAddress(parsed.from) || msg.from_identifier
    const toIdentifier = formatAddressList(parsed.to) ?? msg.to_identifier
    const cc = formatAddressList(parsed.cc) ?? msg.cc

    if (bodyText.length > 50000) bodyText = bodyText.slice(0, 50000)
    if (htmlBody && htmlBody.length > 50000) htmlBody = htmlBody.slice(0, 50000)

    const bodyStored = bodyText || null
    const resultEntry: MessageResult = {
      id: msg.id,
      body: bodyStored,
      htmlBody,
      attachments: attsByMsg.get(msg.id) ?? [],
      from_identifier: fromIdentifier,
      to_identifier: toIdentifier,
      cc,
    }

    const unchanged =
      normNullableStr(bodyStored) === normNullableStr(msg.body)
      && normNullableStr(htmlBody) === normNullableStr(msg.html_body)
      && fromIdentifier === msg.from_identifier
      && normNullableStr(toIdentifier) === normNullableStr(msg.to_identifier)
      && normNullableStr(cc) === normNullableStr(msg.cc)
      && resolvedUid === msg.external_uid

    if (unchanged) {
      console.log('[fetch-thread-bodies] draft reconcile skip UPDATE (unchanged)', { msgId: msg.id, uid: resolvedUid })
      result.push(resultEntry)
      await deletePhantomOutboundDuplicates(msg, { body: bodyStored, htmlBody, fromIdentifier, toIdentifier })
      return true
    }

    const updatePayload: Record<string, unknown> = {
      body: bodyStored,
      html_body: htmlBody,
      from_identifier: fromIdentifier,
      to_identifier: toIdentifier,
      cc,
      ...gmailIdFields,
    }
    if (resolvedUid !== msg.external_uid) {
      updatePayload.external_uid = resolvedUid
      console.log('[fetch-thread-bodies] draft external_uid corrected', { msgId: msg.id, oldUid: msg.external_uid, newUid: resolvedUid })
    }

    const { error: updErr } = await service.from('inbox_messages').update(updatePayload).eq('id', msg.id)
    if (updErr) {
      console.log('[fetch-thread-bodies] draft update failed', { msgId: msg.id, uid: resolvedUid, error: updErr.message })
      pushExistingDraftResult(msg)
      return false
    }

    result.push(resultEntry)
    await deletePhantomOutboundDuplicates(msg, { body: bodyStored, htmlBody, fromIdentifier, toIdentifier })
    if (gmailIdFields.gmail_thread_id || gmailIdFields.gmail_message_id) {
      await syncThreadGmailIds(service, threadId, '[fetch-thread-bodies]')
    }
    return true
  }

  // For messages with null imap_account_id, resolve a fallback from the thread or org
  let fallbackAccountId: string | null = null
  const msgsNeedingAccount = messages.filter((m) =>
    !m.imap_account_id && m.external_uid != null && (isBodyEmpty(m) || isDraftRow(m))
  )
  if (msgsNeedingAccount.length > 0) {
    const { data: threadRow } = await service.from('inbox_threads')
      .select('imap_account_id, org_id')
      .eq('id', threadId)
      .single()
    fallbackAccountId = (threadRow as { imap_account_id: string | null } | null)?.imap_account_id ?? null
    if (!fallbackAccountId) {
      const orgId = (threadRow as { org_id: string } | null)?.org_id
      if (orgId) {
        const { data: accPick } = await service.from('imap_accounts')
          .select('id').eq('org_id', orgId).eq('is_active', true).limit(1)
        fallbackAccountId = (accPick as { id: string }[] | null)?.[0]?.id ?? null
      }
    }
    console.log('[fetch-thread-bodies] messages with null imap_account_id need fallback', {
      threadId,
      count: msgsNeedingAccount.length,
      fallbackAccountId,
      messageIds: msgsNeedingAccount.map((m) => m.id),
    })
    if (fallbackAccountId) {
      await service.from('inbox_messages')
        .update({ imap_account_id: fallbackAccountId })
        .in('id', msgsNeedingAccount.map((m) => m.id))
      for (const m of messages) {
        if (msgsNeedingAccount.some((n) => n.id === m.id)) {
          (m as Record<string, unknown>).imap_account_id = fallbackAccountId
        }
      }
      console.log('[fetch-thread-bodies] patched imap_account_id on', msgsNeedingAccount.length, 'messages to', fallbackAccountId)
    }
  }

  // Non-draft messages that need body lazy-load from All Mail/INBOX (limit per request to avoid 546 WORKER_LIMIT)
  const needFetchRaw = messages.filter((m) =>
    isBodyEmpty(m) && !!m.imap_account_id && m.external_uid != null && !isDraftRow(m)
  ) as {
    id: string
    external_uid: number
    imap_account_id: string
    thread_id: string
    direction: string
  }[]
  const needFetch = needFetchRaw.slice(0, MAX_FETCH_PER_REQUEST)

  // DB draft rows: reconcile against provider Drafts mailbox (do not import server drafts as new rows)
  const needDraftReconcile = messages.filter((m) =>
    isDraftRow(m) && !!m.imap_account_id && m.external_uid != null
  ) as {
    id: string
    external_uid: number
    imap_account_id: string
    thread_id: string
    body: string | null
    html_body: string | null
    from_identifier: string
    to_identifier: string | null
    cc: string | null
  }[]

  // Self-heal: thread has no is_draft row but an outbound non-draft matches provider Drafts.
  const hasDraftRow = messages.some((m) => isDraftRow(m))
  const phantomHealCandidates = !hasDraftRow
    ? messages.filter((m) =>
      m.direction === 'outbound'
      && !isDraftRow(m)
      && !!m.imap_account_id
      && m.external_uid != null
    ) as {
      id: string
      external_uid: number
      imap_account_id: string
      thread_id: string
      body: string | null
      html_body: string | null
      from_identifier: string
      to_identifier: string | null
    }[]
    : []

  const outboundNeed = needFetchRaw.filter((m) => m.direction === 'outbound').length
  const stillNoAccount = messages.filter((m) => isBodyEmpty(m) && !m.imap_account_id && m.external_uid != null)
  console.log('[fetch-thread-bodies] split', {
    threadId,
    needImapFetch: needFetch.length,
    totalNeed: needFetchRaw.length,
    outboundNeed,
    inboundNeed: needFetchRaw.length - outboundNeed,
    stillNoAccount: stillNoAccount.length,
    needDraftReconcile: needDraftReconcile.length,
    phantomHealCandidates: phantomHealCandidates.length,
    needFetchIds: needFetch.map((m) => m.id),
    needFetchDirections: needFetch.map((m) => m.direction),
    draftReconcileIds: needDraftReconcile.map((m) => m.id),
  })

  const pendingImapIds = new Set([
    ...needFetch.map((m) => m.id),
    ...needDraftReconcile.map((m) => m.id),
    ...phantomHealCandidates.map((m) => m.id),
  ])

  const upsertResultBody = (
    msgId: string,
    body: string | null,
    htmlBody: string | null,
    extras?: { bodyUnavailable?: boolean; attachments?: { file_name: string; file_path: string }[] },
  ) => {
    const idx = result.findIndex((r) => r.id === msgId)
    const entry = {
      id: msgId,
      body,
      htmlBody,
      attachments: extras?.attachments ?? attsByMsg.get(msgId) ?? [],
      ...(extras?.bodyUnavailable ? { bodyUnavailable: true } : {}),
    }
    if (idx >= 0) result[idx] = { ...result[idx], ...entry }
    else result.push(entry)
  }

  // Add messages that already have body and do not need draft reconciliation
  for (const m of messages) {
    if (pendingImapIds.has(m.id)) continue
    result.push({
      id: m.id,
      body: m.body as string | null,
      htmlBody: m.html_body as string | null,
      attachments: attsByMsg.get(m.id) ?? [],
    })
  }

  if (needFetch.length === 0 && needDraftReconcile.length === 0 && phantomHealCandidates.length === 0) {
    for (const m of stillNoAccount) {
      const text = await markBodyUnavailable(m.id, 'error')
      upsertResultBody(m.id, text, null, { bodyUnavailable: true })
    }
    console.log('[fetch-thread-bodies] all from DB, returning', { threadId, messageCount: result.length, elapsedMs: Math.round(performance.now() - tStart) })
    return jsonRes({ messages: result, deletedMessageIds }, 200)
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    console.log('[fetch-thread-bodies] ENCRYPTION_KEY not configured, cannot fetch from IMAP', { threadId })
    for (const m of needFetch) {
      const text = await markBodyUnavailable(m.id, 'error')
      upsertResultBody(m.id, text, null, { bodyUnavailable: true })
    }
    for (const m of stillNoAccount) {
      const text = await markBodyUnavailable(m.id, 'error')
      upsertResultBody(m.id, text, null, { bodyUnavailable: true })
    }
    return jsonRes({ error: 'ENCRYPTION_KEY not configured', messages: result, deletedMessageIds }, 500)
  }

  for (const m of stillNoAccount) {
    const text = await markBodyUnavailable(m.id, 'error')
    upsertResultBody(m.id, text, null, { bodyUnavailable: true })
  }

  // Group by imap_account_id to reuse connection
  const byAccount = new Map<string, typeof needFetch>()
  for (const m of needFetch) {
    const list = byAccount.get(m.imap_account_id) ?? []
    list.push(m)
    byAccount.set(m.imap_account_id, list)
  }
  const draftsByAccount = new Map<string, typeof needDraftReconcile>()
  for (const m of needDraftReconcile) {
    const list = draftsByAccount.get(m.imap_account_id) ?? []
    list.push(m)
    draftsByAccount.set(m.imap_account_id, list)
  }
  const phantomsByAccount = new Map<string, typeof phantomHealCandidates>()
  for (const m of phantomHealCandidates) {
    const list = phantomsByAccount.get(m.imap_account_id) ?? []
    list.push(m)
    phantomsByAccount.set(m.imap_account_id, list)
  }
  const accountIds = [...new Set([...byAccount.keys(), ...draftsByAccount.keys(), ...phantomsByAccount.keys()])]

  for (const accId of accountIds) {
    const msgs = byAccount.get(accId) ?? []
    const draftMsgs = draftsByAccount.get(accId) ?? []
    const phantomMsgs = phantomsByAccount.get(accId) ?? []
    const tAcc = performance.now()
    console.log('[fetch-thread-bodies] IMAP account start', { threadId, accId, messageCount: msgs.length, draftCount: draftMsgs.length, phantomCount: phantomMsgs.length, uids: msgs.map((m) => m.external_uid), draftUids: draftMsgs.map((m) => m.external_uid), elapsedMs: Math.round(tAcc - tStart) })
    const { data: acc } = await service
      .from('imap_accounts')
      .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
      .eq('id', accId)
      .single()
    if (!acc) {
      console.log('[fetch-thread-bodies] IMAP account not found', { accId })
      for (const msg of msgs) {
        const text = await markBodyUnavailable(msg.id, 'error')
        upsertResultBody(msg.id, text, null, { bodyUnavailable: true })
      }
      continue
    }
    console.log('[fetch-thread-bodies] acc loaded', { accId, elapsedMs: Math.round(performance.now() - tAcc) })

    let password: string
    try {
      const tDec = performance.now()
      password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
      console.log('[fetch-thread-bodies] decrypt done', { accId, elapsedMs: Math.round(performance.now() - tDec) })
    } catch (decErr) {
      console.log('[fetch-thread-bodies] decrypt credentials failed', { accId, error: (decErr as Error).message })
      for (const msg of msgs) {
        const text = await markBodyUnavailable(msg.id, 'error')
        upsertResultBody(msg.id, text, null, { bodyUnavailable: true })
      }
      continue
    }

    const secure = (acc.imap_encryption as string) === 'ssl' || (acc.imap_encryption as string) === 'tls'
    const host = acc.host as string
    const isGmail = host.toLowerCase().includes('gmail.com')
    const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'
    const draftsPath = getDraftsMailboxPath(host)
    const client = new ImapFlow({
      host: acc.host as string,
      port: Number(acc.port) || 993,
      secure,
      auth: { user: acc.imap_username as string, pass: password },
      logger: false,
    })
    client.on('error', (err: Error) => {
      console.log('[fetch-thread-bodies] IMAP client error (connection/reset):', err?.message ?? String(err))
    })

    try {
      const tConn = performance.now()
      await client.connect()
      console.log('[fetch-thread-bodies] IMAP connected', { accId, host: acc.host, mailbox: mailboxPath, draftsPath, connectMs: Math.round(performance.now() - tConn), elapsedMs: Math.round(performance.now() - tStart) })

      const draftsCache = new DraftsEnvelopeCache(client, host)

      if (phantomMsgs.length > 0) {
        for (const phantom of phantomMsgs) {
          const healed = await healPhantomOutboundAsDraft(
            service,
            client,
            host,
            threadId,
            phantom,
            threadSubjectNorm,
            draftsCache,
          )
          const msgRow = messages.find((m) => m.id === phantom.id)
          if (healed.healed && msgRow) {
            (msgRow as { is_draft?: boolean | null }).is_draft = true
            if (healed.body) (msgRow as { body: string | null }).body = healed.body
            if (healed.htmlBody) (msgRow as { html_body: string | null }).html_body = healed.htmlBody
          }
          result.push({
            id: phantom.id,
            body: healed.body,
            htmlBody: healed.htmlBody,
            attachments: attsByMsg.get(phantom.id) ?? [],
            from_identifier: phantom.from_identifier,
            to_identifier: phantom.to_identifier,
            isDraft: healed.healed ? true : undefined,
          })
          console.log('[fetch-thread-bodies] phantom heal result', { threadId, msgId: phantom.id, healed: healed.healed })
        }
      }

      if (draftMsgs.length > 0) {
        const tDraftLock = performance.now()
        const draftLock = await client.getMailboxLock(draftsPath)
        console.log('[fetch-thread-bodies] drafts mailbox lock acquired', { accId, mailbox: draftsPath, lockMs: Math.round(performance.now() - tDraftLock) })
        const claimedDraftUids = new Set<number>()
        let recentDraftEnvelopes: Array<{ uid: number; envelope: ImapEnvelope }> | null = null
        let draftsMailboxVerified = false
        try {
          for (const msg of draftMsgs) {
            const tDraftMsg = performance.now()
            let resolvedUid: number | null = null
            let source: Uint8Array | undefined
            let draftGmailIdFields: ReturnType<typeof gmailIdMessageFields> = {}

            const fetched = await client.fetchAll(
              String(msg.external_uid),
              withGmailImapIdFetch(isGmail, { source: true, uid: true }),
              { uid: true },
            )
            source = fetched[0]?.source as Uint8Array | undefined
            if (isGmail) draftGmailIdFields = gmailIdMessageFields(extractGmailIds(true, fetched[0] ?? {}))
            if (source) {
              resolvedUid = msg.external_uid
              draftsMailboxVerified = true
              console.log('[fetch-thread-bodies] draft reconcile fetch by uid', { threadId, msgId: msg.id, uid: msg.external_uid, sourceBytes: source.byteLength, fetchMs: Math.round(performance.now() - tDraftMsg) })
            } else {
              console.log('[fetch-thread-bodies] draft uid not in Drafts mailbox — searching recent drafts', { threadId, msgId: msg.id, staleUid: msg.external_uid })
              if (!recentDraftEnvelopes) {
                const recent = await fetchRecentDraftEnvelopes(client, draftsPath)
                recentDraftEnvelopes = recent.envelopes
                draftsMailboxVerified = recent.verified
                console.log('[fetch-thread-bodies] recent drafts loaded for fallback search', { accId, count: recentDraftEnvelopes.length, verified: recent.verified })
              }
              const scored = recentDraftEnvelopes
                .filter((c) => !claimedDraftUids.has(c.uid))
                .map((c) => ({ ...c, score: scoreDraftForRow(msg, c.envelope, threadSubjectNorm) }))
                .filter((c) => c.score >= DRAFT_MATCH_MIN_SCORE)
                .sort((a, b) => b.score - a.score || b.uid - a.uid)

              for (const candidate of scored.slice(0, 5)) {
                const candFetched = await client.fetchAll(
                  String(candidate.uid),
                  withGmailImapIdFetch(isGmail, { source: true, uid: true }),
                  { uid: true },
                )
                const candSource = candFetched[0]?.source as Uint8Array | undefined
                if (!candSource) continue
                let bodyOk = true
                const dbHasBody = !!(msg.body?.trim() || msg.html_body?.trim())
                if (dbHasBody) {
                  try {
                    const parsedCand = await PostalMime.parse(candSource)
                    bodyOk = bodySnippetsMatch(msg, parsedCand)
                  } catch {
                    bodyOk = false
                  }
                }
                if (!bodyOk) continue
                resolvedUid = candidate.uid
                source = candSource
                if (isGmail) draftGmailIdFields = gmailIdMessageFields(extractGmailIds(true, candFetched[0] ?? {}))
                console.log('[fetch-thread-bodies] draft matched in Drafts fallback search', { threadId, msgId: msg.id, staleUid: msg.external_uid, matchedUid: candidate.uid, score: candidate.score })
                break
              }

              // Likely server draft exists (envelope match) — rematch even when body snippet differs.
              if (resolvedUid == null && scored.length > 0) {
                const likely = scored[0]
                const likelyFetched = await client.fetchAll(
                  String(likely.uid),
                  withGmailImapIdFetch(isGmail, { source: true, uid: true }),
                  { uid: true },
                )
                const likelySource = likelyFetched[0]?.source as Uint8Array | undefined
                if (likelySource) {
                  resolvedUid = likely.uid
                  source = likelySource
                  if (isGmail) draftGmailIdFields = gmailIdMessageFields(extractGmailIds(true, likelyFetched[0] ?? {}))
                  console.log('[fetch-thread-bodies] draft rematched by envelope score (no body confirm)', { threadId, msgId: msg.id, staleUid: msg.external_uid, matchedUid: likely.uid, score: likely.score })
                }
              }
            }

            if (resolvedUid != null && source) {
              const ok = await applyDraftReconcile(msg, source, resolvedUid, draftGmailIdFields)
              if (ok) claimedDraftUids.add(resolvedUid)
              console.log('[fetch-thread-bodies] draft reconciled', { threadId, msgId: msg.id, uid: resolvedUid, totalMs: Math.round(performance.now() - tDraftMsg) })
              continue
            }

            const hasLikelyDraft = (recentDraftEnvelopes ?? [])
              .some((c) => scoreDraftForRow(msg, c.envelope, threadSubjectNorm) >= DRAFT_MATCH_MIN_SCORE)

            if (!draftsMailboxVerified || hasLikelyDraft) {
              console.log('[fetch-thread-bodies] keeping DB draft row — Drafts not verified or likely match exists', {
                msgId: msg.id,
                uid: msg.external_uid,
                draftsMailboxVerified,
                hasLikelyDraft,
              })
              pushExistingDraftResult(msg)
              continue
            }

            const remainingAfterDelete = messages.filter(
              (m) => m.id !== msg.id && !deletedMessageIds.includes(m.id),
            )
            if (remainingAfterDelete.length === 0) {
              const sentHeal = await healEmptyThreadFromSentMail(
                service,
                client,
                host,
                accId,
                acc.org_id as string,
                {
                  id: threadId,
                  subject: (thread as { subject?: string | null }).subject ?? null,
                  from_address: (thread as { from_address?: string | null }).from_address ?? null,
                  status: (thread as { status?: string | null }).status ?? null,
                  mailbox_address: (thread as { mailbox_address?: string | null }).mailbox_address ?? null,
                },
                undefined,
                '[fetch-thread-bodies]',
              )
              if (sentHeal.healed) {
                console.log('[fetch-thread-bodies] last draft replaced by Sent Mail heal', { threadId, draftId: msg.id, messageId: sentHeal.messageId })
                deletedMessageIds.push(msg.id)
                const reloaded = await service
                  .from('inbox_messages')
                  .select('id, body, html_body, from_identifier, to_identifier, cc, is_draft')
                  .eq('thread_id', threadId)
                  .order('received_at', { ascending: true })
                const healedMsgs = (reloaded.data ?? []) as {
                  id: string
                  body: string | null
                  html_body: string | null
                  from_identifier: string | null
                  to_identifier: string | null
                  cc: string | null
                  is_draft?: boolean | null
                }[]
                const healedResult = healedMsgs.map((m) => ({
                  id: m.id,
                  body: m.body,
                  htmlBody: m.html_body,
                  attachments: attsByMsg.get(m.id) ?? [],
                  from_identifier: m.from_identifier,
                  to_identifier: m.to_identifier,
                  cc: m.cc,
                  isDraft: m.is_draft ?? false,
                }))
                try { await draftLock.release() } catch { /* ignore */ }
                await draftsCache.release()
                await client.logout().catch(() => { try { client.close() } catch { /* ignore */ } })
                return jsonRes({ messages: healedResult, deletedMessageIds }, 200)
              }
            }

            console.log('[fetch-thread-bodies] no matching draft in provider Drafts mailbox — deleting DB row', { msgId: msg.id, uid: msg.external_uid })
            const { error: delErr } = await service.from('inbox_messages').delete().eq('id', msg.id)
            if (delErr) {
              console.log('[fetch-thread-bodies] draft delete failed', { msgId: msg.id, error: delErr.message })
              pushExistingDraftResult(msg)
              continue
            }
            deletedMessageIds.push(msg.id)
          }
        } finally {
          try { await draftLock.release() } catch { /* connection may be dead */ }
          console.log('[fetch-thread-bodies] drafts mailbox lock released', { accId, mailbox: draftsPath })
        }
      }

      await draftsCache.release()

      if (msgs.length === 0 && draftMsgs.length === 0) {
        const tLogoutOnly = performance.now()
        await client.logout().catch(() => { try { client.close() } catch { /* ignore */ } })
        console.log('[fetch-thread-bodies] IMAP logout (drafts only)', { accId, logoutMs: Math.round(performance.now() - tLogoutOnly), accTotalMs: Math.round(performance.now() - tAcc) })
        continue
      }

      const tLock = performance.now()
      const lock = await client.getMailboxLock(mailboxPath)
      console.log('[fetch-thread-bodies] mailbox lock acquired', { accId, mailbox: mailboxPath, lockMs: Math.round(performance.now() - tLock) })
      try {
        for (const msg of msgs) {
          const tMsg = performance.now()
          const fetched = await client.fetchAll(
            String(msg.external_uid),
            withGmailImapIdFetch(isGmail, { source: true, uid: true }),
            { uid: true },
          )
          const fetchedMsg = fetched[0]
          const source = fetchedMsg?.source as Uint8Array | undefined
          const gmailIdFields = isGmail ? gmailIdMessageFields(extractGmailIds(true, fetchedMsg ?? {})) : {}
          const fetchMs = Math.round(performance.now() - tMsg)
          console.log('[fetch-thread-bodies] IMAP fetch', { threadId, msgId: msg.id, uid: msg.external_uid, sourceBytes: source?.byteLength ?? 0, fetchMs })
          if (!source) {
            console.log('[fetch-thread-bodies] no source for message — marking unavailable', { msgId: msg.id, uid: msg.external_uid })
            const unavailableBody = await markBodyUnavailable(msg.id, 'missing')
            result.push({ id: msg.id, body: unavailableBody, htmlBody: null, attachments: [], bodyUnavailable: true })
            continue
          }

          const tParse = performance.now()
          const parsed = await PostalMime.parse(source)
          const parseMs = Math.round(performance.now() - tParse)
          console.log('[fetch-thread-bodies] MIME parsed', { threadId, msgId: msg.id, parseMs })
          let bodyText = parsed.text ?? ''
          let htmlBody = parsed.html ?? null

          const rawToBytes = (raw: unknown) =>
            raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBuffer) ?? [])

          // Inline images (CID) — upload, rewrite HTML, and add to inbox_attachments so they show in attachment list
          const inlineAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => a.contentId)
          const newAtts: { file_name: string; file_path: string }[] = []
          if (htmlBody && inlineAtts.length > 0) {
            const tInline = performance.now()
            for (let i = 0; i < inlineAtts.length; i++) {
              const att = inlineAtts[i]
              const cid = att.contentId!.replace(/^<|>$/g, '')
              const fname = att.filename ?? `inline-${cid}`
              const safeName = sanitizeStorageName(fname)
              const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${i}-${safeName}`
              const contentBytes = rawToBytes(att.content)
              const { error: upErr } = await service.storage
                .from('inbox-attachments')
                .upload(path, contentBytes, { contentType: att.mimeType ?? 'application/octet-stream', upsert: true })
              console.log('[fetch-thread-bodies] inline attachment', { threadId, msgId: msg.id, filename: fname, safeName, bytes: contentBytes.length, uploadError: upErr?.message ?? null })
              if (!upErr) {
                const { data: urlData } = service.storage.from('inbox-attachments').getPublicUrl(path)
                htmlBody = htmlBody!.replace(
                  new RegExp('cid:' + cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                  urlData.publicUrl
                )
                const { error: insErr } = await service.from('inbox_attachments').insert({
                  message_id: msg.id,
                  thread_id: msg.thread_id,
                  file_name: fname,
                  file_path: path,
                  file_size: contentBytes.length,
                  content_type: att.mimeType,
                })
                if (insErr) console.log('[fetch-thread-bodies] inline insert error', { threadId, msgId: msg.id, filename: fname, error: insErr.message })
                else newAtts.push({ file_name: fname, file_path: path })
              }
            }
            console.log('[fetch-thread-bodies] inline atts done', { threadId, msgId: msg.id, count: inlineAtts.length, inlineMs: Math.round(performance.now() - tInline) })
          }

          // File attachments (no contentId)
          const fileAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => !a.contentId)
          const tFile = performance.now()
          for (let i = 0; i < fileAtts.length; i++) {
            const att = fileAtts[i]
            const fname = att.filename ?? `attachment-${Date.now()}`
            const safeName = sanitizeStorageName(fname)
            const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${i}-${safeName}`
            const contentBytes = rawToBytes(att.content)
            const { error: upErr } = await service.storage
              .from('inbox-attachments')
              .upload(path, contentBytes, { contentType: att.mimeType ?? 'application/octet-stream', upsert: true })
            console.log('[fetch-thread-bodies] file attachment', { threadId, msgId: msg.id, filename: fname, safeName, bytes: contentBytes.length, uploadError: upErr?.message ?? null })
            if (!upErr) {
              const { error: insErr } = await service.from('inbox_attachments').insert({
                message_id: msg.id,
                thread_id: msg.thread_id,
                file_name: fname,
                file_path: path,
                file_size: contentBytes.length,
                content_type: att.mimeType,
              })
              if (insErr) console.log('[fetch-thread-bodies] file insert error', { threadId, msgId: msg.id, filename: fname, error: insErr.message })
              else newAtts.push({ file_name: fname, file_path: path })
            }
          }
          if (fileAtts.length > 0) {
            console.log('[fetch-thread-bodies] file atts done', { threadId, msgId: msg.id, count: fileAtts.length, fileMs: Math.round(performance.now() - tFile) })
          }

          if (bodyText.length > 50000) bodyText = bodyText.slice(0, 50000)
          if (htmlBody && htmlBody.length > 50000) htmlBody = htmlBody.slice(0, 50000)

          const hasDisplayBody = !!(bodyText.trim() || htmlBody?.trim())
          let storedBody: string | null = bodyText || null
          let storedHtml: string | null = htmlBody
          let bodyUnavailable = false
          if (!hasDisplayBody) {
            console.log('[fetch-thread-bodies] parsed MIME has no displayable body — marking unavailable', { threadId, msgId: msg.id, uid: msg.external_uid, sourceBytes: source.byteLength })
            storedBody = await markBodyUnavailable(msg.id, 'empty')
            storedHtml = null
            bodyUnavailable = true
          } else {
            const tDb = performance.now()
            await service
              .from('inbox_messages')
              .update({ body: storedBody, html_body: storedHtml, ...gmailIdFields })
              .eq('id', msg.id)
            if (isGmail && (gmailIdFields.gmail_thread_id || gmailIdFields.gmail_message_id)) {
              await syncThreadGmailIds(service, threadId, '[fetch-thread-bodies]')
            }
            const dbMs = Math.round(performance.now() - tDb)
            const attCount = (attsByMsg.get(msg.id) ?? []).length + newAtts.length
            const msgTotalMs = Math.round(performance.now() - tMsg)
            console.log('[fetch-thread-bodies] message done', { threadId, msgId: msg.id, bodyLen: bodyText?.length ?? 0, htmlLen: htmlBody?.length ?? 0, attachments: attCount, dbMs, totalMsgMs: msgTotalMs })
          }

          result.push({
            id: msg.id,
            body: storedBody,
            htmlBody: storedHtml,
            attachments: [...(attsByMsg.get(msg.id) ?? []), ...newAtts],
            ...(bodyUnavailable ? { bodyUnavailable: true } : {}),
          })
        }
      } finally {
        const tUnlock = performance.now()
        try { await lock.release() } catch { /* connection may be dead */ }
        console.log('[fetch-thread-bodies] mailbox lock released', { accId, elapsedMs: Math.round(performance.now() - tUnlock) })
      }
      const tLogout = performance.now()
      await client.logout().catch(() => { try { client.close() } catch { /* ignore */ } })
      console.log('[fetch-thread-bodies] IMAP logout', { accId, logoutMs: Math.round(performance.now() - tLogout), accTotalMs: Math.round(performance.now() - tAcc) })
    } catch (err) {
      console.error('[fetch-thread-bodies] IMAP error', { accId, error: (err as Error).message })
      try { await client.logout() } catch { try { client.close() } catch { /* ignore */ } }
      for (const msg of msgs) {
        if (result.some((r) => r.id === msg.id)) continue
        const text = await markBodyUnavailable(msg.id, 'error')
        result.push({ id: msg.id, body: text, htmlBody: null, attachments: [], bodyUnavailable: true })
      }
      for (const msg of draftMsgs) {
        if (deletedMessageIds.includes(msg.id)) continue
        result.push({
          id: msg.id,
          body: msg.body,
          htmlBody: msg.html_body,
          attachments: attsByMsg.get(msg.id) ?? [],
          from_identifier: msg.from_identifier,
          to_identifier: msg.to_identifier,
          cc: msg.cc,
        })
      }
      for (const msg of phantomMsgs) {
        if (result.some((r) => r.id === msg.id)) continue
        result.push({
          id: msg.id,
          body: msg.body,
          htmlBody: msg.html_body,
          attachments: attsByMsg.get(msg.id) ?? [],
          from_identifier: msg.from_identifier,
          to_identifier: msg.to_identifier,
        })
      }
    }
  }

  const deletedSet = new Set(deletedMessageIds)
  // Sort by original message order (received_at); omit server-deleted drafts
  const ordered = messages
    .filter((m) => !deletedSet.has(m.id))
    .map((m) => {
      const r = result.find((x) => x.id === m.id)
      if (r) {
        return {
          id: r.id,
          body: r.body,
          htmlBody: r.htmlBody,
          attachments: r.attachments,
          ...(r.from_identifier != null ? { from_identifier: r.from_identifier } : {}),
          ...(r.to_identifier != null ? { to_identifier: r.to_identifier } : {}),
          ...(r.cc != null ? { cc: r.cc } : {}),
          ...(r.isDraft != null ? { isDraft: r.isDraft } : {}),
        }
      }
      return {
        id: m.id,
        body: m.body as string | null,
        htmlBody: m.html_body as string | null,
        attachments: attsByMsg.get(m.id) ?? [],
      }
    })
  const hasMore = needFetchRaw.length > MAX_FETCH_PER_REQUEST
  console.log('[fetch-thread-bodies] done', { threadId, messageCount: ordered.length, deletedMessageIds, hasMore, totalElapsedMs: Math.round(performance.now() - tStart) })
  return jsonRes({ messages: ordered, deletedMessageIds, hasMore }, 200)
})
