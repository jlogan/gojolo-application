import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function twiml(status = 200) {
  return new Response('<Response></Response>', { status, headers: { 'Content-Type': 'text/xml' } })
}

function normalizePhone(value: string | null): string {
  return (value ?? '').trim()
}

async function decrypt(ciphertextB64: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0))
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 }, key, combined.slice(12))
  return new TextDecoder().decode(dec)
}

function base64(bytes: ArrayBuffer): string {
  let s = ''
  new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b) })
  return btoa(s)
}

async function validateTwilioSignature(req: Request, params: URLSearchParams, authToken: string): Promise<boolean> {
  const signature = req.headers.get('x-twilio-signature') ?? ''
  if (!signature) return false
  const url = new URL(req.url)
  const configuredPublicUrl = Deno.env.get('PUBLIC_FUNCTIONS_BASE_URL')?.replace(/\/$/, '')
  const webhookUrl = configuredPublicUrl ? `${configuredPublicUrl}${url.pathname}` : req.url
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
  const payload = webhookUrl + sorted.map(([k, v]) => `${k}${v}`).join('')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return base64(mac) === signature
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const raw = await req.text()
  const params = new URLSearchParams(raw)
  const from = normalizePhone(params.get('From'))
  const to = normalizePhone(params.get('To'))
  const body = params.get('Body') ?? ''
  const messageSid = params.get('MessageSid') ?? params.get('SmsMessageSid') ?? ''
  const accountSid = params.get('AccountSid') ?? ''
  const numMedia = Number(params.get('NumMedia') ?? '0') || 0
  const mediaUrls = Array.from({ length: numMedia }, (_, i) => ({
    url: params.get(`MediaUrl${i}`),
    contentType: params.get(`MediaContentType${i}`),
  })).filter((m) => m.url)
  const channel = mediaUrls.length > 0 ? 'mms' : 'sms'

  if (!from || !to || !messageSid) return twiml(400)
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) return twiml(500)

  const service = createClient(supabaseUrl, serviceKey)
  const { data: phoneNumber, error: phoneErr } = await service
    .from('phone_numbers')
    .select('id, org_id, phone_number, twilio_account_id, twilio_accounts(id, account_sid, auth_token_encrypted, is_active)')
    .eq('phone_number', to)
    .eq('is_active', true)
    .maybeSingle()

  if (phoneErr || !phoneNumber?.org_id) {
    console.log('[twilio-inbound] unknown destination', { to, messageSid, error: phoneErr?.message })
    return twiml(404)
  }

  const acct = Array.isArray(phoneNumber.twilio_accounts) ? phoneNumber.twilio_accounts[0] : phoneNumber.twilio_accounts
  if (!acct?.auth_token_encrypted || (acct.account_sid && acct.account_sid !== accountSid)) return twiml(403)

  let authToken = ''
  try { authToken = await decrypt(acct.auth_token_encrypted as string, encryptionKeyHex.slice(0, 64)) } catch {
    console.log('[twilio-inbound] failed to decrypt auth token', { to, messageSid })
    return twiml(500)
  }
  if (!(await validateTwilioSignature(req, params, authToken))) {
    console.log('[twilio-inbound] invalid signature', { to, from, messageSid })
    return twiml(403)
  }

  const normalizedBody = body.trim().toUpperCase()
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(normalizedBody)) {
    await service.from('sms_opt_outs').upsert({
      org_id: phoneNumber.org_id,
      phone_number: from,
      opted_out: true,
      last_message: body,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,phone_number' })
  } else if (['START', 'YES', 'UNSTOP'].includes(normalizedBody)) {
    await service.from('sms_opt_outs').upsert({
      org_id: phoneNumber.org_id,
      phone_number: from,
      opted_out: false,
      last_message: body,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,phone_number' })
  }

  const externalThreadKey = [to, from].sort().join(':')
  const now = new Date().toISOString()
  let threadId: string | null = null

  const { data: existingThread } = await service
    .from('inbox_threads')
    .select('id')
    .eq('org_id', phoneNumber.org_id)
    .eq('external_thread_key', externalThreadKey)
    .in('channel', ['sms', 'mms'])
    .maybeSingle()

  threadId = existingThread?.id ?? null
  if (!threadId) {
    const { data: thread, error: threadErr } = await service.from('inbox_threads').insert({
      org_id: phoneNumber.org_id,
      channel,
      status: 'open',
      subject: `SMS from ${from}`,
      from_address: from,
      phone_number_id: phoneNumber.id,
      external_thread_key: externalThreadKey,
      last_message_at: now,
      updated_at: now,
    }).select('id').single()
    if (threadErr || !thread) {
      console.log('[twilio-inbound] thread insert failed', threadErr?.message)
      return twiml(500)
    }
    threadId = thread.id as string
  } else {
    await service.from('inbox_threads').update({ status: 'open', channel, last_message_at: now, updated_at: now }).eq('id', threadId)
  }

  const { error: msgErr } = await service.from('inbox_messages').insert({
    thread_id: threadId,
    channel,
    direction: 'inbound',
    from_identifier: from,
    to_identifier: to,
    body,
    external_id: messageSid,
    twilio_message_sid: messageSid,
    twilio_status: params.get('SmsStatus') ?? 'received',
    phone_number_id: phoneNumber.id,
    media_urls: mediaUrls,
    received_at: now,
    meta: Object.fromEntries(params.entries()),
  })

  if (msgErr && !msgErr.message.includes('duplicate')) {
    console.log('[twilio-inbound] message insert failed', msgErr.message)
    return twiml(500)
  }

  return twiml()
})
