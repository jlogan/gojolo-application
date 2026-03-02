import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'
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

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
}

interface ReqBody {
  threadId?: string
  body: string
  subject?: string
  to?: string
  cc?: string
  bcc?: string
  isHtml?: boolean
  compose?: boolean
  accountId?: string
  attachments?: { fileName: string; filePath: string; contentType?: string }[]
}

function jsonRes(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return jsonRes({ error: 'Method not allowed' })

  const auth = req.headers.get('Authorization')
  if (!auth) return jsonRes({ error: 'Unauthorized' }, 401)

  let body: ReqBody
  try { body = await req.json() } catch { return jsonRes({ error: 'Invalid JSON' }) }

  const { body: bodyContent, subject: reqSubject, to: reqTo, cc, bcc, isHtml, compose, accountId, attachments: attachmentRefs } = body
  const threadId = body.threadId?.trim() || null

  if (!bodyContent?.trim()) return jsonRes({ error: 'body is required' })
  if (compose && !reqTo?.trim()) return jsonRes({ error: 'to is required for compose' })

  const service = createClient(supabaseUrl, serviceKey)

  let orgId: string
  let imapAccountId: string
  let toAddress: string
  let subject: string
  let inReplyTo: string | undefined
  let references: string | undefined

  if (threadId && !compose) {
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } },
    })
    const { data: thread, error: tErr } = await userClient.from('inbox_threads')
      .select('id, org_id, channel, subject').eq('id', threadId).single()
    if (tErr || !thread) return jsonRes({ error: 'Thread not found or access denied' })
    if (thread.channel !== 'email') return jsonRes({ error: 'Reply only supported for email threads' })
    orgId = thread.org_id as string
    subject = reqSubject?.trim() || (thread.subject as string) || 'Re: (No subject)'

    const { data: msgs } = await userClient.from('inbox_messages')
      .select('id, imap_account_id, from_identifier, to_identifier, external_id')
      .eq('thread_id', threadId).order('received_at', { ascending: false })
    const last = msgs?.[0]
    imapAccountId = (accountId || last?.imap_account_id) as string
    if (!imapAccountId) return jsonRes({ error: 'No email account for this thread' })
    toAddress = reqTo?.trim() || (last?.from_identifier as string) || ''
    inReplyTo = (last?.external_id as string) ?? undefined
    references = msgs?.slice(0, 10).map(m => m.external_id).filter(Boolean).reverse().join(' ') || undefined
  } else {
    if (!accountId) {
      const { data: { user }, error: uErr } = await createClient(supabaseUrl, serviceKey).auth.getUser(auth.replace('Bearer ', ''))
      if (uErr || !user) return jsonRes({ error: 'Invalid token' }, 401)
      const { data: orgs } = await service.from('organization_users').select('org_id').eq('user_id', user.id).limit(1)
      if (!orgs?.length) return jsonRes({ error: 'No org membership' })
      orgId = orgs[0].org_id as string
      const { data: accs } = await service.from('imap_accounts').select('id').eq('org_id', orgId).eq('is_active', true).limit(1)
      if (!accs?.length) return jsonRes({ error: 'No active email account' })
      imapAccountId = accs[0].id as string
    } else {
      imapAccountId = accountId
      const { data: acc } = await service.from('imap_accounts').select('org_id').eq('id', accountId).single()
      orgId = (acc?.org_id as string) || ''
    }
    toAddress = reqTo?.trim() || ''
    subject = reqSubject?.trim() || '(No subject)'
  }

  if (!toAddress || !toAddress.includes('@')) return jsonRes({ error: 'Valid recipient (to) is required' })
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) return jsonRes({ error: 'ENCRYPTION_KEY not configured' })

  const { data: account, error: accErr } = await service.from('imap_accounts')
    .select('id, org_id, email, label, smtp_host, smtp_port, smtp_use_tls, smtp_username, smtp_credentials_encrypted, credentials_encrypted')
    .eq('id', imapAccountId).single()
  if (accErr || !account) return jsonRes({ error: 'IMAP account not found' })

  let smtpPass: string
  const encKey = encryptionKeyHex.slice(0, 64)
  try {
    smtpPass = account.smtp_credentials_encrypted
      ? await decrypt(account.smtp_credentials_encrypted as string, encKey)
      : await decrypt(account.credentials_encrypted as string, encKey)
  } catch { return jsonRes({ error: 'Failed to decrypt SMTP credentials' }) }

  const transporter = nodemailer.createTransport({
    host: account.smtp_host, port: Number(account.smtp_port) || 587,
    secure: (account.smtp_use_tls === true && Number(account.smtp_port) === 465),
    auth: { user: account.smtp_username || account.email, pass: smtpPass },
  })

  const mailOpts: Record<string, unknown> = {
    from: account.label ? `${account.label} <${account.email}>` : account.email,
    to: toAddress, subject,
    inReplyTo, references,
  }
  if (cc?.trim()) mailOpts.cc = cc.trim()
  if (bcc?.trim()) mailOpts.bcc = bcc.trim()

  if (isHtml) {
    mailOpts.html = bodyContent
    mailOpts.text = stripHtml(bodyContent)
  } else {
    mailOpts.text = bodyContent
  }

  if (attachmentRefs?.length) {
    const nodeAttachments: { filename: string; content: Uint8Array; contentType?: string }[] = []
    for (const att of attachmentRefs) {
      const { data: fileData, error: dlErr } = await service.storage.from('inbox-attachments').download(att.filePath)
      if (dlErr || !fileData) continue
      const buf = new Uint8Array(await fileData.arrayBuffer())
      nodeAttachments.push({ filename: att.fileName, content: buf, contentType: att.contentType })
    }
    if (nodeAttachments.length > 0) mailOpts.attachments = nodeAttachments
  }

  try {
    await transporter.sendMail(mailOpts)
  } catch (err) {
    return jsonRes({ error: 'Send failed: ' + (err instanceof Error ? err.message : String(err)) })
  }

  const now = new Date().toISOString()
  let saveThreadId = threadId

  if (!saveThreadId) {
    const { data: newThread } = await service.from('inbox_threads').insert({
      org_id: orgId, channel: 'email', status: 'closed', subject,
      last_message_at: now, imap_account_id: imapAccountId,
      from_address: account.email as string,
    }).select('id').single()
    saveThreadId = (newThread as { id: string })?.id ?? null
  }

  if (saveThreadId) {
    const msgPayload: Record<string, unknown> = {
      thread_id: saveThreadId, channel: 'email', direction: 'outbound',
      from_identifier: account.email, to_identifier: toAddress,
      cc: cc?.trim() || null, imap_account_id: account.id, received_at: now,
    }
    if (isHtml) { msgPayload.html_body = bodyContent; msgPayload.body = stripHtml(bodyContent) }
    else { msgPayload.body = bodyContent }

    await service.from('inbox_messages').insert(msgPayload)
    await service.from('inbox_threads').update({ last_message_at: now, updated_at: now }).eq('id', saveThreadId)
  }

  return jsonRes({ ok: true, threadId: saveThreadId })
})
