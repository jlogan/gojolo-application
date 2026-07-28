/**
 * Best-effort IMAP Drafts folder persistence for app-saved drafts.
 * POST { messageId: string, action?: 'save' | 'delete', externalUid?: number, imapAccountId?: string }
 * - save (default): APPEND RFC822 MIME to Drafts, update external_uid/is_draft
 * - delete: remove server draft when external_uid exists (or externalUid/imapAccountId if row already deleted)
 * DB draft save/delete in the app proceeds regardless of IMAP outcome.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

async function decrypt(ciphertextB64: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const cipher = combined.slice(12)
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, cipher)
  return new TextDecoder().decode(dec)
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function getDraftsPath(host: string): string {
  return host.toLowerCase().includes('gmail.com') ? '[Gmail]/Drafts' : 'Drafts'
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `=?UTF-8?B?${btoa(binary)}?=`
}

function foldHeaderLine(name: string, value: string): string {
  return `${name}: ${encodeHeaderValue(value)}\r\n`
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

function buildRfc822Mime(opts: {
  from: string
  to?: string | null
  cc?: string | null
  subject: string
  htmlBody: string
  textBody: string
}): string {
  const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, '')}`
  const date = new Date().toUTCString()
  let headers = ''
  headers += foldHeaderLine('From', opts.from)
  if (opts.to?.trim()) headers += foldHeaderLine('To', opts.to.trim())
  if (opts.cc?.trim()) headers += foldHeaderLine('Cc', opts.cc.trim())
  headers += foldHeaderLine('Subject', opts.subject || '(No subject)')
  headers += foldHeaderLine('Date', date)
  headers += 'MIME-Version: 1.0\r\n'
  headers += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`
  headers += '\r\n'
  const textPart = opts.textBody || ''
  const htmlPart = opts.htmlBody || '<p></p>'
  const body =
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: 8bit\r\n\r\n' +
    `${textPart}\r\n\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: 8bit\r\n\r\n' +
    `${htmlPart}\r\n\r\n` +
    `--${boundary}--\r\n`
  return headers + body
}

async function deleteDraftUid(
  client: ImapFlow,
  draftsPath: string,
  uid: number,
): Promise<void> {
  const lock = await client.getMailboxLock(draftsPath)
  try {
    await client.messageDelete({ uid }, { uid: true }).catch(async () => {
      await client.messageFlagsAdd({ uid }, ['\\Deleted'], { uid: true }).catch(() => {})
    })
  } finally {
    await lock.release()
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({})) as {
    messageId?: string
    action?: 'save' | 'delete'
    /** Optional when the DB row was already deleted (best-effort server cleanup). */
    externalUid?: number
    imapAccountId?: string
  }
  const messageId = body.messageId?.trim()
  const action = body.action ?? 'save'
  if (!messageId) return json({ error: 'messageId required' }, 400)

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return json({ ok: false, imapError: 'ENCRYPTION_KEY not configured' })
  }

  const service = createClient(supabaseUrl, serviceKey)
  const token = auth.replace(/^Bearer\s+/i, '')
  const { data: { user }, error: uErr } = await service.auth.getUser(token)
  if (uErr || !user?.id) return json({ error: 'Invalid token' }, 401)

  const { data: msg, error: msgErr } = await service
    .from('inbox_messages')
    .select('id, thread_id, imap_account_id, external_uid, from_identifier, to_identifier, cc, html_body, body, is_draft')
    .eq('id', messageId)
    .maybeSingle()

  let accountId = (msg?.imap_account_id as string | null) ?? body.imapAccountId?.trim() ?? null
  let previousUid = (msg?.external_uid as number | null) ?? (typeof body.externalUid === 'number' ? body.externalUid : null)
  let orgId: string | null = null
  let threadSubject = '(No subject)'

  if (msg?.thread_id) {
    const { data: thread } = await service.from('inbox_threads').select('org_id, subject').eq('id', msg.thread_id).single()
    orgId = thread?.org_id ?? null
    threadSubject = (thread?.subject as string | null) ?? threadSubject
  } else if (action === 'delete' && accountId) {
    const { data: accOrg } = await service.from('imap_accounts').select('org_id').eq('id', accountId).single()
    orgId = (accOrg?.org_id as string | null) ?? null
  }

  if (msgErr && action !== 'delete') return json({ error: 'Message not found' }, 404)
  if (!msg && action === 'delete' && (previousUid == null || !accountId)) {
    return json({ ok: true, skipped: true, reason: 'No external_uid or account for delete' })
  }
  if (!msg && action !== 'delete') return json({ error: 'Message not found' }, 404)

  if (!orgId) return json({ error: 'Thread not found' }, 404)

  const { data: membership } = await service
    .from('organization_users')
    .select('org_id')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return json({ error: 'Access denied' }, 403)

  if (!accountId) return json({ ok: true, skipped: true, reason: 'No IMAP account on message' })

  const { data: acc } = await service
    .from('imap_accounts')
    .select('id, host, port, imap_encryption, imap_username, credentials_encrypted, org_id')
    .eq('id', accountId)
    .single()
  if (!acc || acc.org_id !== orgId) return json({ error: 'Account not found' }, 404)

  let password: string
  try {
    password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64))
  } catch {
    return json({ ok: false, imapError: 'Decrypt failed' })
  }

  const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
  const client = new ImapFlow({
    host: acc.host as string,
    port: Number(acc.port) || 993,
    secure,
    auth: { user: acc.imap_username as string, pass: password },
  })

  const draftsPath = getDraftsPath(acc.host as string)

  try {
    await client.connect()

    if (action === 'delete') {
      if (previousUid == null) {
        await client.logout().catch(() => client.close())
        return json({ ok: true, skipped: true, reason: 'No external_uid' })
      }
      await deleteDraftUid(client, draftsPath, previousUid)
      await client.logout().catch(() => client.close())
      return json({ ok: true, deleted: true })
    }

    if (!msg) return json({ error: 'Message not found' }, 404)

    const htmlBody = (msg.html_body as string | null) ?? ''
    const textBody = (msg.body as string | null) ?? stripHtmlToText(htmlBody)
    const subject = threadSubject
    const mime = buildRfc822Mime({
      from: msg.from_identifier as string,
      to: msg.to_identifier as string | null,
      cc: msg.cc as string | null,
      subject,
      htmlBody,
      textBody,
    })

    if (previousUid != null) {
      await deleteDraftUid(client, draftsPath, previousUid).catch(() => {})
    }

    const lock = await client.getMailboxLock(draftsPath)
    let newUid: number | undefined
    try {
      const appendResult = await client.append(draftsPath, mime, ['\\Draft', '\\Seen'])
      newUid = appendResult?.uid
    } finally {
      await lock.release()
    }

    if (newUid != null) {
      await service
        .from('inbox_messages')
        .update({ external_uid: newUid, is_draft: true })
        .eq('id', messageId)
    }

    await client.logout().catch(() => client.close())
    return json({ ok: true, external_uid: newUid ?? null })
  } catch (err) {
    try { await client.logout() } catch { client.close() }
    console.warn('[imap-save-draft]', messageId, (err as Error).message)
    return json({ ok: false, imapError: (err as Error).message })
  }
})
