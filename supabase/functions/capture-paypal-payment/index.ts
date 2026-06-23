import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function paypalBase(mode?: string) {
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
}

async function paypalAccessToken(baseUrl: string, clientId: string, clientSecret: string) {
  const basic = btoa(`${clientId}:${clientSecret}`)
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`PayPal auth failed: ${await res.text()}`)
  const json = await res.json()
  return json.access_token as string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { invoiceId, orderId } = await req.json() as { invoiceId?: string; orderId?: string }
    if (!invoiceId || !orderId) {
      return new Response(JSON.stringify({ error: 'invoiceId and orderId are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const service = createClient(supabaseUrl, serviceKey)
    const { data: invoice, error: invErr } = await service
      .from('invoices')
      .select('id, org_id, amount_due')
      .eq('id', invoiceId)
      .single()

    if (invErr || !invoice) {
      return new Response(JSON.stringify({ error: 'Invoice not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: org, error: orgErr } = await service
      .from('organizations')
      .select('settings')
      .eq('id', invoice.org_id)
      .single()

    const settings = org?.settings as Record<string, unknown> | null
    const clientId = settings?.paypal_client_id as string | undefined
    const clientSecret = settings?.paypal_client_secret as string | undefined
    const mode = (settings?.paypal_mode as string | undefined) || 'sandbox'
    if (orgErr || !clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: 'PayPal is not configured' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const baseUrl = paypalBase(mode)
    const token = await paypalAccessToken(baseUrl, clientId, clientSecret)
    const captureRes = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    const capture = await captureRes.json()
    if (!captureRes.ok) throw new Error(`PayPal capture failed: ${JSON.stringify(capture)}`)
    if (capture.status !== 'COMPLETED') {
      return new Response(JSON.stringify({ paid: false, status: capture.status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const purchase = capture.purchase_units?.[0]
    if (purchase?.payments?.captures?.[0]?.custom_id && purchase.payments.captures[0].custom_id !== invoiceId) {
      return new Response(JSON.stringify({ error: 'PayPal order does not match invoice' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const captureId = purchase?.payments?.captures?.[0]?.id || orderId
    const value = Number(purchase?.payments?.captures?.[0]?.amount?.value ?? invoice.amount_due ?? 0)

    const { data: existing } = await service
      .from('invoice_payments')
      .select('id')
      .eq('invoice_id', invoiceId)
      .eq('transaction_id', captureId)
      .maybeSingle()

    if (!existing) {
      const { error: payErr } = await service.from('invoice_payments').insert({
        invoice_id: invoiceId,
        amount: value,
        payment_method: 'paypal',
        transaction_id: captureId,
        payment_date: new Date().toISOString().slice(0, 10),
        note: `PayPal checkout — Order ${orderId}`,
      })
      if (payErr) throw payErr
    }

    return new Response(JSON.stringify({ paid: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
