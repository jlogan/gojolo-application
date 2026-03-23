/**
 * Lazy-load email body from IMAP: parses MIME, stores body + file attachments.
 * POST { messageId, forceRefresh?: boolean }
 * - Default: if body already in DB, returns cached; else fetches from IMAP.
 * - forceRefresh: re-fetches full MIME from IMAP, replaces body/html, removes prior
 *   file attachment rows + storage objects for this message, then re-imports attachments.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
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
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 }, key, combined.slice(12))
  )
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({})) as { messageId?: string; forceRefresh?: boolean }
  const { messageId, forceRefresh } = body
  console.log('[imap-fetch-body] request', { messageId, forceRefresh })
  if (!messageId) return json({ error: 'messageId required' }, 400)

  const service = createClient(supabaseUrl, serviceKey)

  const token = auth.replace(/^Bearer\s+/i, '')
  const { data: { user }, error: uErr } = await service.auth.getUser(token)
  if (uErr || !user?.id) return json({ error: 'Invalid token' }, 401)

  const { data: msg, error: msgErr } = await service
    .from('inbox_messages')
    .select('id, external_uid, imap_account_id, thread_id, body, html_body, direction')
    .eq('id', messageId)
    .single()

  if (msgErr || !msg) return json({ error: 'Message not found' }, 404)

  const { data: thread } = await service.from('inbox_threads').select('org_id').eq('id', msg.thread_id).single()
  if (!thread?.org_id) return json({ error: 'Thread not found' }, 404)

  const { data: membership } = await service
    .from('organization_users')
    .select('user_id')
    .eq('org_id', thread.org_id)
    .eq('user_id', user.id)
    .limit(1)
  if (!membership?.length) return json({ error: 'Forbidden' }, 403)

  const force = Boolean(forceRefresh)

  const hasStoredContent = (v: unknown) => v != null && String(v).trim() !== ''
  if (!force && (hasStoredContent(msg.body) || hasStoredContent(msg.html_body))) {
    return json({ body: msg.body, htmlBody: msg.html_body, fromCache: true })
  }

  if (!msg.imap_account_id || msg.external_uid == null) {
    return json({ error: 'No IMAP reference for this message (cannot reload from server)' }, 400)
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return json({ error: 'ENCRYPTION_KEY not configured' }, 500)
  }

  if (force) {
    const { data: existing } = await service.from('inbox_attachments').select('file_path').eq('message_id', msg.id)
    const paths = (existing ?? []).map((r: { file_path: string }) => r.file_path).filter(Boolean)
    if (paths.length > 0) {
      await service.storage.from('inbox-attachments').remove(paths).catch(() => {})
    }
    await service.from('inbox_attachments').delete().eq('message_id', msg.id)
  }

  const { data: acc } = await service
    .from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
    .eq('id', msg.imap_account_id)
    .single()

  if (!acc) return json({ error: 'IMAP account not found' }, 404)

  let password: string
  try {
    password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
  } catch {
    return json({ error: 'Decrypt failed' }, 500)
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
    const lock = await client.getMailboxLock(mailboxPath)
    try {
      const fetched = await client.fetchAll(String(msg.external_uid), { source: true, uid: true }, { uid: true })
      const source = fetched[0]?.source as Uint8Array | undefined

      console.log('[imap-fetch-body] IMAP fetch', { messageId, uid: msg.external_uid, sourceBytes: source?.byteLength ?? 0, fetchedCount: fetched.length })

      if (!source) {
        await lock.release()
        await client.logout().catch(() => client.close())
        return json({ error: 'Message source not found on IMAP server' }, 404)
      }

      const parsed = await PostalMime.parse(source)
      const rawAttachments = parsed.attachments ?? []
      console.log('[imap-fetch-body] MIME parsed', {
        messageId,
        textLen: (parsed.text ?? '').length,
        htmlLen: (parsed.html ?? '').length,
        attachmentsTotal: rawAttachments.length,
        attachmentDetails: rawAttachments.map((a: { filename?: string; contentId?: string; content?: unknown }) => ({
          filename: a.filename ?? '(none)',
          contentId: a.contentId ?? null,
          contentLength: Array.isArray(a.content) ? a.content.length : (a.content as ArrayBuffer)?.byteLength ?? 0,
        })),
      })

      let bodyText = parsed.text ?? ''
      let htmlBody = parsed.html ?? null

      const inlineAtts = rawAttachments.filter((a: { contentId?: string }) => a.contentId)
      const fileAtts = rawAttachments.filter((a: { contentId?: string }) => !a.contentId)
      console.log('[imap-fetch-body] attachment split', { messageId, inlineCount: inlineAtts.length, fileCount: fileAtts.length })

      let attachmentCount = 0
      if (htmlBody && inlineAtts.length > 0) {
        for (const att of inlineAtts) {
          const cid = att.contentId!.replace(/^<|>$/g, '')
          const fname = att.filename ?? `inline-${cid}`
          const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${fname}`
          const raw = att.content
          const contentBytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBuffer) ?? [])
          const { error: upErr } = await service.storage
            .from('inbox-attachments')
            .upload(path, contentBytes, { contentType: att.mimeType ?? 'application/octet-stream' })
          if (!upErr) {
            const { data: urlData } = service.storage.from('inbox-attachments').getPublicUrl(path)
            htmlBody = htmlBody!.replace(
              new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'),
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
            if (!insErr) attachmentCount++
          }
        }
      }

      for (let i = 0; i < fileAtts.length; i++) {
        const att = fileAtts[i]
        const raw = att.content
        const contentBytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBuffer) ?? [])
        const fname = att.filename ?? `attachment-${Date.now()}`
        const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${fname}`
        const { error: upErr } = await service.storage
          .from('inbox-attachments')
          .upload(path, contentBytes, { contentType: att.mimeType ?? 'application/octet-stream' })
        console.log('[imap-fetch-body] file attachment', { messageId, index: i, filename: fname, bytes: contentBytes.length, uploadError: upErr?.message ?? null })
        if (!upErr) {
          const { error: insErr } = await service.from('inbox_attachments').insert({
            message_id: msg.id,
            thread_id: msg.thread_id,
            file_name: fname,
            file_path: path,
            file_size: contentBytes.length,
            content_type: att.mimeType,
          })
          if (insErr) console.log('[imap-fetch-body] insert attachment error', { messageId, filename: fname, error: insErr.message })
          else attachmentCount++
        }
      }
      console.log('[imap-fetch-body] done', { messageId, attachmentCount, fileAttsCount: fileAtts.length })

      if (bodyText.length > 50000) bodyText = bodyText.slice(0, 50000)
      if (htmlBody && htmlBody.length > 50000) htmlBody = htmlBody.slice(0, 50000)

      await service.from('inbox_messages').update({ body: bodyText || null, html_body: htmlBody }).eq('id', msg.id)

      await lock.release()
      await client.logout().catch(() => client.close())

      return json({
        body: bodyText,
        htmlBody,
        fromImap: true,
        forceRefresh: force,
        attachmentCount,
      })
    } catch (err) {
      await lock.release().catch(() => {})
      throw err
    }
  } catch (err) {
    try {
      await client.logout()
    } catch {
      client.close()
    }
    return json({ error: (err as Error).message }, 500)
  }
})
