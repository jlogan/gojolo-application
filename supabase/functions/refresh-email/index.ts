// Public endpoint: for a given IMAP account email, fetches new messages after last_fetched_uid
// and stores them in inbox_threads + inbox_messages (same logic as imap-sync, inlined).
// No user auth. Security: optional REFRESH_EMAIL_SECRET (Bearer or x-refresh-secret).
// Requires: ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY.
// Optional: REFRESH_EMAIL_SECRET — if set, requests must send Authorization: Bearer <secret> or x-refresh-secret: <secret>.
// Deploy with: supabase functions deploy refresh-email --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')
const refreshSecret = Deno.env.get('REFRESH_EMAIL_SECRET') ?? ''

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface ImapAccountRow {
  id: string
  org_id: string
  host: string
  port: number
  imap_encryption: string
  imap_username: string
  credentials_encrypted: string
  last_fetched_uid: number | null
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

function getMailboxPath(host: string): string {
  return host && host.toLowerCase().includes('gmail.com') ? '[Gmail]/All Mail' : 'INBOX'
}

function normalizeMessageId(id: string | null): string | null {
  if (!id || !id.trim()) return null
  const s = id.trim().replace(/^</, '').replace(/>$/, '').trim()
  return s || null
}

function jsonRes(payload: { status: string }, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function redactSecret(s: string): string {
  if (!s || s.length === 0) return '(empty)'
  if (s.length <= 8) return '***'
  return s.slice(0, 4) + '…' + s.length
}

Deno.serve(async (req: Request) => {
  try {
    return await handleRefreshEmail(req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log('[refresh-email] uncaught error:', msg)
    return jsonRes({ status: 'error' }, 500)
  }
})

async function handleRefreshEmail(req: Request): Promise<Response> {
  console.log('[refresh-email] request method:', req.method, 'url:', req.url)

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    console.log('[refresh-email] rejected: method not allowed')
    return jsonRes({ status: 'error' }, 405)
  }

  // Debug: log request headers (redact secret values).
  const authHeader = req.headers.get('Authorization')
  const xSecret = req.headers.get('x-refresh-secret')
  console.log(
    '[refresh-email] request headers:',
    'Authorization:', authHeader ? (authHeader.startsWith('Bearer ') ? 'Bearer ' + redactSecret(authHeader.slice(7)) : redactSecret(authHeader)) : '(missing)',
    'x-refresh-secret:', xSecret ? redactSecret(xSecret) : '(missing)'
  )

  // Optional shared secret: require Bearer token or x-refresh-secret header if REFRESH_EMAIL_SECRET is set.
  if (refreshSecret) {
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
    const headerSecret = (req.headers.get('x-refresh-secret') ?? '').trim()
    const provided = (bearer ?? headerSecret).trim()
    const expected = refreshSecret.trim()
    if (provided !== expected) {
      console.log('[refresh-email] rejected: invalid or missing secret')
      return jsonRes({ status: 'error' }, 401)
    }
  }

  let body: { email?: string }
  try {
    body = await req.json()
    console.log('[refresh-email] request body:', JSON.stringify(body), '| has email:', typeof body?.email === 'string')
  } catch (e) {
    console.log('[refresh-email] body parse failed:', e instanceof Error ? e.message : String(e))
    return jsonRes({ status: 'error' }, 400)
  }

  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!email || !EMAIL_REGEX.test(email)) {
    console.log('[refresh-email] invalid or missing email')
    return jsonRes({ status: 'error' }, 400)
  }

  console.log('[refresh-email] checking email for', email)

  if (!serviceKey) {
    console.log('[refresh-email] env missing: SUPABASE_SERVICE_ROLE_KEY')
    console.log('[refresh-email] found 0 emails')
    return jsonRes({ status: 'error' }, 200)
  }
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    console.log('[refresh-email] env missing or too short: ENCRYPTION_KEY (need 64 hex chars)')
    console.log('[refresh-email] found 0 emails')
    return jsonRes({ status: 'error' }, 200)
  }

  const service = createClient(supabaseUrl, serviceKey)
  const emailNorm = email.trim().toLowerCase()
  console.log('[refresh-email] querying imap_accounts for email (is_active=true)', { email: emailNorm })

  const cols = 'id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted, last_fetched_uid, email, addresses'
  const base = () => service.from('imap_accounts').select(cols).eq('is_active', true)

  // 1) Match by primary email, then by imap_username
  let { data: accounts, error: accountsError } = await base().ilike('email', emailNorm).limit(1)
  if (!accounts?.length && !accountsError) {
    const byUsername = await base().ilike('imap_username', emailNorm).limit(1)
    accounts = byUsername.data ?? []
    accountsError = byUsername.error ?? accountsError
  }

  if (accountsError) {
    console.log('[refresh-email] imap_accounts query error:', accountsError.message)
    console.log('[refresh-email] found 0 emails')
    return jsonRes({ status: 'error' }, 200)
  }

  // 2) If not found, check if the requested email is an alias (addresses array) of any account
  if (!accounts?.length) {
    console.log('[refresh-email] no account by email/imap_username, checking aliases (addresses)')
    const aliasRes = await base().contains('addresses', [emailNorm]).limit(1)
    if (aliasRes.error) {
      console.log('[refresh-email] imap_accounts alias query error:', aliasRes.error.message)
      console.log('[refresh-email] found 0 emails')
      return jsonRes({ status: 'error' }, 200)
    }
    accounts = aliasRes.data ?? []
    if (accounts.length) {
      console.log('[refresh-email] found account by alias:', emailNorm)
    }
  }

  if (!accounts?.length) {
    console.log('[refresh-email] no active imap_account found for this email or alias')
    console.log('[refresh-email] found 0 emails')
    return jsonRes({ status: 'error' }, 200)
  }

  const acc = accounts[0] as ImapAccountRow
  console.log('[refresh-email] account id:', acc.id, 'host:', acc.host, 'last_fetched_uid:', acc.last_fetched_uid)

  const { data: orgAccounts } = await service.from('imap_accounts').select('email, addresses').eq('org_id', acc.org_id).eq('is_active', true)
  const ourAddressesSet = new Set<string>()
  const normalizeEmail = (addr: string) => {
    if (!addr?.trim()) return ''
    const m = addr.trim().match(/<([^>]+)>/)
    return (m ? m[1] : addr).trim().toLowerCase()
  }
  for (const a of (orgAccounts ?? []) as { email?: string; addresses?: string[] }[]) {
    if (a.email) ourAddressesSet.add(normalizeEmail(a.email))
    for (const alias of a.addresses ?? []) {
      if (alias?.trim()) ourAddressesSet.add(normalizeEmail(alias))
    }
  }

  let password: string
  try {
    password = await decrypt(acc.credentials_encrypted, encryptionKeyHex.slice(0, 64))
    console.log('[refresh-email] credentials decrypted ok')
  } catch (e) {
    console.log('[refresh-email] decrypt failed:', e instanceof Error ? e.message : String(e))
    console.log('[refresh-email] found 0 emails')
    return jsonRes({ status: 'error' }, 200)
  }

  const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
  const port = Number(acc.port) || (secure ? 993 : 143)
  console.log('[refresh-email] connecting IMAP', acc.host + ':' + port, 'secure:', secure)

  const client = new ImapFlow({
    host: acc.host,
    port,
    secure,
    auth: { user: acc.imap_username, pass: password },
  })

  // Prevent ECONNRESET / connection errors from becoming uncaught exceptions
  client.on('error', (err: Error) => {
    console.log('[refresh-email] IMAP client error (connection/reset):', err?.message ?? String(err))
  })

  try {
    await client.connect()
    console.log('[refresh-email] IMAP connected')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log('[refresh-email] IMAP connect failed:', msg)
    console.log('[refresh-email] found 0 emails')
    return jsonRes({ status: 'error' }, 200)
  }

  let n = 0
  let threadsCreated = 0
  let messagesInserted = 0

  try {
    const mailboxPath = getMailboxPath(acc.host)
    console.log('[refresh-email] mailbox path:', mailboxPath)

    const lock = await client.getMailboxLock(mailboxPath)
    console.log('[refresh-email] mailbox lock acquired')

    const lastUid = acc.last_fetched_uid ?? 0
    console.log('[refresh-email] last_fetched_uid:', lastUid)

    let range: string
    if (lastUid > 0) {
      // Use lastUid:* (inclusive) so Gmail/IMAP edge cases don't miss messages at the boundary
      range = `${lastUid}:*`
      console.log('[refresh-email] range (after last uid):', range)
    } else {
      const status = await client.status(mailboxPath, { uidNext: true })
      const uidNext = (status?.uidNext as number) ?? 1
      const start = Math.max(1, uidNext - 199)
      range = `${start}:*`
      console.log('[refresh-email] range (first sync, uidNext:', uidNext, 'start:', start, '):', range)
    }

    const envelopes = await client.fetchAll(range, {
      envelope: true,
      headers: ['message-id', 'in-reply-to', 'references', 'cc', 'bcc', 'from'],
      uid: true,
    }, { uid: true })
    console.log('[refresh-email] fetchAll returned', envelopes.length, 'envelope(s)')

    let newMsgs = envelopes
      .filter((m) => (m.uid as number) > lastUid)
      .sort((a, b) => (a.uid as number) - (b.uid as number))

    // Boundary recovery: if we fetched uid=lastUid but excluded it, check if it's actually in DB; if not, include it
    if (envelopes.length > 0 && newMsgs.length === 0 && lastUid >= 1) {
      const atBoundary = envelopes.filter((m) => (m.uid as number) === lastUid)
      if (atBoundary.length > 0) {
        const { data: existing } = await service.from('inbox_messages').select('id').eq('imap_account_id', acc.id).eq('external_uid', lastUid).limit(1)
        if (!existing?.length) {
          newMsgs = atBoundary.sort((a, b) => (a.uid as number) - (b.uid as number))
          console.log('[refresh-email] boundary recovery: uid', lastUid, 'not in DB, including')
        }
      }
    }

    n = newMsgs.length
    console.log('[refresh-email] new messages (uid >', lastUid, '):', n)

    if (n === 0) {
      await service.from('imap_accounts').update({ last_fetch_at: new Date().toISOString(), last_error: null }).eq('id', acc.id)
      await lock.release()
      console.log('[refresh-email] mailbox lock released, no new messages')
      await client.logout().catch(() => client.close())
      console.log('[refresh-email] found 0 emails')
      return jsonRes({ status: 'ok' }, 200)
    }

    type ParsedMeta = {
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
    }

    const parsed: ParsedMeta[] = newMsgs.map((msg) => {
      const uid = msg.uid as number
      const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
      const rawHdrs = msg.headers ? new TextDecoder().decode(msg.headers as Uint8Array) : ''
      const getHdr = (name: string): string | null => {
        const re = new RegExp(`^${name}:\\s*(.+)`, 'im')
        const m = rawHdrs.match(re)
        return m ? m[1].trim() : null
      }
      const messageId = normalizeMessageId(getHdr('message-id'))
      const inReplyTo = normalizeMessageId(getHdr('in-reply-to'))
      const refsRaw = getHdr('references')
      const refsList: string[] = refsRaw ? (refsRaw.split(/\s+/).map((r) => normalizeMessageId(r)).filter(Boolean) as string[]) : []
      const ccRaw = getHdr('cc') ?? getHdr('Cc')
      const bccRaw = getHdr('bcc') ?? getHdr('Bcc')
      const fromHeader = (getHdr('from') ?? getHdr('From') ?? '').trim()
      const fromAddr = fromHeader || (envelope?.from?.[0]?.address ?? '')
      return {
        uid,
        messageId,
        inReplyTo,
        refsList,
        fromAddr,
        toAddr: (envelope?.to?.[0]?.address as string) ?? '',
        ccAddr: ccRaw?.trim() || null,
        bccAddr: bccRaw?.trim() || null,
        subject: envelope?.subject ?? '',
        date: envelope?.date ? new Date(envelope.date) : new Date(),
        externalId: messageId ?? `uid-${acc.id}-${uid}`,
      }
    })

    const allRefIds = [...new Set(parsed.flatMap((p) => [p.messageId, p.inReplyTo, ...p.refsList].filter(Boolean) as string[]))]
    const refMap = new Map<string, string>()
    if (allRefIds.length > 0) {
      const { data: refRows } = await service
        .from('inbox_messages')
        .select('external_id, thread_id')
        .eq('imap_account_id', acc.id)
        .in('external_id', allRefIds.slice(0, 200))
      for (const r of (refRows ?? []) as { external_id: string; thread_id: string }[]) {
        refMap.set(r.external_id, r.thread_id)
      }
      console.log('[refresh-email] refMap size:', refMap.size)
    }

    const { data: recentThreads } = await service
      .from('inbox_threads')
      .select('id, subject')
      .eq('org_id', acc.org_id)
      .eq('channel', 'email')
      .gte('last_message_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('last_message_at', { ascending: false })
      .limit(100)
    const subjectThreadMap = new Map<string, string>()
    for (const t of (recentThreads ?? []) as { id: string; subject: string }[]) {
      const norm = (t.subject ?? '').replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
      if (norm && !subjectThreadMap.has(norm)) subjectThreadMap.set(norm, t.id)
    }
    console.log('[refresh-email] subjectThreadMap size:', subjectThreadMap.size)

    let highestUid = lastUid
    const insertRows: Record<string, unknown>[] = []

    for (const p of parsed) {
      if (p.uid > highestUid) highestUid = p.uid

      let threadId: string | undefined
      for (const refId of [p.inReplyTo, ...p.refsList]) {
        if (refId && refMap.has(refId)) {
          threadId = refMap.get(refId)
          break
        }
      }
      if (!threadId) {
        const normSubject = p.subject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
        if (normSubject) threadId = subjectThreadMap.get(normSubject)
      }
      if (!threadId) {
        const { data: newThread, error: threadErr } = await service
          .from('inbox_threads')
          .insert({
            org_id: acc.org_id,
            channel: 'email',
            status: 'open',
            subject: p.subject || '(No subject)',
            last_message_at: p.date.toISOString(),
            imap_account_id: acc.id,
            from_address: p.fromAddr,
          })
          .select('id')
          .single()
        if (threadErr || !newThread) {
          console.log('[refresh-email] thread insert error:', threadErr?.message)
          continue
        }
        threadId = newThread.id
        threadsCreated++
        const norm = p.subject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
        if (norm && threadId) subjectThreadMap.set(norm, threadId)
      } else {
        await service
          .from('inbox_threads')
          .update({ last_message_at: p.date.toISOString(), updated_at: p.date.toISOString(), status: 'open' })
          .eq('id', threadId!)
      }

      if (!threadId) continue

      const tid = threadId as string
      if (p.messageId) refMap.set(p.messageId, tid)

      const direction = ourAddressesSet.has(normalizeEmail(p.fromAddr)) ? 'outbound' : 'inbound'
      // Skip outbound insert if we already have it from inbox-send-reply (app insert has no external_uid)
      if (direction === 'outbound') {
        const cutoff = new Date(p.date.getTime() - 5 * 60 * 1000).toISOString()
        const { data: existing } = await service
          .from('inbox_messages')
          .select('id')
          .eq('thread_id', tid)
          .eq('imap_account_id', acc.id)
          .eq('direction', 'outbound')
          .is('external_uid', null)
          .gte('received_at', cutoff)
          .limit(1)
        if (existing?.length) {
          const existingId = (existing[0] as { id: string }).id
          console.log('[refresh-email] outbound dedup: updating existing msg', existingId, 'threadId=', tid, 'uid=', p.uid)
          await service
            .from('inbox_messages')
            .update({ external_id: p.externalId, external_uid: p.uid })
            .eq('id', existingId)
          continue
        }
      }
      insertRows.push({
        thread_id: tid,
        channel: 'email',
        direction,
        from_identifier: p.fromAddr,
        to_identifier: p.toAddr,
        cc: p.ccAddr ?? null,
        bcc: p.bccAddr ?? null,
        body: null,
        html_body: null,
        external_id: p.externalId,
        external_uid: p.uid,
        imap_account_id: acc.id,
        received_at: p.date.toISOString(),
      })
    }

    if (insertRows.length > 0) {
      const inboundCount = insertRows.filter((r) => r.direction === 'inbound').length
      const outboundCount = insertRows.filter((r) => r.direction === 'outbound').length
      console.log('[refresh-email] batch insert: rows=', insertRows.length, 'inbound=', inboundCount, 'outbound=', outboundCount)
      const { error: batchErr, count } = await service.from('inbox_messages').insert(insertRows, { count: 'exact' })
      if (batchErr) {
        console.log('[refresh-email] batch insert error:', batchErr.message, 'code=', batchErr.code)
      } else {
        messagesInserted = count ?? insertRows.length
        console.log('[refresh-email] inserted', messagesInserted, 'message(s),', threadsCreated, 'new thread(s)')
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
    console.log('[refresh-email] updated imap_accounts last_fetched_uid:', highestUid)

    try {
      await lock.release()
      console.log('[refresh-email] mailbox lock released')
    } catch (releaseErr) {
      console.log('[refresh-email] lock release error (ignored):', releaseErr instanceof Error ? releaseErr.message : String(releaseErr))
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log('[refresh-email] mailbox/sync error:', msg)
    try {
      await service.from('imap_accounts').update({ last_error: msg }).eq('id', acc.id)
    } catch {
      // ignore update error
    }
    n = 0
  } finally {
    console.log('[refresh-email] closing IMAP connection')
    try {
      await client.logout()
    } catch (e) {
      console.log('[refresh-email] logout error (ignored):', e instanceof Error ? e.message : String(e))
    }
    try {
      client.close()
    } catch {
      // ignore
    }
  }

  console.log('[refresh-email] found', n, n === 1 ? 'email' : 'emails', '| stored:', messagesInserted, 'messages,', threadsCreated, 'new threads')
  return jsonRes({ status: 'ok' }, 200)
}
