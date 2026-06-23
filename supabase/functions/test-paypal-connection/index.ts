import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { username, password, signature, mode } = await req.json() as {
      username?: string
      password?: string
      signature?: string
      mode?: string
    }

    if (!username || !password || !signature) {
      return new Response(JSON.stringify({ error: 'username, password, and signature are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const endpoint = mode === 'live'
      ? 'https://api-3t.paypal.com/nvp'
      : 'https://api-3t.sandbox.paypal.com/nvp'

    const params = new URLSearchParams({
      METHOD: 'GetBalance',
      VERSION: '204',
      USER: username.trim(),
      PWD: password.trim(),
      SIGNATURE: signature.trim(),
    })

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })

    const text = await res.text()
    const result = Object.fromEntries(new URLSearchParams(text))

    if (result.ACK === 'Success' || result.ACK === 'SuccessWithWarning') {
      return new Response(JSON.stringify({ success: true, ack: result.ACK }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: result.L_LONGMESSAGE0 || result.L_SHORTMESSAGE0 || 'Invalid credentials',
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
