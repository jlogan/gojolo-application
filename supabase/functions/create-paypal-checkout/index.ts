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
    const clientId = settings?.paypal_client_id as string | undefined
    const clientSecret = settings?.paypal_client_secret as string | undefined
    const mode = (settings?.paypal_mode as string | undefined) || 'sandbox'
    if (orgErr || !clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: 'PayPal is not configured for this organization.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const baseUrl = paypalBase(mode)
    const token = await paypalAccessToken(baseUrl, clientId, clientSecret)
    const amount = Number(invoice.amount_due ?? 0).toFixed(2)
    const invoiceLabel = `${(invoice.prefix ?? 'INV-').replace(/-+$/, '')}-${String(invoice.number ?? '').padStart(4, '0')}`
    const orgName = (org?.name as string) || 'Brogrammers Agency'

    const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: invoice.org_id,
            custom_id: invoice.id,
            invoice_id: invoiceLabel,
            description: `Payment to ${orgName} — Invoice ${invoiceLabel}`,
            amount: { currency_code: 'USD', value: amount },
          },
        ],
        application_context: {
          brand_name: orgName,
          user_action: 'PAY_NOW',
          return_url: successUrl,
          cancel_url: cancelUrl,
        },
      }),
    })

    const order = await res.json()
    if (!res.ok) throw new Error(`PayPal order failed: ${JSON.stringify(order)}`)
    const approve = order.links?.find((l: { rel: string; href: string }) => l.rel === 'approve')?.href
    if (!approve) throw new Error('PayPal approve link missing')

    return new Response(JSON.stringify({ url: approve, orderId: order.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
