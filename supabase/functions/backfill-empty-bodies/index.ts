/**
 * Admin / power-user: fetch IMAP bodies for up to N messages that still have null/empty body+html
 * for a given IMAP account (same lazy-load path as fetch-thread-bodies).
 *
 * POST { orgId, accountId, limit?: number } — limit capped at 50, default 50.
 * Auth: org member with is_org_admin OR inbox.view (same as imap-sync manual calls).
 */
const MAX_PER_CALL = 50

import { createClient } from 'npm:@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import PostalMime from 'npm:postal-mime'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

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

Deno.serve(async (req: Request) => {
  const t0 = performance.now()
  console.log('[backfill-empty-bodies] request', { method: req.method })

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405)

  const body = await req.json().catch(() => ({})) as {
    orgId?: string
    accountId?: string
    limit?: number
  }
  const orgId = body.orgId?.trim()
  const accountId = body.accountId?.trim()
  const limit = Math.min(MAX_PER_CALL, Math.max(1, Math.floor(body.limit ?? MAX_PER_CALL)))

  console.log('[backfill-empty-bodies] params', { orgId, accountId, limit })

  if (!orgId || !accountId) {
    console.log('[backfill-empty-bodies] missing orgId or accountId')
    return jsonRes({ error: 'orgId and accountId required' }, 400)
  }

  const auth = req.headers.get('Authorization')
  if (!auth) {
    console.log('[backfill-empty-bodies] no Authorization header')
    return jsonRes({ error: 'Unauthorized' }, 401)
  }

  const service = createClient(supabaseUrl, serviceKey)
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } })

  console.log('[backfill-empty-bodies] checking permissions')
  const [adminRes, permRes] = await Promise.all([
    userClient.rpc('is_org_admin', { p_org_id: orgId }),
    userClient.rpc('user_has_permission', { p_org_id: orgId, p_permission: 'inbox.view' }),
  ])
  console.log('[backfill-empty-bodies] permissions', { isAdmin: adminRes.data, hasInboxView: permRes.data, adminErr: adminRes.error?.message, permErr: permRes.error?.message })
  if (adminRes.data !== true && permRes.data !== true) {
    return jsonRes({ error: 'Forbidden: org admin or inbox.view required' }, 403)
  }

  console.log('[backfill-empty-bodies] loading IMAP account', { accountId, orgId })
  const { data: accRow, error: accErr } = await service
    .from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .eq('is_active', true)
    .maybeSingle()

  if (accErr || !accRow) {
    console.log('[backfill-empty-bodies] account not found', { accErr: accErr?.message, hasRow: !!accRow })
    return jsonRes({ error: 'IMAP account not found or not in this workspace' }, 404)
  }
  console.log('[backfill-empty-bodies] account loaded', { host: accRow.host, username: accRow.imap_username })

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    console.log('[backfill-empty-bodies] ENCRYPTION_KEY not configured')
    return jsonRes({ error: 'ENCRYPTION_KEY not configured' }, 500)
  }

  // Find messages needing body — try RPC first, fall back to direct query if RPC doesn't exist yet
  type MsgRow = { id: string; thread_id: string; external_uid: number; body: string | null; html_body: string | null; direction: string }
  let msgs: MsgRow[] = []

  console.log('[backfill-empty-bodies] querying messages needing body (limit:', limit, ')')

  // Try RPC first, fall back to direct query if RPC not deployed
  const { data: rpcRows, error: rpcErr } = await service.rpc('inbox_messages_needing_body_for_account', {
    p_account_id: accountId,
    p_org_id: orgId,
    p_limit: limit,
  })

  if (rpcErr) {
    console.log('[backfill-empty-bodies] RPC failed (may not be deployed yet), falling back to direct query:', rpcErr.message)
  }

  if (!rpcErr && rpcRows) {
    msgs = (rpcRows ?? []) as MsgRow[]
    console.log('[backfill-empty-bodies] RPC returned', msgs.length, 'messages needing body')
  } else {
    // Direct query: messages for this account with empty bodies
    const { data: directRows, error: directErr } = await service
      .from('inbox_messages')
      .select('id, thread_id, external_uid, body, html_body, direction, imap_account_id')
      .eq('imap_account_id', accountId)
      .eq('channel', 'email')
      .not('external_uid', 'is', null)
      .or('body.is.null,body.eq.,html_body.is.null,html_body.eq.')
      .order('received_at', { ascending: false })
      .limit(limit * 2)
    if (directErr) {
      console.error('[backfill-empty-bodies] direct query failed:', directErr.message)
      return jsonRes({ error: directErr.message, filled: 0 }, 500)
    }
    const directFiltered = ((directRows ?? []) as (MsgRow & { imap_account_id?: string })[]).filter((m) => {
      const bEmpty = m.body == null || (typeof m.body === 'string' && !m.body.trim())
      const hEmpty = m.html_body == null || (typeof m.html_body === 'string' && !m.html_body.trim())
      return bEmpty && hEmpty && m.external_uid != null
    })
    console.log('[backfill-empty-bodies] direct query: raw', directRows?.length, '→ filtered', directFiltered.length)

    // Also find messages with NULL imap_account_id on threads owned by this account
    const { data: orphanRows, error: orphanErr } = await service
      .from('inbox_messages')
      .select('id, thread_id, external_uid, body, html_body, direction, imap_account_id')
      .is('imap_account_id', null)
      .eq('channel', 'email')
      .not('external_uid', 'is', null)
      .or('body.is.null,body.eq.,html_body.is.null,html_body.eq.')
      .order('received_at', { ascending: false })
      .limit(limit * 2)
    if (!orphanErr && orphanRows?.length) {
      // Filter to messages on threads that belong to this account's org
      const orphanThreadIds = [...new Set((orphanRows as { thread_id: string }[]).map((r) => r.thread_id))]
      const { data: threadCheck } = await service
        .from('inbox_threads')
        .select('id')
        .in('id', orphanThreadIds.slice(0, 200))
        .eq('org_id', orgId)
      const validThreadIds = new Set((threadCheck ?? []).map((t: { id: string }) => t.id))
      const orphanFiltered = (orphanRows as (MsgRow & { imap_account_id?: string | null })[]).filter((m) => {
        const bEmpty = m.body == null || (typeof m.body === 'string' && !m.body.trim())
        const hEmpty = m.html_body == null || (typeof m.html_body === 'string' && !m.html_body.trim())
        return bEmpty && hEmpty && m.external_uid != null && validThreadIds.has(m.thread_id)
      })
      if (orphanFiltered.length > 0) {
        console.log('[backfill-empty-bodies] found', orphanFiltered.length, 'orphan messages (null imap_account_id) on org threads — patching')
        await service.from('inbox_messages')
          .update({ imap_account_id: accountId })
          .in('id', orphanFiltered.map((m) => m.id))
        for (const m of orphanFiltered) m.imap_account_id = accountId
        directFiltered.push(...orphanFiltered)
      }
    }
    msgs = directFiltered.slice(0, limit)
    console.log('[backfill-empty-bodies] total messages to process:', msgs.length)
  }

  if (msgs.length === 0) {
    console.log('[backfill-empty-bodies] no messages need body fetch, done')
    return jsonRes({ filled: 0, message: 'No messages need body fetch for this account.' }, 200)
  }

  console.log('[backfill-empty-bodies] messages to process:', msgs.map((m) => ({ id: m.id.slice(0, 8), uid: m.external_uid, dir: m.direction })))

  let password: string
  try {
    password = await decrypt(accRow.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
    console.log('[backfill-empty-bodies] credentials decrypted ok')
  } catch (e) {
    console.error('[backfill-empty-bodies] decrypt failed:', (e as Error).message)
    return jsonRes({ error: 'Failed to decrypt credentials', filled: 0 }, 500)
  }

  const acc = accRow as { org_id: string; host: string; port: number; imap_encryption: string; imap_username: string }
  const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
  const isGmail = acc.host.toLowerCase().includes('gmail.com')
  const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'

  console.log('[backfill-empty-bodies] connecting IMAP', { host: acc.host, port: Number(acc.port) || 993, secure, mailbox: mailboxPath })

  const client = new ImapFlow({
    host: acc.host,
    port: Number(acc.port) || 993,
    secure,
    auth: { user: acc.imap_username, pass: password },
    logger: false,
  })
  client.on('error', (err: Error) => {
    console.log('[backfill-empty-bodies] IMAP client error:', err?.message ?? String(err))
  })

  const MAX_BODY = 50000
  const rawToBytes = (raw: unknown) =>
    raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBuffer) ?? [])

  let filled = 0
  let skipped = 0
  let errored = 0

  try {
    await client.connect()
    console.log('[backfill-empty-bodies] IMAP connected', { elapsedMs: Math.round(performance.now() - t0) })

    const lock = await client.getMailboxLock(mailboxPath)
    console.log('[backfill-empty-bodies] mailbox lock acquired', { mailbox: mailboxPath, elapsedMs: Math.round(performance.now() - t0) })

    try {
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const tMsg = performance.now()
        try {
          console.log('[backfill-empty-bodies] fetching', i + 1, '/', msgs.length, { id: msg.id.slice(0, 8), uid: msg.external_uid, direction: msg.direction })
          const fetched = await client.fetchAll(String(msg.external_uid), { source: true, uid: true }, { uid: true })
          const source = fetched[0]?.source as Uint8Array | undefined
          if (!source) {
            console.log('[backfill-empty-bodies] no source returned for UID', msg.external_uid, '— marking as unavailable so it won\'t retry')
            await service.from('inbox_messages')
              .update({ body: '[Message no longer available on mail server]' })
              .eq('id', msg.id)
            skipped++
            continue
          }
          console.log('[backfill-empty-bodies] source fetched', { uid: msg.external_uid, bytes: source.byteLength, fetchMs: Math.round(performance.now() - tMsg) })

          const parsed = await PostalMime.parse(source)
          let bodyText = parsed.text ?? ''
          let htmlBody = parsed.html ?? null
          console.log('[backfill-empty-bodies] parsed', { uid: msg.external_uid, textLen: bodyText.length, htmlLen: htmlBody?.length ?? 0, attachments: (parsed.attachments ?? []).length })

          const inlineAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => a.contentId)
          if (htmlBody && inlineAtts.length > 0) {
            for (const att of inlineAtts) {
              const cid = att.contentId!.replace(/^<|>$/g, '')
              const fname = att.filename ?? `inline-${cid}`
              const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${fname}`
              const contentBytes = rawToBytes(att.content)
              const { error: upErr } = await service.storage
                .from('inbox-attachments')
                .upload(path, contentBytes, { contentType: att.mimeType ?? 'application/octet-stream' })
              if (!upErr) {
                const { data: urlData } = service.storage.from('inbox-attachments').getPublicUrl(path)
                htmlBody = htmlBody!.replace(
                  new RegExp('cid:' + cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                  urlData.publicUrl
                )
                await service.from('inbox_attachments').insert({
                  message_id: msg.id,
                  thread_id: msg.thread_id,
                  file_name: fname,
                  file_path: path,
                  file_size: contentBytes.length,
                  content_type: att.mimeType,
                })
              }
            }
          }

          const fileAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => !a.contentId)
          for (const att of fileAtts) {
            const fname = att.filename ?? `attachment-${Date.now()}`
            const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${fname}`
            const contentBytes = rawToBytes(att.content)
            const { error: upErr } = await service.storage
              .from('inbox-attachments')
              .upload(path, contentBytes, { contentType: att.mimeType ?? 'application/octet-stream' })
            if (!upErr) {
              await service.from('inbox_attachments').insert({
                message_id: msg.id,
                thread_id: msg.thread_id,
                file_name: fname,
                file_path: path,
                file_size: contentBytes.length,
                content_type: att.mimeType,
              })
            }
          }

          if (bodyText.length > MAX_BODY) bodyText = bodyText.slice(0, MAX_BODY)
          if (htmlBody && htmlBody.length > MAX_BODY) htmlBody = htmlBody.slice(0, MAX_BODY)

          const { error: upDb } = await service
            .from('inbox_messages')
            .update({ body: bodyText || null, html_body: htmlBody })
            .eq('id', msg.id)
          if (upDb) {
            console.error('[backfill-empty-bodies] DB update failed for', msg.id.slice(0, 8), upDb.message)
            errored++
          } else {
            filled++
            console.log('[backfill-empty-bodies] message done', { id: msg.id.slice(0, 8), uid: msg.external_uid, bodyLen: bodyText.length, htmlLen: htmlBody?.length ?? 0, msgMs: Math.round(performance.now() - tMsg) })
          }
        } catch (oneErr) {
          errored++
          console.error('[backfill-empty-bodies] message failed', { id: msg.id.slice(0, 8), uid: msg.external_uid, error: (oneErr as Error).message })
        }
      }
    } finally {
      try { await lock.release() } catch { /* dead connection */ }
    }
    await client.logout().catch(() => { try { client.close() } catch { /* ignore */ } })
  } catch (err) {
    console.error('[backfill-empty-bodies] IMAP error:', (err as Error).message)
    try { await client.logout() } catch { try { client.close() } catch { /* ignore */ } }
    return jsonRes({ error: (err as Error).message, filled, skipped, errored }, 500)
  }

  const totalMs = Math.round(performance.now() - t0)
  console.log('[backfill-empty-bodies] done', { filled, skipped, errored, requested: msgs.length, totalMs })
  return jsonRes({
    filled,
    skipped,
    errored,
    requested: msgs.length,
    message: filled > 0
      ? `Fetched bodies for ${filled} message(s)${skipped ? `, ${skipped} skipped (no IMAP source)` : ''}${errored ? `, ${errored} errored` : ''}. Run sync again if more remain.`
      : 'No bodies could be loaded (check Edge Function logs).',
  }, 200)
})
