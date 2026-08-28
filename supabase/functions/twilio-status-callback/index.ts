import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const raw = await req.text()
  const params = new URLSearchParams(raw)
  const messageSid = params.get('MessageSid') ?? params.get('SmsMessageSid') ?? ''
  const status = params.get('MessageStatus') ?? params.get('SmsStatus') ?? ''
  const errorCode = params.get('ErrorCode')
  const errorMessage = params.get('ErrorMessage')
  if (!messageSid) return json({ error: 'MessageSid is required' }, 400)

  const service = createClient(supabaseUrl, serviceKey)
  const { data: msg, error } = await service
    .from('inbox_messages')
    .update({
      twilio_status: status || null,
      error_message: errorMessage || errorCode || null,
      meta: Object.fromEntries(params.entries()),
    })
    .eq('twilio_message_sid', messageSid)
    .select('id, thread_id')
    .maybeSingle()

  if (error) return json({ error: error.message }, 500)
  return json({ ok: true, updated: !!msg })
})
