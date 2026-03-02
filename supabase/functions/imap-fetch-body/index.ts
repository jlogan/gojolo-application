/**
 * Lazy-load email body: fetches the full MIME source for a single message
 * from IMAP, parses it, stores body + attachments, and returns the content.
 *
 * Called when user opens a thread and a message has body = null.
 * POST { messageId } — fetches and stores the body, returns { body, htmlBody }.
 */

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
  const combined = Uint8Array.from(atob(ct), c => c.charCodeAt(0))
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 }, key, combined.slice(12)))
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const auth = req.headers.get('Authorization')
  if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const { messageId } = await req.json().catch(() => ({})) as { messageId?: string }
  if (!messageId) return new Response(JSON.stringify({ error: 'messageId required' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const service = createClient(supabaseUrl, serviceKey)

  // Get the message record
  const { data: msg, error: msgErr } = await service.from('inbox_messages')
    .select('id, external_uid, imap_account_id, thread_id, body, html_body')
    .eq('id', messageId).single()

  if (msgErr || !msg) return new Response(JSON.stringify({ error: 'Message not found' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  // Already fetched? Return it.
  if (msg.body !== null || msg.html_body !== null) {
    return new Response(JSON.stringify({ body: msg.body, htmlBody: msg.html_body }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  if (!msg.imap_account_id || !msg.external_uid) {
    return new Response(JSON.stringify({ error: 'No IMAP reference for this message' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return new Response(JSON.stringify({ error: 'ENCRYPTION_KEY not configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  // Get the IMAP account
  const { data: acc } = await service.from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted')
    .eq('id', msg.imap_account_id).single()

  if (!acc) return new Response(JSON.stringify({ error: 'IMAP account not found' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  let password: string
  try { password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64)) }
  catch { return new Response(JSON.stringify({ error: 'Decrypt failed' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

  const secure = (acc.imap_encryption as string) === 'ssl' || (acc.imap_encryption as string) === 'tls'
  const isGmail = (acc.host as string).toLowerCase().includes('gmail.com')
  const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'
  const client = new ImapFlow({
    host: acc.host as string, port: Number(acc.port) || 993, secure,
    auth: { user: acc.imap_username as string, pass: password }, logger: false,
  })

  try {
    await client.connect()
    const lock = await client.getMailboxLock(mailboxPath)
    try {
      const fetched = await client.fetchAll(String(msg.external_uid), { source: true, uid: true }, { uid: true })
      const source = fetched[0]?.source as Uint8Array | undefined

      if (!source) {
        await lock.release()
        await client.logout().catch(() => client.close())
        return new Response(JSON.stringify({ error: 'Message source not found on server' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      // Parse MIME
      const parsed = await PostalMime.parse(source)
      let bodyText = parsed.text ?? ''
      let htmlBody = parsed.html ?? null

      // Process inline images (CID)
      const inlineAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => a.contentId)
      if (htmlBody && inlineAtts.length > 0) {
        for (const att of inlineAtts) {
          const cid = att.contentId!.replace(/^<|>$/g, '')
          const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${att.filename ?? 'inline'}`
          const { error: upErr } = await service.storage.from('inbox-attachments').upload(path, new Uint8Array(att.content), { contentType: att.mimeType ?? 'application/octet-stream' })
          if (!upErr) {
            const { data: urlData } = service.storage.from('inbox-attachments').getPublicUrl(path)
            htmlBody = htmlBody!.replace(new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), urlData.publicUrl)
          }
        }
      }

      // Store file attachments
      const fileAtts = (parsed.attachments ?? []).filter((a: { contentId?: string }) => !a.contentId)
      for (const att of fileAtts) {
        const fname = att.filename ?? `attachment-${Date.now()}`
        const path = `${acc.org_id}/${msg.thread_id}/${Date.now()}-${fname}`
        const { error: upErr } = await service.storage.from('inbox-attachments').upload(path, new Uint8Array(att.content), { contentType: att.mimeType ?? 'application/octet-stream' })
        if (!upErr) {
          await service.from('inbox_attachments').insert({
            message_id: msg.id, thread_id: msg.thread_id, file_name: fname,
            file_path: path, file_size: att.content.byteLength, content_type: att.mimeType,
          })
        }
      }

      // Truncate if too long
      if (bodyText.length > 50000) bodyText = bodyText.slice(0, 50000)
      if (htmlBody && htmlBody.length > 50000) htmlBody = htmlBody.slice(0, 50000)

      // Update the message row with the body
      await service.from('inbox_messages').update({ body: bodyText || null, html_body: htmlBody }).eq('id', msg.id)

      await lock.release()
      await client.logout().catch(() => client.close())

      return new Response(JSON.stringify({ body: bodyText, htmlBody }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    } catch (err) {
      await lock.release()
      throw err
    }
  } catch (err) {
    try { await client.logout() } catch { client.close() }
    return new Response(JSON.stringify({ error: (err as Error).message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
