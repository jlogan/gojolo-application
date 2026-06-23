import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function nvpEndpoint(mode?: string) {
  return mode === 'live'
    ? 'https://api-3t.paypal.com/nvp'
    : 'https://api-3t.sandbox.paypal.com/nvp'
}

async function nvpRequest(endpoint: string, user: string, pwd: string, sig: string, params: Record<string, string>) {
  const body = new URLSearchParams({
    VERSION: '204',
    USER: user,
    PWD: pwd,
    SIGNATURE: sig,
    ...params,
  })
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`PayPal NVP request failed: ${res.status}`)
  return Object.fromEntries(new URLSearchParams(await res.text()))
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { invoiceId, successUrl, cancelUrl } = await req.json() as {
      invoiceId?: string
      successUrl?: string
      cancelUrl?: string
    }
    if (!invoiceId) {
      return new Response(JSON.stringify({ error: 'invoiceId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const service = createClient(supabaseUrl, serviceKey)
    const { data: invoice, error: invErr } = await service
      .from('invoices')
      .select('id, org_id, number, prefix, amount_due, status')
      .eq('id', invoiceId)
      .single()

    if (invErr || !invoice) {
      return new Response(JSON.stringify({ error: 'Invoice not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return new Response(JSON.stringify({ error: `Invoice is already ${invoice.status}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: org, error: orgErr } = await service
      .from('organizations')
      .select('name, settings')
      .eq('id', invoice.org_id)
      .single()

    const settings = org?.settings as Record<string, unknown> | null
    const user = settings?.paypal_username as string | undefined
    const pwd = settings?.paypal_password as string | undefined
    const sig = settings?.paypal_signature as string | undefined
    const mode = (settings?.paypal_mode as string | undefined) || 'sandbox'

    if (orgErr || !user || !pwd || !sig) {
      return new Response(JSON.stringify({ error: 'PayPal is not configured for this organization.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const endpoint = nvpEndpoint(mode)
    const amount = Number(invoice.amount_due ?? 0).toFixed(2)
    const invoiceLabel = `${(invoice.prefix ?? 'INV-').replace(/-+$/, '')}-${String(invoice.number ?? '').padStart(4, '0')}`
    const orgName = (org?.name as string) || 'Brogrammers Agency'

    const result = await nvpRequest(endpoint, user, pwd, sig, {
      METHOD: 'SetExpressCheckout',
      PAYMENTREQUEST_0_AMT: amount,
      PAYMENTREQUEST_0_CURRENCYCODE: 'USD',
      PAYMENTREQUEST_0_PAYMENTACTION: 'Sale',
      PAYMENTREQUEST_0_DESC: `Payment to ${orgName} — Invoice ${invoiceLabel}`,
      PAYMENTREQUEST_0_CUSTOM: invoice.id,
      RETURNURL: successUrl ?? '',
      CANCELURL: cancelUrl ?? '',
      BRANDNAME: orgName,
      NOSHIPPING: '1',
    })

    if (result.ACK !== 'Success' && result.ACK !== 'SuccessWithWarning') {
      throw new Error(result.L_LONGMESSAGE0 || result.L_SHORTMESSAGE0 || 'PayPal SetExpressCheckout failed')
    }

    const token = result.TOKEN
    const ppBase = mode === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com'
    const approveUrl = `${ppBase}/cgi-bin/webscr?cmd=_express-checkout&token=${token}`

    return new Response(JSON.stringify({ url: approveUrl, token }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
