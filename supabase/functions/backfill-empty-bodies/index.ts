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

  if (!orgId || !accountId) return jsonRes({ error: 'orgId and accountId required' }, 400)

  const auth = req.headers.get('Authorization')
  if (!auth) return jsonRes({ error: 'Unauthorized' }, 401)

  const service = createClient(supabaseUrl, serviceKey)
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } })

  const [adminRes, permRes] = await Promise.all([
    userClient.rpc('is_org_admin', { p_org_id: orgId }),
    userClient.rpc('user_has_permission', { p_org_id: orgId, p_permission: 'inbox.view' }),
  ])
  if (adminRes.data !== true && permRes.data !== true) {
    return jsonRes({ error: 'Forbidden: org admin or inbox.view required' }, 403)
  }

  const { data: accRow, error: accErr } = await service
    .from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .eq('is_active', true)
    .maybeSingle()

  if (accErr || !accRow) {
    return jsonRes({ error: 'IMAP account not found or not in this workspace' }, 404)
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return jsonRes({ error: 'ENCRYPTION_KEY not configured' }, 500)
  }

  const { data: rpcRows, error: rpcErr } = await service.rpc('inbox_messages_needing_body_for_account', {
    p_account_id: accountId,
    p_org_id: orgId,
    p_limit: limit,
  })

  if (rpcErr) {
    console.error('[backfill-empty-bodies] rpc error', rpcErr)
    return jsonRes({ error: rpcErr.message, filled: 0 }, 500)
  }

  const msgs = (rpcRows ?? []) as {
    id: string
    thread_id: string
    external_uid: number
    body: string | null
    html_body: string | null
    direction: string
  }[]

  if (msgs.length === 0) {
    return jsonRes({ filled: 0, message: 'No messages need body fetch for this account.' }, 200)
  }

  const { data: attRows } = await service
    .from('inbox_attachments')
    .select('message_id, file_name, file_path')
    .in('message_id', msgs.map((m) => m.id))
  const attsByMsg = new Map<string, { file_name: string; file_path: string }[]>()
  for (const a of (attRows ?? []) as { message_id: string; file_name: string; file_path: string }[]) {
    const list = attsByMsg.get(a.message_id) ?? []
    list.push({ file_name: a.file_name, file_path: a.file_path })
    attsByMsg.set(a.message_id, list)
  }

  let password: string
  try {
    password = await decrypt(accRow.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
  } catch (e) {
    console.error('[backfill-empty-bodies] decrypt failed', e)
    return jsonRes({ error: 'Failed to decrypt credentials', filled: 0 }, 500)
  }

  const acc = accRow as { org_id: string; host: string; port: number; imap_encryption: string; imap_username: string }
  const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
  const isGmail = acc.host.toLowerCase().includes('gmail.com')
  const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'

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

  try {
    await client.connect()
    const lock = await client.getMailboxLock(mailboxPath)
    try {
      for (const msg of msgs) {
        try {
          const fetched = await client.fetchAll(String(msg.external_uid), { source: true, uid: true }, { uid: true })
          const source = fetched[0]?.source as Uint8Array | undefined
          if (!source) {
            console.log('[backfill-empty-bodies] no source', { id: msg.id, uid: msg.external_uid })
            continue
          }

          const parsed = await PostalMime.parse(source)
          let bodyText = parsed.text ?? ''
          let htmlBody = parsed.html ?? null

          const inlineAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => a.contentId)
          const newAtts: { file_name: string; file_path: string }[] = []
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
                newAtts.push({ file_name: fname, file_path: path })
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
              newAtts.push({ file_name: fname, file_path: path })
            }
          }

          if (bodyText.length > MAX_BODY) bodyText = bodyText.slice(0, MAX_BODY)
          if (htmlBody && htmlBody.length > MAX_BODY) htmlBody = htmlBody.slice(0, MAX_BODY)

          const { error: upDb } = await service
            .from('inbox_messages')
            .update({ body: bodyText || null, html_body: htmlBody })
            .eq('id', msg.id)
          if (!upDb) filled++
        } catch (oneErr) {
          console.error('[backfill-empty-bodies] message failed', msg.id, (oneErr as Error).message)
        }
      }
    } finally {
      try { await lock.release() } catch { /* dead connection */ }
    }
    await client.logout().catch(() => { try { client.close() } catch { /* ignore */ } })
  } catch (err) {
    console.error('[backfill-empty-bodies] IMAP error', (err as Error).message)
    try { await client.logout() } catch { try { client.close() } catch { /* ignore */ } }
    return jsonRes({ error: (err as Error).message, filled }, 500)
  }

  return jsonRes({
    filled,
    requested: msgs.length,
    message: filled > 0 ? `Fetched bodies for ${filled} message(s). Run sync again if more remain.` : 'No bodies could be loaded (check IMAP logs).',
  }, 200)
})
