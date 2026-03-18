/**
 * Fetches email bodies (and attachments) for all messages in a thread.
 * - If body already exists in DB: returns from database
 * - If body is null: fetches from IMAP, parses, stores body + attachments, returns
 *
 * POST { threadId } — returns { messages: [{ id, body, htmlBody, attachments }] }
 * Requires: ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY. Auth: user must have access to thread's org.
 *
 * Limits: processes at most MAX_FETCH_PER_REQUEST messages per call to avoid 546 WORKER_LIMIT.
 * Client can call again; already-fetched messages will be returned from DB.
 */
const MAX_FETCH_PER_REQUEST = 5

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import PostalMime from 'npm:postal-mime'
import { corsHeaders } from '../_shared/cors.ts'

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const auth = req.headers.get('Authorization')
  if (!auth) return jsonRes({ error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const { threadId } = body as { threadId?: string }
  console.log('[fetch-thread-bodies] request', { threadId })
  if (!threadId) return jsonRes({ error: 'threadId required' }, 400)

  const service = createClient(supabaseUrl, serviceKey)

  // Get thread and verify user has access
  const { data: thread, error: threadErr } = await service
    .from('inbox_threads')
    .select('id, org_id')
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
  console.log('[fetch-thread-bodies] auth ok', { userId: user.id, threadId, orgId: thread.org_id })

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
  const { data: messages, error: msgErr } = await service
    .from('inbox_messages')
    .select('id, external_uid, imap_account_id, thread_id, body, html_body, direction')
    .eq('thread_id', threadId)
    .order('received_at', { ascending: true })

  if (msgErr || !messages?.length) {
    console.log('[fetch-thread-bodies] no messages', { threadId, error: msgErr?.message })
    return jsonRes({ messages: [] }, 200)
  }
  console.log('[fetch-thread-bodies] messages loaded', { threadId, count: messages.length })

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

  const result: { id: string; body: string | null; htmlBody: string | null; attachments: { file_name: string; file_path: string }[] }[] = []

  // Messages that need IMAP fetch (limit per request to avoid 546 WORKER_LIMIT)
  const needFetchRaw = messages.filter(
    (m) =>
      (m.body === null && m.html_body === null && m.direction === 'inbound') &&
      m.imap_account_id &&
      m.external_uid
  ) as { id: string; external_uid: number; imap_account_id: string; thread_id: string }[]
  const needFetch = needFetchRaw.slice(0, MAX_FETCH_PER_REQUEST)

  console.log('[fetch-thread-bodies] split', { fromDb: result.length, needImapFetch: needFetch.length, totalNeed: needFetchRaw.length, needFetchIds: needFetch.map((m) => m.id) })

  // Add messages that already have body
  for (const m of messages) {
    if (needFetch.some((n) => n.id === m.id)) continue
    result.push({
      id: m.id,
      body: m.body as string | null,
      htmlBody: m.html_body as string | null,
      attachments: attsByMsg.get(m.id) ?? [],
    })
  }

  if (needFetch.length === 0) {
    console.log('[fetch-thread-bodies] all from DB, returning', { threadId, messageCount: result.length })
    return jsonRes({ messages: result }, 200)
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    console.log('[fetch-thread-bodies] ENCRYPTION_KEY not configured, cannot fetch from IMAP', { threadId })
    return jsonRes({ error: 'ENCRYPTION_KEY not configured', messages: result }, 500)
  }

  // Group by imap_account_id to reuse connection
  const byAccount = new Map<string, typeof needFetch>()
  for (const m of needFetch) {
    const list = byAccount.get(m.imap_account_id) ?? []
    list.push(m)
    byAccount.set(m.imap_account_id, list)
  }

  for (const [accId, msgs] of byAccount) {
    console.log('[fetch-thread-bodies] IMAP account', { accId, messageCount: msgs.length, uids: msgs.map((m) => m.external_uid) })
    const { data: acc } = await service
      .from('imap_accounts')
      .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
      .eq('id', accId)
      .single()
    if (!acc) {
      console.log('[fetch-thread-bodies] IMAP account not found', { accId })
      continue
    }

    let password: string
    try {
      password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
    } catch (decErr) {
      console.log('[fetch-thread-bodies] decrypt credentials failed', { accId, error: (decErr as Error).message })
      continue
    }

    const secure = (acc.imap_encryption as string) === 'ssl' || (acc.imap_encryption as string) === 'tls'
    const isGmail = (acc.host as string).toLowerCase().includes('gmail.com')
    const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'
    const client = new ImapFlow({
      host: acc.host as string,
      port: Number(acc.port) || 993,
      secure,
      auth: { user: acc.imap_username as string, pass: password },
      logger: false,
    })

    try {
      await client.connect()
      console.log('[fetch-thread-bodies] IMAP connected', { accId, host: acc.host, mailbox: mailboxPath })
      const lock = await client.getMailboxLock(mailboxPath)
      try {
        for (const msg of msgs) {
          const fetched = await client.fetchAll(String(msg.external_uid), { source: true, uid: true }, { uid: true })
          const source = fetched[0]?.source as Uint8Array | undefined
          if (!source) {
            console.log('[fetch-thread-bodies] no source for message', { msgId: msg.id, uid: msg.external_uid })
            result.push({ id: msg.id, body: null, htmlBody: null, attachments: [] })
            continue
          }

          const parsed = await PostalMime.parse(source)
          let bodyText = parsed.text ?? ''
          let htmlBody = parsed.html ?? null

          const rawToBytes = (raw: unknown) =>
            raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBuffer) ?? [])

          // Inline images (CID) — upload, rewrite HTML, and add to inbox_attachments so they show in attachment list
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
                  new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'),
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

          // File attachments (no contentId)
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

          if (bodyText.length > 50000) bodyText = bodyText.slice(0, 50000)
          if (htmlBody && htmlBody.length > 50000) htmlBody = htmlBody.slice(0, 50000)

          await service
            .from('inbox_messages')
            .update({ body: bodyText || null, html_body: htmlBody })
            .eq('id', msg.id)

          const attCount = (attsByMsg.get(msg.id) ?? []).length + newAtts.length
          console.log('[fetch-thread-bodies] fetched and stored', { msgId: msg.id, bodyLen: bodyText?.length ?? 0, htmlLen: htmlBody?.length ?? 0, attachments: attCount })

          result.push({
            id: msg.id,
            body: bodyText || null,
            htmlBody,
            attachments: [...(attsByMsg.get(msg.id) ?? []), ...newAtts],
          })
        }
      } finally {
        await lock.release()
      }
      await client.logout().catch(() => client.close())
    } catch (err) {
      console.error('[fetch-thread-bodies] IMAP error', { accId, error: (err as Error).message })
      try {
        await client.logout()
      } catch {
        client.close()
      }
      for (const msg of msgs) {
        result.push({ id: msg.id, body: null, htmlBody: null, attachments: [] })
      }
    }
  }

  // Sort by original message order (received_at)
  const ordered = messages.map((m) => result.find((r) => r.id === m.id) ?? { id: m.id, body: null, htmlBody: null, attachments: [] })
  const hasMore = needFetchRaw.length > MAX_FETCH_PER_REQUEST
  console.log('[fetch-thread-bodies] done', { threadId, messageCount: ordered.length, hasMore })
  return jsonRes({ messages: ordered, hasMore }, 200)
})
