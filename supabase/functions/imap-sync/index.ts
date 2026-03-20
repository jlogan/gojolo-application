// Sync IMAP accounts: fetch new messages and write to inbox_threads + inbox_messages.
// Cron: call with no body to sync all orgs' active accounts. Manual: pass orgId and optional accountId.
// Requires: ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY. Cron: verify via CRON_SECRET header.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import PostalMime from 'npm:postal-mime'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')
const cronSecret = Deno.env.get('CRON_SECRET')

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  }
}

async function decrypt(ciphertextB64: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const cipher = combined.slice(12)
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    cipher
  )
  return new TextDecoder().decode(dec)
}

interface SyncBody {
  orgId?: string
  accountId?: string
  /** When true, re-fetch recent messages and update their bodies (proper MIME parsing). Use with accountId. */
  resync?: boolean
  /** When set, fetch older messages from IMAP to backfill a thread that has 0 messages. Use with orgId + accountId or ensure accountId matches the thread's account. */
  backfillForThread?: string
}

interface ImapAccountRow {
  id: string
  org_id: string
  host: string
  port: number
  imap_encryption: string
  imap_username: string
  credentials_encrypted: string
  last_fetched_uid: number | null
  last_fetched_uid_trash: number | null
  email?: string
  addresses?: string[] | null
}

function getMailboxPath(host: string): string {
  return host && host.toLowerCase().includes('gmail.com') ? '[Gmail]/All Mail' : 'INBOX'
}

function getTrashMailboxPath(host: string): string {
  return host && host.toLowerCase().includes('gmail.com') ? '[Gmail]/Trash' : 'Trash'
}

/** Extract email from "Name <email>" or return trimmed lowercase. */
function normalizeEmail(addr: string): string {
  if (!addr?.trim()) return ''
  const m = addr.trim().match(/<([^>]+)>/)
  return (m ? m[1] : addr).trim().toLowerCase()
}

/** Build set of our org addresses (email + aliases) from accounts being synced. */
function buildOurAddressesSet(accounts: ImapAccountRow[]): Set<string> {
  const set = new Set<string>()
  for (const a of accounts) {
    if (a.email) set.add(normalizeEmail(a.email))
    for (const alias of a.addresses ?? []) {
      if (alias?.trim()) set.add(normalizeEmail(alias))
    }
  }
  return set
}

/** Raw fallback: everything after headers (no MIME parsing). */
function parseBodyFromSourceRaw(source: Uint8Array | Buffer): string {
  const raw = typeof source === 'string' ? source : new TextDecoder().decode(source)
  const idx = raw.indexOf('\r\n\r\n')
  const bodyStart = idx >= 0 ? idx + 4 : raw.indexOf('\n\n') >= 0 ? raw.indexOf('\n\n') + 2 : 0
  let body = raw.slice(bodyStart).replace(/\r\n/g, '\n').trim()
  if (body.length > 50000) body = body.slice(0, 50000) + '…'
  return body
}

const MAX_BODY_LENGTH = 50000

type ParsedEmail = {
  body: string
  htmlBody: string | null
  attachments: { cid: string | null; filename: string; contentType: string; content: Uint8Array }[]
}

async function parseBodyFromSource(source: Uint8Array | Buffer): Promise<ParsedEmail> {
  try {
    const parsed = await PostalMime.parse(source as Uint8Array)
    const textBody = (parsed.text ?? '').trim()
    let htmlBody = (parsed.html ?? '').trim() || null
    const atts: ParsedEmail['attachments'] = []
    for (const att of parsed.attachments ?? []) {
      atts.push({
        cid: att.contentId?.replace(/^<|>$/g, '') ?? null,
        filename: att.filename ?? `attachment-${Date.now()}`,
        contentType: att.mimeType ?? 'application/octet-stream',
        content: new Uint8Array(att.content),
      })
    }
    const body = textBody || (htmlBody ? htmlBody.replace(/<[^>]+>/g, '').slice(0, MAX_BODY_LENGTH) : '')
    if (htmlBody && htmlBody.length > MAX_BODY_LENGTH) htmlBody = htmlBody.slice(0, MAX_BODY_LENGTH)
    if (body.length > MAX_BODY_LENGTH) return { body: body.slice(0, MAX_BODY_LENGTH), htmlBody, attachments: atts }
    return { body: body || parseBodyFromSourceRaw(source), htmlBody, attachments: atts }
  } catch {
    return { body: parseBodyFromSourceRaw(source), htmlBody: null, attachments: [] }
  }
}

function getHeader(source: Uint8Array | Buffer, name: string): string | null {
  const raw = typeof source === 'string' ? source : new TextDecoder().decode(source)
  const lines = raw.split(/\r?\n/)
  const lower = name.toLowerCase()
  for (const line of lines) {
    if (line === '') break
    if (line.toLowerCase().startsWith(lower + ':')) {
      return line.slice(name.length + 1).trim().replace(/\s+/g, ' ')
    }
  }
  return null
}

/** Normalize Message-ID for consistent threading (strip angle brackets, trim). */
function normalizeMessageId(id: string | null): string | null {
  if (!id || !id.trim()) return null
  const s = id.trim().replace(/^</, '').replace(/>$/, '').trim()
  return s || null
}

serve(async (req) => {
  const syncId = crypto.randomUUID().slice(0, 8)
  console.log('[imap-sync]', syncId, 'request method:', req.method)

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors() })
  }

  if (req.method !== 'POST') {
    console.log('[imap-sync] rejected: method not allowed')
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  const isCron = req.headers.get('x-cron-secret') === cronSecret && cronSecret
  let body: SyncBody = {}
  try {
    const text = await req.text()
    if (text.trim()) body = JSON.parse(text) as SyncBody
  } catch {
    // empty body for cron is ok
  }
  console.log('[imap-sync]', syncId, 'body:', { orgId: body.orgId ?? null, accountId: body.accountId ?? null, resync: body.resync ?? false, backfillForThread: body.backfillForThread ?? null }, 'isCron:', isCron)

  const service = createClient(supabaseUrl, serviceKey)

  if (!isCron) {
    const auth = req.headers.get('Authorization')
    if (!auth) {
      console.log('[imap-sync] no Authorization header — Unauthorized')
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 200,
        headers: { ...cors(), 'Content-Type': 'application/json' },
      })
    }
    if (body.orgId) {
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: auth } },
      })
      const [adminRes, permRes] = await Promise.all([
        userClient.rpc('is_org_admin', { p_org_id: body.orgId }),
        userClient.rpc('user_has_permission', { p_org_id: body.orgId, p_permission: 'inbox.view' }),
      ])
      const hasAccess = adminRes.data === true || permRes.data === true
      if (!hasAccess) {
        console.log('[imap-sync] caller lacks org admin or inbox.view for org', body.orgId, '— Forbidden')
        return new Response(JSON.stringify({ error: 'Forbidden: org access required' }), {
          status: 200,
          headers: { ...cors(), 'Content-Type': 'application/json' },
        })
      }
      console.log('[imap-sync] auth ok for', body.orgId)
    }
  }

  let accountsQuery = service
    .from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted, last_fetched_uid, last_fetched_uid_trash, email, addresses')
    .eq('is_active', true)

  if (body.orgId) {
    accountsQuery = accountsQuery.eq('org_id', body.orgId)
    if (body.accountId) accountsQuery = accountsQuery.eq('id', body.accountId)
  }

  const { data: accounts, error: accountsError } = await accountsQuery

  if (accountsError) {
    console.log('[imap-sync] accounts query error:', accountsError.message)
    return new Response(
      JSON.stringify({
        synced: 0,
        threadsCreated: 0,
        messagesInserted: 0,
        errors: [accountsError.message],
      }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }
  if (!accounts?.length) {
    console.log('[imap-sync] no active accounts to sync (filter: orgId=%s accountId=%s)', body.orgId ?? 'all', body.accountId ?? 'all')
    return new Response(
      JSON.stringify({
        synced: 0,
        threadsCreated: 0,
        messagesInserted: 0,
        errors: ['No active accounts to sync'],
      }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }
  console.log('[imap-sync]', syncId, 'syncing', accounts.length, 'account(s):', (accounts as ImapAccountRow[]).map(a => ({ id: a.id, host: a.host, email: a.email })))

  const ourAddressesSet = buildOurAddressesSet(accounts as ImapAccountRow[])
  console.log('[imap-sync] ourAddressesSet size=', ourAddressesSet.size, 'addresses=', [...ourAddressesSet].slice(0, 5).join(', '))

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    console.log('[imap-sync] ENCRYPTION_KEY missing or too short')
    return new Response(
      JSON.stringify({ error: 'ENCRYPTION_KEY not configured', synced: 0, threadsCreated: 0, messagesInserted: 0 }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  let totalThreads = 0
  let totalMessages = 0
  let totalMessagesUpdated = 0
  const errors: string[] = []

  for (const acc of accounts as ImapAccountRow[]) {
    console.log('[imap-sync] account', acc.id, 'host=', acc.host, 'last_fetched_uid=', acc.last_fetched_uid)
    let password: string
    try {
      password = await decrypt(acc.credentials_encrypted, encryptionKeyHex.slice(0, 64))
    } catch {
      console.log('[imap-sync] account', acc.id, 'decrypt failed')
      errors.push(`${acc.imap_username}: failed to decrypt credentials`)
      await service
        .from('imap_accounts')
        .update({ last_error: 'Decrypt failed' })
        .eq('id', acc.id)
      continue
    }

    const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
    const port = Number(acc.port) || (secure ? 993 : 143)
    const client = new ImapFlow({
      host: acc.host,
      port,
      secure,
      auth: { user: acc.imap_username, pass: password },
    })

    try {
      await client.connect()
      console.log('[imap-sync] account', acc.id, 'IMAP connected')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log('[imap-sync] account', acc.id, 'IMAP connect failed:', msg)
      errors.push(`${acc.imap_username}: ${msg}`)
      await service.from('imap_accounts').update({ last_error: msg }).eq('id', acc.id)
      continue
    }

    const mailboxPath = getMailboxPath(acc.host)
    console.log('[imap-sync] account', acc.id, 'mailbox path:', mailboxPath)
    let lock: { release: () => Promise<void> } | null = null

    try {
      lock = await client.getMailboxLock(mailboxPath)
      const lastUid = acc.last_fetched_uid ?? 0
      console.log('[imap-sync] account', acc.id, 'lastUid=', lastUid)

      // Backfill for empty thread: fetch older messages that might belong to the thread
      const backfillThreadId = body.backfillForThread
      if (backfillThreadId) {
        const { data: threadRow } = await service.from('inbox_threads')
          .select('id, subject, from_address, imap_account_id')
          .eq('id', backfillThreadId)
          .single()
        const bt = threadRow as { id: string; subject: string | null; from_address: string | null; imap_account_id: string | null } | null
        if (bt?.imap_account_id === acc.id) {
          const { count } = await service.from('inbox_messages').select('id', { count: 'exact', head: true }).eq('thread_id', backfillThreadId)
          if ((count ?? 0) === 0) {
            const threadSubjectNorm = (bt.subject ?? '').replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
            const threadFromNorm = (bt.from_address ?? '').trim().toLowerCase()
            const hasSubject = threadSubjectNorm && threadSubjectNorm !== '(no subject)'
            const hasFrom = !!threadFromNorm

            // Extract distinctive tokens for fuzzy match (e.g. room_xxx@email.upwork.com, long hex IDs)
            const tokens: string[] = []
            if (threadFromNorm) tokens.push(threadFromNorm)
            const roomMatch = (threadSubjectNorm + ' ' + threadFromNorm).match(/room_[a-f0-9]{20,}[^\s]*/gi)
            if (roomMatch) tokens.push(...roomMatch.map((t) => t.toLowerCase().replace(/@$/, '')))
            const longIdMatch = (threadSubjectNorm + ' ' + threadFromNorm).match(/[a-f0-9]{24,}/g)
            if (longIdMatch) tokens.push(...longIdMatch.map((t) => t.toLowerCase()))
            const uniqueTokens = [...new Set(tokens)].filter((t) => t.length >= 20)

            let backfillStart: number
            let backfillEnd: number
            if (lastUid >= 1) {
              backfillStart = Math.max(1, lastUid - 2000)
              backfillEnd = lastUid
            } else {
              const status = await client.status(mailboxPath, { uidNext: true })
              const uidNext = (status?.uidNext as number) ?? 1
              backfillStart = 1
              backfillEnd = Math.max(1, Math.min(500, uidNext - 1))
            }
            const backfillRange = `${backfillStart}:${backfillEnd}`
            console.log('[imap-sync] backfill for thread', backfillThreadId, 'subject:', threadSubjectNorm || '(empty)', 'from:', threadFromNorm || '(empty)', 'tokens:', uniqueTokens.slice(0, 5), 'range', backfillRange)
            try {
              const backfillEnvelopes = await client.fetchAll(backfillRange, { envelope: true, headers: ['message-id', 'in-reply-to', 'references'], uid: true }, { uid: true })
              const existingUids = new Set<number>()
              const { data: existingRows } = await service.from('inbox_messages').select('external_uid').eq('imap_account_id', acc.id).in('external_uid', backfillEnvelopes.map((e) => e.uid as number))
              for (const r of (existingRows ?? []) as { external_uid: number }[]) existingUids.add(r.external_uid)

              const insertRows: Record<string, unknown>[] = []
              const maxFromOnly = 30
              const maxTokenOnly = 50 // when matching by token only (e.g. room_xxx)
              for (const envMsg of backfillEnvelopes) {
                const uid = envMsg.uid as number
                if (existingUids.has(uid)) continue
                const envelope = envMsg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
                const fromAddr = envelope?.from?.[0]?.address ?? ''
                const fromNorm = fromAddr.trim().toLowerCase()
                const msgSubject = envelope?.subject ?? ''
                const msgSubjectNorm = msgSubject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
                const msgText = (msgSubjectNorm + ' ' + fromNorm).toLowerCase()

                const matchesSubject = hasSubject && msgSubjectNorm && (msgSubjectNorm === threadSubjectNorm || msgSubjectNorm.includes(threadSubjectNorm) || threadSubjectNorm.includes(msgSubjectNorm))
                const matchesFromExact = hasFrom && fromNorm === threadFromNorm
                const matchesToken = uniqueTokens.length > 0 && uniqueTokens.some((tok) => msgText.includes(tok))
                const matchesFromOnly = !matchesSubject && !matchesToken && matchesFromExact
                const matchesTokenOnly = !matchesSubject && !matchesFromExact && matchesToken
                if (matchesFromOnly && insertRows.length >= maxFromOnly) continue
                if (matchesTokenOnly && insertRows.length >= maxTokenOnly) continue
                const matchesFrom = matchesSubject || matchesFromOnly || matchesToken

                if (!matchesFrom) continue

                const toAddr = envelope?.to?.[0]?.address ?? ''
                const date = envelope?.date ? new Date(envelope.date) : new Date()
                const backfillDirection = ourAddressesSet.has(normalizeEmail(fromAddr)) ? 'outbound' : 'inbound'
                insertRows.push({
                  thread_id: backfillThreadId, channel: 'email', direction: backfillDirection,
                  from_identifier: fromAddr, to_identifier: toAddr, cc: null, bcc: null,
                  body: null, html_body: null, external_id: `uid-${acc.id}-${uid}`, external_uid: uid,
                  imap_account_id: acc.id, received_at: date.toISOString(),
                })
                existingUids.add(uid)
              }
              if (insertRows.length > 0) {
                const backfillInbound = insertRows.filter((r) => r.direction === 'inbound').length
                const backfillOutbound = insertRows.filter((r) => r.direction === 'outbound').length
                const { error: insErr, count: insCount } = await service.from('inbox_messages').insert(insertRows, { count: 'exact' })
                if (!insErr) {
                  totalMessages += insCount ?? insertRows.length
                  console.log('[imap-sync] backfill inserted', insCount ?? insertRows.length, 'messages for thread', backfillThreadId, 'inbound=', backfillInbound, 'outbound=', backfillOutbound)
                  // Use latest message's received_at, not now() — preserves thread order in list
                  const latestReceived = insertRows.reduce((max, r) => {
                    const t = new Date((r.received_at as string) ?? 0).getTime()
                    return t > max ? t : max
                  }, 0)
                  const lastMsgAt = latestReceived > 0 ? new Date(latestReceived).toISOString() : new Date().toISOString()
                  await service.from('inbox_threads').update({ last_message_at: lastMsgAt, updated_at: lastMsgAt }).eq('id', backfillThreadId)
                }
              } else {
                console.log('[imap-sync] backfill found no matching messages in range', backfillRange)
              }
            } catch (backfillErr) {
              const msg = backfillErr instanceof Error ? backfillErr.message : String(backfillErr)
              console.log('[imap-sync] backfill error:', msg)
              errors.push(`backfill ${backfillThreadId}: ${msg}`)
            }
          }
        }
      }

      // Resync: re-fetch recent messages and update bodies with proper MIME parsing (PostalMime).
      const doResync = body.resync === true && body.accountId === acc.id && lastUid >= 1
      if (doResync) {
        const resyncStart = Math.max(1, lastUid - 24)
        const resyncRange = `${resyncStart}:${lastUid}`
        let messagesUpdated = 0
        try {
          const resyncEnvelopes = await client.fetchAll(resyncRange, { uid: true }, { uid: true })
          for (const envMsg of resyncEnvelopes.slice(0, MAX_BATCH)) {
            const fullMsgs = await client.fetchAll(String(envMsg.uid), { envelope: true, source: true, uid: true }, { uid: true })
            const msg = fullMsgs[0]
            if (!msg) continue
            const uid = msg.uid as number
            const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; date?: Date }
            const source = msg.source as Uint8Array | Buffer | undefined
            const fromHeader = source ? getHeader(source, 'From')?.trim() : null
            const fromAddr = fromHeader || (envelope?.from?.[0]?.address ?? '')
            const toAddr = (envelope?.to?.[0]?.address as string) ?? ''
            const date = envelope?.date ? new Date(envelope.date) : new Date()
            const parsed = source ? await parseBodyFromSource(source) : { body: '', htmlBody: null, attachments: [] }
            const bodyText = parsed.body
            const ccStr = source ? getHeader(source, 'Cc') : null
            const bccStr = source ? getHeader(source, 'Bcc') : null
            const { error: updateErr } = await service
              .from('inbox_messages')
              .update({
                body: bodyText,
                from_identifier: fromAddr,
                to_identifier: toAddr,
                cc: ccStr?.trim() || null,
                bcc: bccStr?.trim() || null,
                received_at: date.toISOString(),
              })
              .eq('imap_account_id', acc.id)
              .eq('external_uid', uid)
            if (!updateErr) messagesUpdated++
          }
          totalMessagesUpdated += messagesUpdated
        } catch (resyncErr) {
          const msg = resyncErr instanceof Error ? resyncErr.message : String(resyncErr)
          errors.push(`${acc.imap_username}: resync: ${msg}`)
        }
      }

      let range: string
      if (lastUid > 0) {
        // Use lastUid:* (inclusive) so Gmail/IMAP edge cases don't miss messages at the boundary
        range = `${lastUid}:*`
      } else {
        const status = await client.status(mailboxPath, { uidNext: true })
        const uidNext = (status?.uidNext as number) ?? 1
        const start = Math.max(1, uidNext - 199)
        range = `${start}:*`
      }
      console.log('[imap-sync] account', acc.id, 'fetch range:', range)

      // Fetch headers only — no body/source download
      const envelopes = await client.fetchAll(range, { envelope: true, headers: ['message-id', 'in-reply-to', 'references', 'cc', 'bcc', 'from'], uid: true }, { uid: true })

      let newMsgs = envelopes
        .filter((m) => {
          const uid = Number(m.uid)
          if (Number.isNaN(uid)) return false
          return uid > lastUid
        })
        .sort((a, b) => (a.uid as number) - (b.uid as number))

      // Boundary recovery: if we fetched uid=lastUid but excluded it, check if it's actually in DB; if not, include it
      if (envelopes.length > 0 && newMsgs.length === 0 && lastUid >= 1) {
        const atBoundary = envelopes.filter((m) => (m.uid as number) === lastUid)
        if (atBoundary.length > 0) {
          const { data: existing } = await service.from('inbox_messages').select('id').eq('imap_account_id', acc.id).eq('external_uid', lastUid).limit(1)
          if (!existing?.length) {
            newMsgs = atBoundary.sort((a, b) => (a.uid as number) - (b.uid as number))
            console.log('[imap-sync] account', acc.id, 'boundary recovery: uid', lastUid, 'not in DB, including')
          } else {
            console.log('[imap-sync] account', acc.id, 'envelope UIDs:', envelopes.map(m => m.uid), 'lastUid=', lastUid)
          }
        } else {
          console.log('[imap-sync] account', acc.id, 'envelope UIDs:', envelopes.map(m => m.uid), 'lastUid=', lastUid)
        }
      }

      console.log('[imap-sync] account', acc.id, 'envelopes=', envelopes.length, 'newMsgs=', newMsgs.length, 'lastUid=', lastUid)

      if (newMsgs.length === 0) {
        console.log('[imap-sync] account', acc.id, 'no new messages — updating last_fetch_at only')
        // Nothing new — skip all processing
        await service.from('imap_accounts').update({ last_fetch_at: new Date().toISOString(), last_error: null }).eq('id', acc.id)
        if (lock) await lock.release()
        lock = null
        await client.logout().catch(() => client.close())
        continue
      }

      // Pre-parse all message metadata in one pass (CPU only, no DB)
      const parsed = newMsgs.map(msg => {
        const uid = msg.uid as number
        const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
        // ImapFlow returns headers as a Buffer of raw header lines
        const rawHdrs = msg.headers ? new TextDecoder().decode(msg.headers as Uint8Array) : ''
        const getHdr = (name: string): string | null => {
          const re = new RegExp(`^${name}:\\s*(.+)`, 'im')
          const m = rawHdrs.match(re)
          return m ? m[1].trim() : null
        }
        const messageId = normalizeMessageId(getHdr('message-id'))
        const inReplyTo = normalizeMessageId(getHdr('in-reply-to'))
        const refsRaw = getHdr('references')
        const refsList: string[] = refsRaw ? (refsRaw.split(/\s+/).map(r => normalizeMessageId(r)).filter(Boolean) as string[]) : []
        const ccRaw = getHdr('cc') ?? getHdr('Cc')
        const bccRaw = getHdr('bcc') ?? getHdr('Bcc')
        const fromHeader = (getHdr('from') ?? getHdr('From') ?? '').trim()
        const fromAddr = fromHeader || (envelope?.from?.[0]?.address ?? '')
        return {
          uid, messageId, inReplyTo, refsList,
          fromAddr,
          toAddr: envelope?.to?.[0]?.address ?? '',
          ccAddr: ccRaw?.trim() || null,
          bccAddr: bccRaw?.trim() || null,
          subject: envelope?.subject ?? '',
          date: envelope?.date ? new Date(envelope.date) : new Date(),
          externalId: messageId ?? `uid-${acc.id}-${uid}`,
        }
      })

      // Batch pre-fetch: all reference IDs → thread mapping (1 query)
      const allRefIds = [...new Set(parsed.flatMap(p => [p.messageId, p.inReplyTo, ...p.refsList].filter(Boolean) as string[]))]
      const refMap = new Map<string, string>()
      if (allRefIds.length > 0) {
        const { data: refRows } = await service.from('inbox_messages')
          .select('external_id, thread_id').eq('imap_account_id', acc.id)
          .in('external_id', allRefIds.slice(0, 200))
        for (const r of (refRows ?? []) as { external_id: string; thread_id: string }[]) {
          refMap.set(r.external_id, r.thread_id)
        }
      }

      // Batch pre-fetch: recent threads for subject matching (1 query)
      const { data: recentThreads } = await service.from('inbox_threads')
        .select('id, subject').eq('org_id', acc.org_id).eq('channel', 'email')
        .gte('last_message_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .order('last_message_at', { ascending: false }).limit(100)
      const subjectThreadMap = new Map<string, string>()
      for (const t of (recentThreads ?? []) as { id: string; subject: string }[]) {
        const norm = (t.subject ?? '').replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
        if (norm && !subjectThreadMap.has(norm)) subjectThreadMap.set(norm, t.id)
      }

      let highestUid = lastUid
      let threadsCreated = 0
      let messagesInserted = 0

      // Batch insert rows (with ON CONFLICT skip for dedup via unique index)
      const insertRows: Record<string, unknown>[] = []

      for (const p of parsed) {
        if (p.uid > highestUid) highestUid = p.uid

        // Thread matching: references → subject → new thread
        let threadId: string | undefined
        for (const refId of [p.inReplyTo, ...p.refsList]) {
          if (refId && refMap.has(refId)) { threadId = refMap.get(refId); break }
        }
        if (!threadId) {
          const normSubject = p.subject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
          if (normSubject) threadId = subjectThreadMap.get(normSubject)
        }
        if (!threadId) {
          const { data: newThread, error: threadErr } = await service.from('inbox_threads')
            .insert({ org_id: acc.org_id, channel: 'email', status: 'open', subject: p.subject || '(No subject)', last_message_at: p.date.toISOString(), imap_account_id: acc.id, from_address: p.fromAddr })
            .select('id').single()
          if (threadErr || !newThread) { errors.push(`${acc.imap_username}: thread: ${threadErr?.message}`); continue }
          threadId = newThread.id
          threadsCreated++
          const norm = p.subject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
          if (norm) subjectThreadMap.set(norm, threadId)
        } else {
          await service.from('inbox_threads')
            .update({ last_message_at: p.date.toISOString(), updated_at: p.date.toISOString(), status: 'open' })
            .eq('id', threadId)
        }

        // Track for future reference lookups within this batch
        if (p.messageId) refMap.set(p.messageId, threadId)

        const direction = ourAddressesSet.has(normalizeEmail(p.fromAddr)) ? 'outbound' : 'inbound'
        // Skip outbound if we already have it from inbox-send-reply (app insert has no external_uid)
        if (direction === 'outbound' && threadId) {
          const cutoff = new Date(p.date.getTime() - 5 * 60 * 1000).toISOString()
          const { data: existing } = await service.from('inbox_messages')
            .select('id')
            .eq('thread_id', threadId)
            .eq('imap_account_id', acc.id)
            .eq('direction', 'outbound')
            .is('external_uid', null)
            .gte('received_at', cutoff)
            .limit(1)
          if (existing?.length) {
            const existingId = (existing[0] as { id: string }).id
            console.log('[imap-sync] account', acc.id, 'outbound dedup: updating existing msg', existingId, 'threadId=', threadId, 'uid=', p.uid, 'from=', p.fromAddr?.slice(0, 40), 'to=', p.toAddr?.slice(0, 40))
            await service.from('inbox_messages')
              .update({ external_id: p.externalId, external_uid: p.uid })
              .eq('id', existingId)
            continue
          }
        }
        insertRows.push({
          thread_id: threadId, channel: 'email', direction,
          from_identifier: p.fromAddr, to_identifier: p.toAddr,
          cc: p.ccAddr ?? null, bcc: p.bccAddr ?? null,
          body: null, html_body: null,
          external_id: p.externalId, external_uid: p.uid,
          imap_account_id: acc.id, received_at: p.date.toISOString(),
        })
      }

      // Batch insert all messages (unique index on imap_account_id+external_uid handles dedup)
      const inboundCount = insertRows.filter((r) => r.direction === 'inbound').length
      const outboundCount = insertRows.filter((r) => r.direction === 'outbound').length
      if (insertRows.length > 0) {
        console.log('[imap-sync] account', acc.id, 'batch insert: rows=', insertRows.length, 'inbound=', inboundCount, 'outbound=', outboundCount)
        const { error: batchErr, count } = await service.from('inbox_messages')
          .insert(insertRows, { count: 'exact' })
        if (batchErr) {
          console.log('[imap-sync] account', acc.id, 'batch insert error:', batchErr.message, 'code=', batchErr.code)
          errors.push(`${acc.imap_username}: batch insert: ${batchErr.message}`)
        } else {
          messagesInserted = count ?? insertRows.length
          console.log('[imap-sync] account', acc.id, 'inserted threads=', threadsCreated, 'messages=', messagesInserted)
        }
      }

      await service
        .from('imap_accounts')
        .update({
          last_fetch_at: new Date().toISOString(),
          last_fetched_uid: highestUid,
          last_error: null,
        })
        .eq('id', acc.id)
      console.log('[imap-sync] account', acc.id, 'updated last_fetched_uid=', highestUid)

      totalThreads += threadsCreated
      totalMessages += messagesInserted

      // Detect messages moved to trash on the server (UIDs gone from inbox)
      // Check recent open threads — if their UIDs no longer exist, mark as archived
      if (highestUid > 0) {
        const { data: recentOpenThreads } = await service.from('inbox_threads')
          .select('id').eq('org_id', acc.org_id).eq('imap_account_id', acc.id)
          .eq('status', 'open').order('last_message_at', { ascending: false }).limit(20)

        for (const t of (recentOpenThreads ?? []) as { id: string }[]) {
          const { data: threadMsgs } = await service.from('inbox_messages')
            .select('external_uid').eq('thread_id', t.id).eq('imap_account_id', acc.id)
            .not('external_uid', 'is', null).limit(1)
          const uid = (threadMsgs?.[0] as { external_uid: number } | undefined)?.external_uid
          if (uid) {
            try {
              const check = await client.fetchAll(String(uid), { uid: true }, { uid: true })
              if (check.length === 0) {
                await service.from('inbox_threads').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', t.id)
              }
            } catch { /* UID might be out of range — skip */ }
          }
        }
      }

      if (lock) await lock.release()
      lock = null

      const trashPath = getTrashMailboxPath(acc.host)
      let trashLock: { release: () => Promise<void> } | null = null
      try {
        trashLock = await client.getMailboxLock(trashPath)
      } catch {
        // Trash folder may not exist on this server
      }
      if (trashLock) {
        try {
          const lastUidTrash = (acc as ImapAccountRow).last_fetched_uid_trash ?? 0
          const trashRange = lastUidTrash > 0 ? `${lastUidTrash + 1}:*` : `${Math.max(1, (client.mailbox?.uidNext ?? 1) - 50)}:*`
          const trashEnvelopes = await client.fetchAll(trashRange, { envelope: true, headers: ['message-id'], uid: true }, { uid: true })
          const trashBatch = trashEnvelopes.filter(m => (m.uid as number) > lastUidTrash).sort((a, b) => (a.uid as number) - (b.uid as number))
          let highestTrashUid = lastUidTrash
          for (const msg of trashBatch) {
            const uid = msg.uid as number
            if (uid > highestTrashUid) highestTrashUid = uid
            const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
            const fromAddr = envelope?.from?.[0]?.address ?? ''
            const toAddr = (envelope?.to?.[0]?.address as string) ?? ''
            const subject = (envelope?.subject as string) ?? ''
            const date = envelope?.date ? new Date(envelope.date) : new Date()
            const rawHdrs2 = msg.headers ? new TextDecoder().decode(msg.headers as Uint8Array) : ''
            const rawMessageId = (() => { const m = rawHdrs2.match(/^message-id:\s*(.+)/im); return m ? m[1].trim() : null })()
            const messageId = normalizeMessageId(rawMessageId)
            const externalId = messageId ?? `trash-${acc.id}-${uid}`

            const { data: existingByMsgId } = messageId
              ? await service
                  .from('inbox_messages')
                  .select('thread_id')
                  .eq('imap_account_id', acc.id)
                  .eq('external_id', messageId)
                  .limit(1)
              : { data: null }
            if (existingByMsgId?.[0]?.thread_id) {
              await service
                .from('inbox_threads')
                .update({ status: 'archived', updated_at: date.toISOString(), last_message_at: date.toISOString() })
                .eq('id', existingByMsgId[0].thread_id)
              continue
            }
            const { data: existingTrash } = await service
              .from('inbox_messages')
              .select('id')
              .eq('imap_account_id', acc.id)
              .eq('external_uid', uid)
              .limit(1)
            if (existingTrash?.length) continue

            const { data: newThread, error: threadErr } = await service
              .from('inbox_threads')
              .insert({
                org_id: acc.org_id,
                channel: 'email',
                status: 'archived',
                subject: subject || '(No subject)',
                last_message_at: date.toISOString(),
              })
              .select('id')
              .single()
            if (threadErr || !newThread) continue
            const trashDirection = ourAddressesSet.has(normalizeEmail(fromAddr)) ? 'outbound' : 'inbound'
            console.log('[imap-sync] account', acc.id, 'trash insert: direction=', trashDirection, 'from=', fromAddr?.slice(0, 30), 'to=', toAddr?.slice(0, 30))
            const { error: msgErr } = await service.from('inbox_messages').insert({
              thread_id: newThread.id,
              channel: 'email',
              direction: trashDirection,
              from_identifier: fromAddr,
              to_identifier: toAddr,
              body: null,
              html_body: null,
              external_id: messageId ?? externalId,
              external_uid: uid,
              imap_account_id: acc.id,
              received_at: date.toISOString(),
            })
            if (!msgErr) {
              totalThreads++
              totalMessages++
            }
          }
          await service
            .from('imap_accounts')
            .update({ last_fetched_uid_trash: highestTrashUid })
            .eq('id', acc.id)
        } finally {
          await trashLock.release()
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log('[imap-sync] account', acc.id, 'error:', msg)
      errors.push(`${acc.imap_username}: ${msg}`)
      await service.from('imap_accounts').update({ last_error: msg }).eq('id', acc.id)
    } finally {
      if (lock) await lock.release()
      try {
        await client.logout()
      } catch {
        client.close()
      }
    }
  }

  const result = {
    synced: (accounts as ImapAccountRow[]).length,
    threadsCreated: totalThreads,
    messagesInserted: totalMessages,
    messagesUpdated: totalMessagesUpdated,
    errors: errors.length ? errors : undefined,
  }
  console.log('[imap-sync]', syncId, 'done:', result)
  return new Response(
    JSON.stringify(result),
    { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
})
