import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

interface ReqBody {
  threadId?: string
  to?: string
  body?: string
  phoneNumberId?: string
  attachments?: { fileName: string; filePath: string; contentType?: string; fileSize?: number }[]
  compose?: boolean
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function normalizePhone(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s().-]/g, '').trim()
}

async function decrypt(ciphertextB64: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0))
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 }, key, combined.slice(12))
  return new TextDecoder().decode(dec)
}

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'Unauthorized' }, 401)
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) return json({ error: 'ENCRYPTION_KEY not configured' }, 500)

  let payload: ReqBody
  try { payload = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const bodyText = stripHtml(payload.body ?? '')
  const hasAttachments = (payload.attachments?.length ?? 0) > 0
  if (!bodyText && !hasAttachments) return json({ error: 'body is required' }, 400)

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
  const service = createClient(supabaseUrl, serviceKey)

  let orgId = ''
  let to = normalizePhone(payload.to)
  let threadId = payload.threadId?.trim() || null
  let phoneNumberId = payload.phoneNumberId?.trim() || ''
  let externalThreadKey = ''

  if (threadId && !payload.compose) {
    const { data: thread, error } = await userClient
      .from('inbox_threads')
      .select('id, org_id, channel, phone_number_id, external_thread_key')
      .eq('id', threadId)
      .single()
    if (error || !thread) return json({ error: 'Thread not found or access denied' }, 404)
    if (!['sms', 'mms'].includes(thread.channel as string)) return json({ error: 'Thread is not an SMS/MMS thread' }, 400)
    orgId = thread.org_id as string
    phoneNumberId = (payload.phoneNumberId || thread.phone_number_id || '') as string
    externalThreadKey = (thread.external_thread_key || '') as string

    if (!to) {
      const { data: lastInbound } = await userClient
        .from('inbox_messages')
        .select('from_identifier')
        .eq('thread_id', threadId)
        .eq('direction', 'inbound')
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      to = normalizePhone(lastInbound?.from_identifier as string | undefined)
    }
  } else {
    if (!to) return json({ error: 'Valid phone recipient is required' }, 400)
    const { data: { user }, error: userErr } = await service.auth.getUser(auth.replace('Bearer ', ''))
    if (userErr || !user) return json({ error: 'Invalid token' }, 401)
    const { data: orgs } = await service.from('organization_users').select('org_id').eq('user_id', user.id).limit(1)
    if (!orgs?.length) return json({ error: 'No org membership' }, 403)
    orgId = orgs[0].org_id as string
  }

  const phoneQuery = service
    .from('phone_numbers')
    .select('id, org_id, phone_number, twilio_account_id, mms_enabled, sms_enabled, twilio_accounts(id, account_sid, auth_token_encrypted, is_active)')
    .eq('org_id', orgId)
    .eq('is_active', true)
  const { data: phones, error: phonesErr } = phoneNumberId
    ? await phoneQuery.eq('id', phoneNumberId).limit(1)
    : await phoneQuery.eq('sms_enabled', true).limit(1)
  if (phonesErr || !phones?.length) return json({ error: 'No active Twilio phone number configured for this org' }, 400)

  const phone = phones[0]
  const from = phone.phone_number as string
  const account = Array.isArray(phone.twilio_accounts) ? phone.twilio_accounts[0] : phone.twilio_accounts
  if (!account?.account_sid || !account?.auth_token_encrypted || account.is_active === false) return json({ error: 'Twilio account is not configured' }, 400)

  const { data: optOut } = await service
    .from('sms_opt_outs')
    .select('opted_out')
    .eq('org_id', orgId)
    .eq('phone_number', to)
    .maybeSingle()
  if (optOut?.opted_out) return json({ error: 'Recipient has opted out of SMS' }, 400)

  const mediaUrls: string[] = []
  if (payload.attachments?.length) {
    if (phone.mms_enabled === false) return json({ error: 'MMS is not enabled for the selected phone number' }, 400)
    for (const att of payload.attachments) {
      const { data: signed, error } = await service.storage.from('inbox-attachments').createSignedUrl(att.filePath, 60 * 60 * 24 * 7)
      if (error || !signed?.signedUrl) return json({ error: `Failed to prepare MMS attachment: ${att.fileName}` }, 400)
      mediaUrls.push(signed.signedUrl)
    }
  }

  const authToken = await decrypt(account.auth_token_encrypted as string, encryptionKeyHex.slice(0, 64))
  const body = new URLSearchParams({ From: from, To: to })
  if (bodyText) body.set('Body', bodyText)
  mediaUrls.forEach((url) => body.append('MediaUrl', url))
  const statusCallbackBase = Deno.env.get('PUBLIC_FUNCTIONS_BASE_URL')?.replace(/\/$/, '')
  if (statusCallbackBase) body.set('StatusCallback', `${statusCallbackBase}/twilio-status-callback`)

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account.account_sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${account.account_sid}:${authToken}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const twilio = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) return json({ error: `Twilio send failed: ${twilio.message ?? res.statusText}` }, 502)

  const now = new Date().toISOString()
  const channel = mediaUrls.length > 0 ? 'mms' : 'sms'
  if (!threadId) {
    externalThreadKey = [from, to].sort().join(':')
    const { data: existing } = await service
      .from('inbox_threads')
      .select('id')
      .eq('org_id', orgId)
      .eq('external_thread_key', externalThreadKey)
      .in('channel', ['sms', 'mms'])
      .maybeSingle()
    threadId = existing?.id ?? null
    if (!threadId) {
      const { data: thread, error } = await service.from('inbox_threads').insert({
        org_id: orgId,
        channel,
        status: 'closed',
        subject: `SMS to ${to}`,
        from_address: from,
        phone_number_id: phone.id,
        external_thread_key: externalThreadKey,
        last_message_at: now,
        updated_at: now,
      }).select('id').single()
      if (error || !thread) return json({ error: 'Sent, but failed to create inbox thread' }, 500)
      threadId = thread.id as string
    }
  }

  const { data: inserted, error: msgErr } = await service.from('inbox_messages').insert({
    thread_id: threadId,
    channel,
    direction: 'outbound',
    from_identifier: from,
    to_identifier: to,
    body: bodyText,
    external_id: twilio.sid,
    twilio_message_sid: twilio.sid,
    twilio_status: twilio.status ?? 'queued',
    phone_number_id: phone.id,
    media_urls: mediaUrls.map((url) => ({ url })),
    received_at: now,
    meta: twilio,
  }).select('id').single()
  if (msgErr) return json({ error: 'Sent, but failed to save outbound message' }, 500)

  await service.from('inbox_threads').update({ channel, last_message_at: now, updated_at: now }).eq('id', threadId)
  return json({ ok: true, threadId, messageId: inserted.id, twilioSid: twilio.sid, status: twilio.status })
})
