/**
 * IMAP IDLE — near-real-time email fetch.
 *
 * Connects to each active IMAP account, enters IDLE mode, and waits up to
 * IDLE_TIMEOUT_MS for the server to push a notification of new mail.
 * When notified (or on timeout), it fetches any new messages since the
 * last UID and inserts them into inbox_threads / inbox_messages.
 *
 * Designed to be called by pg_cron every 1 minute. Each invocation holds
 * the IDLE connection for up to ~50 seconds, giving near-instant delivery
 * when mail arrives during that window.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import PostalMime from 'npm:postal-mime'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')
const cronSecret = Deno.env.get('CRON_SECRET')

const IDLE_TIMEOUT_MS = 50_000

async function decrypt(ct: string, keyHex: string): Promise<string> {
  const kb = new Uint8Array(32)
  for (let i = 0; i < 32; i++) kb[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', kb, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ct), c => c.charCodeAt(0))
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 }, key, combined.slice(12)))
}

function normalizeMessageId(id: string | null): string | null {
  if (!id?.trim()) return null
  return id.trim().replace(/^</, '').replace(/>$/, '').trim() || null
}

function getHeader(source: Uint8Array | Buffer, name: string): string | null {
  const raw = typeof source === 'string' ? source : new TextDecoder().decode(source)
  const lower = name.toLowerCase()
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') break
    if (line.toLowerCase().startsWith(lower + ':')) return line.slice(name.length + 1).trim().replace(/\s+/g, ' ')
  }
  return null
}

interface ImapAccountRow {
  id: string; org_id: string; host: string; port: number
  imap_encryption: string; imap_username: string
  credentials_encrypted: string; last_fetched_uid: number | null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const isCron = req.headers.get('x-cron-secret') === cronSecret && cronSecret
  if (!isCron) {
    const auth = req.headers.get('Authorization')
    if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  let body: { orgId?: string; accountId?: string } = {}
  try { const t = await req.text(); if (t.trim()) body = JSON.parse(t) } catch {}

  const service = createClient(supabaseUrl, serviceKey)

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return new Response(JSON.stringify({ error: 'ENCRYPTION_KEY not configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  let q = service.from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted, last_fetched_uid')
    .eq('is_active', true)
  if (body.orgId) q = q.eq('org_id', body.orgId)
  if (body.accountId) q = q.eq('id', body.accountId)

  const { data: accounts } = await q
  if (!accounts?.length) {
    return new Response(JSON.stringify({ synced: 0, idled: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  let totalNew = 0
  const errors: string[] = []

  for (const acc of accounts as ImapAccountRow[]) {
    let password: string
    try { password = await decrypt(acc.credentials_encrypted, encryptionKeyHex.slice(0, 64)) }
    catch { errors.push(`${acc.imap_username}: decrypt failed`); continue }

    const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
    const client = new ImapFlow({
      host: acc.host, port: Number(acc.port) || 993, secure,
      auth: { user: acc.imap_username, pass: password },
      logger: false,
    })

    try {
      await client.connect()
      const isGmail = acc.host.toLowerCase().includes('gmail.com')
      const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'
      const lock = await client.getMailboxLock(mailboxPath)

      try {
        // Enter IDLE and wait for new mail notification
        let gotNew = false

        const idlePromise = new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), IDLE_TIMEOUT_MS)

          client.on('exists', () => {
            clearTimeout(timeout)
            resolve(true)
          })

          // Start IDLE
          client.idle().catch(() => {
            clearTimeout(timeout)
            resolve(false)
          })
        })

        gotNew = await idlePromise

        const MAX_BATCH = 25
        const lastUid = acc.last_fetched_uid ?? 0
        const range = lastUid > 0 ? `${lastUid + 1}:*` : (() => {
          const start = Math.max(1, (client.mailbox?.uidNext ?? 1) - MAX_BATCH)
          return `${start}:*`
        })()

        // Fetch envelopes first (lightweight), then full source one at a time
        const envelopes = await client.fetchAll(range, { envelope: true, uid: true }, { uid: true })
        const batch = envelopes.filter(m => (m.uid as number) > lastUid).sort((a, b) => (a.uid as number) - (b.uid as number)).slice(0, MAX_BATCH)
        let highestUid = lastUid
        let inserted = 0

        for (const envMsg of batch) {
          const fullMsgs = await client.fetchAll(String(envMsg.uid), { envelope: true, source: true, uid: true }, { uid: true })
          const msg = fullMsgs[0]
          if (!msg) continue
          const uid = msg.uid as number
          if (uid > highestUid) highestUid = uid

          const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
          const fromHeader = source ? getHeader(source, 'From')?.trim() : null
          const fromAddr = fromHeader || (envelope?.from?.[0]?.address ?? '')
          const toAddr = envelope?.to?.[0]?.address ?? ''
          const subject = envelope?.subject ?? ''
          const date = envelope?.date ? new Date(envelope.date) : new Date()
          const source = msg.source as Uint8Array | Buffer | undefined

          const rawMsgId = source ? getHeader(source, 'Message-ID') : null
          const messageId = normalizeMessageId(rawMsgId)
          const inReplyTo = normalizeMessageId(source ? getHeader(source, 'In-Reply-To') : null)
          const refsRaw = source ? getHeader(source, 'References') : null
          const refsList: string[] = refsRaw ? (refsRaw.split(/\s+/).map(r => normalizeMessageId(r)).filter(Boolean) as string[]) : []
          const ccStr = source ? getHeader(source, 'Cc') : null
          const bccStr = source ? getHeader(source, 'Bcc') : null

          // Parse body
          let bodyText = '', htmlBody: string | null = null
          const inlineAtts: { cid: string; filename: string; contentType: string; content: Uint8Array }[] = []
          const fileAtts: { filename: string; contentType: string; content: Uint8Array }[] = []

          if (source) {
            try {
              const parsed = await PostalMime.parse(source as Uint8Array)
              bodyText = parsed.text ?? ''
              htmlBody = parsed.html ?? null
              for (const att of parsed.attachments ?? []) {
                const entry = { filename: att.filename ?? `file-${Date.now()}`, contentType: att.mimeType ?? 'application/octet-stream', content: new Uint8Array(att.content) }
                const cid = att.contentId?.replace(/^<|>$/g, '')
                if (cid) inlineAtts.push({ ...entry, cid })
                else fileAtts.push(entry)
              }
            } catch { bodyText = '' }
          }

          // Dedup
          const { data: existing } = await service.from('inbox_messages').select('id').eq('imap_account_id', acc.id).eq('external_uid', uid).limit(1)
          if (existing?.length) continue

          // Thread matching
          let threadId: string | undefined
          const refIds = [inReplyTo, ...refsList].filter(Boolean)
          for (const refId of refIds) {
            const { data: refMsg } = await service.from('inbox_messages').select('thread_id').eq('imap_account_id', acc.id).eq('external_id', refId!).limit(1)
            if (refMsg?.[0]?.thread_id) { threadId = refMsg[0].thread_id; break }
          }

          if (!threadId && subject) {
            const normSubject = subject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
            if (normSubject) {
              const { data: recentThreads } = await service.from('inbox_threads').select('id, subject')
                .eq('org_id', acc.org_id).eq('channel', 'email')
                .gte('last_message_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
                .order('last_message_at', { ascending: false }).limit(50)
              for (const t of recentThreads ?? []) {
                const existing = ((t as { subject?: string }).subject ?? '').replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
                if (existing === normSubject) { threadId = (t as { id: string }).id; break }
              }
            }
          }

          if (!threadId) {
            const { data: newThread } = await service.from('inbox_threads').insert({
              org_id: acc.org_id, channel: 'email', status: 'open',
              subject: subject || '(No subject)', last_message_at: date.toISOString(),
              imap_account_id: acc.id, from_address: fromAddr,
            }).select('id').single()
            if (!newThread) continue
            threadId = newThread.id
          } else {
            await service.from('inbox_threads').update({ last_message_at: date.toISOString(), updated_at: date.toISOString(), status: 'open' }).eq('id', threadId)
          }

          // Upload inline images
          if (htmlBody && inlineAtts.length > 0) {
            for (const att of inlineAtts) {
              const path = `${acc.org_id}/${threadId}/${Date.now()}-${att.filename}`
              const { error } = await service.storage.from('inbox-attachments').upload(path, att.content, { contentType: att.contentType })
              if (!error) {
                const { data: urlData } = service.storage.from('inbox-attachments').getPublicUrl(path)
                htmlBody = htmlBody!.replace(new RegExp(`cid:${att.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), urlData.publicUrl)
              }
            }
          }

          const externalId = messageId ?? `uid-${acc.id}-${uid}`
          const { data: insertedMsg } = await service.from('inbox_messages').insert({
            thread_id: threadId, channel: 'email', direction: 'inbound',
            from_identifier: fromAddr, to_identifier: toAddr,
            cc: ccStr?.trim() || null, bcc: bccStr?.trim() || null,
            body: bodyText, html_body: htmlBody,
            external_id: externalId, external_uid: uid,
            imap_account_id: acc.id, received_at: date.toISOString(),
          }).select('id').single()

          // File attachments
          for (const att of fileAtts) {
            const path = `${acc.org_id}/${threadId}/${Date.now()}-${att.filename}`
            const { error } = await service.storage.from('inbox-attachments').upload(path, att.content, { contentType: att.contentType })
            if (!error && insertedMsg) {
              await service.from('inbox_attachments').insert({
                message_id: insertedMsg.id, thread_id: threadId, file_name: att.filename,
                file_path: path, file_size: att.content.length, content_type: att.contentType,
              })
            }
          }

          inserted++
        }

        if (highestUid > lastUid) {
          await service.from('imap_accounts').update({ last_fetch_at: new Date().toISOString(), last_fetched_uid: highestUid, last_error: null }).eq('id', acc.id)
        }

        totalNew += inserted
      } finally {
        await lock.release()
      }

      await client.logout().catch(() => client.close())
    } catch (err) {
      const msg = (err as Error).message
      errors.push(`${acc.imap_username}: ${msg}`)
      await service.from('imap_accounts').update({ last_error: msg }).eq('id', acc.id)
      try { await client.logout() } catch { client.close() }
    }
  }

  return new Response(JSON.stringify({
    synced: (accounts as ImapAccountRow[]).length,
    messagesInserted: totalNew,
    idle: true,
    errors: errors.length ? errors : undefined,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
