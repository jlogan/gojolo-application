// Sync IMAP accounts: fetch new messages and write to inbox_threads + inbox_messages.
// Cron: call with no body to sync all orgs' active accounts. Manual: pass orgId and optional accountId.
// Requires: ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY. Cron: verify via CRON_SECRET header.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'

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
}

function getMailboxPath(host: string): string {
  return host && host.toLowerCase().includes('gmail.com') ? '[Gmail]/All Mail' : 'INBOX'
}

function getTrashMailboxPath(host: string): string {
  return host && host.toLowerCase().includes('gmail.com') ? '[Gmail]/Trash' : 'Trash'
}

function parseBodyFromSource(source: Uint8Array | Buffer): string {
  const raw = typeof source === 'string' ? source : new TextDecoder().decode(source)
  const idx = raw.indexOf('\r\n\r\n')
  const bodyStart = idx >= 0 ? idx + 4 : raw.indexOf('\n\n') >= 0 ? raw.indexOf('\n\n') + 2 : 0
  let body = raw.slice(bodyStart).replace(/\r\n/g, '\n').trim()
  if (body.length > 50000) body = body.slice(0, 50000) + '…'
  return body
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors() })
  }

  if (req.method !== 'POST') {
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

  const service = createClient(supabaseUrl, serviceKey)

  if (!isCron) {
    const auth = req.headers.get('Authorization')
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 200,
        headers: { ...cors(), 'Content-Type': 'application/json' },
      })
    }
    if (body.orgId) {
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: auth } },
      })
      const { data: isAdmin } = await userClient.rpc('is_org_admin', { p_org_id: body.orgId })
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: 'Forbidden: not an org admin' }), {
          status: 200,
          headers: { ...cors(), 'Content-Type': 'application/json' },
        })
      }
    }
  }

  let accountsQuery = service
    .from('imap_accounts')
    .select('id, org_id, host, port, imap_encryption, imap_username, credentials_encrypted, last_fetched_uid, last_fetched_uid_trash')
    .eq('is_active', true)

  if (body.orgId) {
    accountsQuery = accountsQuery.eq('org_id', body.orgId)
    if (body.accountId) accountsQuery = accountsQuery.eq('id', body.accountId)
  }

  const { data: accounts, error: accountsError } = await accountsQuery

  if (accountsError || !accounts?.length) {
    return new Response(
      JSON.stringify({
        synced: 0,
        threadsCreated: 0,
        messagesInserted: 0,
        errors: accountsError ? [accountsError.message] : ['No active accounts to sync'],
      }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return new Response(
      JSON.stringify({ error: 'ENCRYPTION_KEY not configured', synced: 0, threadsCreated: 0, messagesInserted: 0 }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  let totalThreads = 0
  let totalMessages = 0
  const errors: string[] = []

  for (const acc of accounts as ImapAccountRow[]) {
    let password: string
    try {
      password = await decrypt(acc.credentials_encrypted, encryptionKeyHex.slice(0, 64))
    } catch {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${acc.imap_username}: ${msg}`)
      await service.from('imap_accounts').update({ last_error: msg }).eq('id', acc.id)
      continue
    }

    const mailboxPath = getMailboxPath(acc.host)
    let lock: { release: () => Promise<void> } | null = null

    try {
      lock = await client.getMailboxLock(mailboxPath)
      const lastUid = acc.last_fetched_uid ?? 0
      let range: string
      if (lastUid > 0) {
        range = `${lastUid + 1}:*`
      } else {
        const status = await client.status(mailboxPath, { uidNext: true })
        const uidNext = (status?.uidNext as number) ?? 1
        const start = Math.max(1, uidNext - 99)
        range = `${start}:*`
      }
      const messages = await client.fetchAll(
        range,
        { envelope: true, source: true, uid: true },
        { uid: true }
      )

      let highestUid = lastUid
      let threadsCreated = 0
      let messagesInserted = 0

      for (const msg of messages) {
        const uid = msg.uid as number
        if (uid > highestUid) highestUid = uid

        const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
        const fromAddr = envelope?.from?.[0]?.address ?? ''
        const toAddr = (envelope?.to?.[0]?.address as string) ?? ''
        const subject = (envelope?.subject as string) ?? ''
        const date = envelope?.date ? new Date(envelope.date) : new Date()
        const source = msg.source as Uint8Array | Buffer | undefined
        const rawMessageId = source ? getHeader(source, 'Message-ID') : null
        const messageId = normalizeMessageId(rawMessageId)
        const inReplyToRaw = source ? getHeader(source, 'In-Reply-To') : null
        const referencesRaw = source ? getHeader(source, 'References') : null
        const inReplyTo = normalizeMessageId(inReplyToRaw)
        const refsList = referencesRaw ? referencesRaw.split(/\s+/).map((r) => normalizeMessageId(r)).filter(Boolean) as string[]
        const body = source ? parseBodyFromSource(source) : ''

        const externalId = messageId ?? `uid-${acc.id}-${uid}`

        const { data: existing } = await service
          .from('inbox_messages')
          .select('id')
          .eq('imap_account_id', acc.id)
          .eq('external_uid', uid)
          .limit(1)
        if (existing?.length) continue

        let threadId: string

        const refIds = [inReplyTo, ...refsList].filter(Boolean)
        let found = false
        for (const refId of refIds) {
          if (!refId) continue
          const { data: refMsg } = await service
            .from('inbox_messages')
            .select('thread_id')
            .eq('imap_account_id', acc.id)
            .eq('external_id', refId)
            .limit(1)
          if (refMsg?.[0]?.thread_id) {
            threadId = refMsg[0].thread_id
            found = true
            break
          }
        }

        if (!found && subject) {
          const normSubject = subject.replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase()
          if (normSubject) {
            const { data: recentThreads } = await service
              .from('inbox_threads')
              .select('id, subject, last_message_at')
              .eq('org_id', acc.org_id)
              .eq('channel', 'email')
              .gte('last_message_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
              .order('last_message_at', { ascending: false })
              .limit(50)
            for (const t of recentThreads ?? []) {
              const existingNorm = ((t as { subject?: string }).subject ?? '')
                .replace(/^\s*(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '')
                .trim()
                .toLowerCase()
              if (existingNorm === normSubject) {
                threadId = (t as { id: string }).id
                found = true
                break
              }
            }
          }
        }
        if (!found) {
          const { data: newThread, error: threadErr } = await service
            .from('inbox_threads')
            .insert({
              org_id: acc.org_id,
              channel: 'email',
              status: 'open',
              subject: subject || '(No subject)',
              last_message_at: date.toISOString(),
            })
            .select('id')
            .single()
          if (threadErr || !newThread) {
            errors.push(`${acc.imap_username}: failed to create thread: ${(threadErr as Error)?.message}`)
            continue
          }
          threadId = newThread.id
          threadsCreated++
        } else {
          await service
            .from('inbox_threads')
            .update({ last_message_at: date.toISOString(), updated_at: date.toISOString() })
            .eq('id', threadId!)
        }

        const { error: msgErr } = await service.from('inbox_messages').insert({
          thread_id: threadId!,
          channel: 'email',
          direction: 'inbound',
          from_identifier: fromAddr,
          to_identifier: toAddr,
          body,
          external_id: messageId ?? externalId,
          external_uid: uid,
          imap_account_id: acc.id,
          received_at: date.toISOString(),
        })
        if (msgErr) {
          errors.push(`${acc.imap_username}: insert message: ${msgErr.message}`)
          continue
        }
        messagesInserted++
      }

      await service
        .from('imap_accounts')
        .update({
          last_fetch_at: new Date().toISOString(),
          last_fetched_uid: highestUid,
          last_error: null,
        })
        .eq('id', acc.id)

      totalThreads += threadsCreated
      totalMessages += messagesInserted

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
          const trashRange = lastUidTrash > 0 ? `${lastUidTrash + 1}:*` : '1:*'
          const trashMessages = await client.fetchAll(
            trashRange,
            { envelope: true, source: true, uid: true },
            { uid: true }
          )
          let highestTrashUid = lastUidTrash
          for (const msg of trashMessages) {
            const uid = msg.uid as number
            if (uid > highestTrashUid) highestTrashUid = uid
            const envelope = msg.envelope as { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; date?: Date }
            const fromAddr = envelope?.from?.[0]?.address ?? ''
            const toAddr = (envelope?.to?.[0]?.address as string) ?? ''
            const subject = (envelope?.subject as string) ?? ''
            const date = envelope?.date ? new Date(envelope.date) : new Date()
            const source = msg.source as Uint8Array | Buffer | undefined
            const rawMessageId = source ? getHeader(source, 'Message-ID') : null
            const messageId = normalizeMessageId(rawMessageId)
            const body = source ? parseBodyFromSource(source) : ''
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
            const { error: msgErr } = await service.from('inbox_messages').insert({
              thread_id: newThread.id,
              channel: 'email',
              direction: 'inbound',
              from_identifier: fromAddr,
              to_identifier: toAddr,
              body,
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

  return new Response(
    JSON.stringify({
      synced: (accounts as ImapAccountRow[]).length,
      threadsCreated: totalThreads,
      messagesInserted: totalMessages,
      errors: errors.length ? errors : undefined,
    }),
    { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
})
