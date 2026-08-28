import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

type ReqBody = {
  orgId?: string
  accountSid?: string
  authToken?: string
  label?: string
  syncNumbers?: boolean
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

async function encrypt(plain: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, new TextEncoder().encode(plain))
  const combined = new Uint8Array(iv.length + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.length)
  let s = ''
  combined.forEach((b) => { s += String.fromCharCode(b) })
  return btoa(s)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'Unauthorized' }, 401)
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) return json({ error: 'ENCRYPTION_KEY not configured' }, 500)

  let body: ReqBody
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const orgId = body.orgId?.trim()
  const accountSid = body.accountSid?.trim()
  const authToken = body.authToken?.trim()
  if (!orgId || !accountSid || !authToken) return json({ error: 'orgId, accountSid, and authToken are required' }, 400)

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
  const { data: org, error: orgErr } = await userClient.from('organizations').select('id').eq('id', orgId).single()
  if (orgErr || !org) return json({ error: 'Organization not found or access denied' }, 404)

  const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
    headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` },
  })
  const twilioAccount = await twilioRes.json().catch(() => ({})) as Record<string, unknown>
  if (!twilioRes.ok) return json({ error: `Twilio credentials failed: ${twilioAccount.message ?? twilioRes.statusText}` }, 400)

  const service = createClient(supabaseUrl, serviceKey)
  const encrypted = await encrypt(authToken, encryptionKeyHex.slice(0, 64))
  const { data: acct, error: saveErr } = await service.from('twilio_accounts').upsert({
    org_id: orgId,
    account_sid: accountSid,
    auth_token_encrypted: encrypted,
    label: body.label?.trim() || (twilioAccount.friendly_name as string | undefined) || 'Twilio',
    is_active: true,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id,account_sid' }).select('id, label, account_sid').single()
  if (saveErr || !acct) return json({ error: saveErr?.message ?? 'Failed to save Twilio account' }, 500)

  let syncedNumbers = 0
  if (body.syncNumbers !== false) {
    const numbersRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=1000`, {
      headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` },
    })
    const numbers = await numbersRes.json().catch(() => ({})) as { incoming_phone_numbers?: Record<string, unknown>[]; message?: string }
    if (numbersRes.ok) {
      for (const n of numbers.incoming_phone_numbers ?? []) {
        const num = n.phone_number as string | undefined
        if (!num) continue
        await service.from('phone_numbers').upsert({
          org_id: orgId,
          twilio_account_id: acct.id,
          twilio_sid: n.sid,
          phone_number: num,
          friendly_name: n.friendly_name ?? num,
          capabilities: n.capabilities ?? {},
          sms_enabled: Boolean((n.capabilities as { SMS?: boolean } | undefined)?.SMS ?? true),
          mms_enabled: Boolean((n.capabilities as { MMS?: boolean } | undefined)?.MMS ?? true),
          inbound_webhook_url: n.sms_url ?? null,
          status_callback_url: n.status_callback ?? null,
          is_active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'phone_number' })
        syncedNumbers += 1
      }
    }
  }

  return json({ ok: true, accountId: acct.id, accountSid: acct.account_sid, label: acct.label, syncedNumbers })
})
