// Send an email reply for an inbox thread and optionally auto-close the thread.
// POST body: { threadId, body, subject?, to? }. Uses the thread's IMAP account SMTP.
// Requires: ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY. verify_jwt = false; check org membership inside.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

interface Body {
  threadId: string
  body: string
  subject?: string
  to?: string
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

  const auth = req.headers.get('Authorization')
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  const { threadId, body: bodyText, subject: replySubject, to: replyTo } = body
  if (!threadId?.trim() || !bodyText?.trim()) {
    return new Response(
      JSON.stringify({ error: 'threadId and body are required' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  })
  const service = createClient(supabaseUrl, serviceKey)

  const { data: thread, error: threadError } = await userClient
    .from('inbox_threads')
    .select('id, org_id, channel, subject')
    .eq('id', threadId)
    .single()

  if (threadError || !thread) {
    return new Response(
      JSON.stringify({ error: 'Thread not found or access denied' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  if (thread.channel !== 'email') {
    return new Response(
      JSON.stringify({ error: 'Reply is only supported for email threads' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const { data: messages } = await userClient
    .from('inbox_messages')
    .select('id, imap_account_id, from_identifier, to_identifier, external_id, received_at')
    .eq('thread_id', threadId)
    .order('received_at', { ascending: false })

  const lastMessage = messages?.[0]
  const imapAccountId = lastMessage?.imap_account_id
  if (!imapAccountId) {
    return new Response(
      JSON.stringify({ error: 'No email account associated with this thread' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const toAddress = replyTo?.trim() || (lastMessage?.from_identifier as string) || ''
  if (!toAddress || !toAddress.includes('@')) {
    return new Response(
      JSON.stringify({ error: 'Recipient (to) is required' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const { data: account, error: accError } = await service
    .from('imap_accounts')
    .select('id, org_id, email, smtp_host, smtp_port, smtp_use_tls, smtp_username, smtp_credentials_encrypted, credentials_encrypted')
    .eq('id', imapAccountId)
    .single()

  if (accError || !account) {
    return new Response(
      JSON.stringify({ error: 'IMAP account not found' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  if (account.org_id !== thread.org_id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    return new Response(
      JSON.stringify({ error: 'Server not configured for sending (ENCRYPTION_KEY missing)' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  let smtpPassword: string
  if (account.smtp_credentials_encrypted) {
    try {
      smtpPassword = await decrypt(account.smtp_credentials_encrypted, encryptionKeyHex.slice(0, 64))
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to decrypt SMTP credentials' }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
  } else if (account.credentials_encrypted) {
    try {
      smtpPassword = await decrypt(account.credentials_encrypted, encryptionKeyHex.slice(0, 64))
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to decrypt credentials' }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
  } else {
    return new Response(
      JSON.stringify({ error: 'No SMTP credentials for this account' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const subject = replySubject?.trim() || (thread.subject as string) || 'Re: (No subject)'
  const inReplyTo = (lastMessage?.external_id as string) ?? undefined
  const references = messages
    ?.slice(0, 10)
    .map((m) => m.external_id)
    .filter(Boolean)
    .reverse()
    .join(' ')

  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: Number(account.smtp_port) || 587,
    secure: account.smtp_use_tls === true && Number(account.smtp_port) === 465,
    auth: {
      user: account.smtp_username || account.email,
      pass: smtpPassword,
    },
  })

  try {
    await transporter.sendMail({
      from: account.email,
      to: toAddress,
      subject,
      text: bodyText,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(
      JSON.stringify({ error: 'Send failed: ' + message }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const now = new Date().toISOString()
  const { data: insertedMessage, error: insertErr } = await service.from('inbox_messages').insert({
    thread_id: threadId,
    channel: 'email',
    direction: 'outbound',
    from_identifier: account.email,
    to_identifier: toAddress,
    body: bodyText,
    imap_account_id: account.id,
    received_at: now,
  }).select('id').single()

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: 'Message sent but failed to save: ' + insertErr.message }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  await service
    .from('inbox_threads')
    .update({ last_message_at: now, updated_at: now })
    .eq('id', threadId)

  const { data: afterMessages } = await service
    .from('inbox_messages')
    .select('id, received_at')
    .eq('thread_id', threadId)
    .order('received_at', { ascending: false })
    .limit(1)

  const latestId = afterMessages?.[0]?.id
  if (latestId === insertedMessage?.id) {
    await service
      .from('inbox_threads')
      .update({ status: 'closed', updated_at: now })
      .eq('id', threadId)
  }

  return new Response(
    JSON.stringify({ ok: true, messageId: insertedMessage?.id, closed: latestId === insertedMessage?.id }),
    { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
})
