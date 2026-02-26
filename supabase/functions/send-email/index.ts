// Sends transactional email via Resend. All app email notifications use this.
// Set RESEND_API_KEY in Supabase Edge Function secrets.
// Optional: RESEND_FROM (e.g. "jolo <notifications@gojolo.io>")

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'jolo <onboarding@resend.dev>'

interface SendEmailBody {
  to: string | string[]
  subject: string
  html: string
  from?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors() })
  }

  if (!RESEND_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'RESEND_API_KEY not configured' }),
      { status: 500, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = (await req.json()) as SendEmailBody
    const { to, subject, html, from = RESEND_FROM } = body

    if (!to || !subject || !html) {
      return new Response(
        JSON.stringify({ error: 'Missing to, subject, or html' }),
        { status: 400, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: data.message ?? 'Resend request failed' }),
        { status: res.status, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }

    return new Response(JSON.stringify({ id: data.id }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }
})

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}
