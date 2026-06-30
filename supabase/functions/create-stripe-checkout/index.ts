import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { invoiceId, successUrl, cancelUrl } = await req.json() as {
      invoiceId?: string
      successUrl?: string
      cancelUrl?: string
    }

    if (!invoiceId) {
      return new Response(
        JSON.stringify({ error: 'invoiceId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const service = createClient(supabaseUrl, serviceKey)

    const { data: invoice, error: invErr } = await service
      .from('invoices')
      .select('id, org_id, number, prefix, amount_due, status, payment_methods')
      .eq('id', invoiceId)
      .single()

    if (invErr || !invoice) {
      return new Response(
        JSON.stringify({ error: `Invoice not found: ${invErr?.message ?? 'unknown'}` }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return new Response(
        JSON.stringify({ error: `Invoice is already ${invoice.status}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const paymentMethods = invoice.payment_methods as Record<string, unknown> | null
    if (paymentMethods?.stripe === false) {
      return new Response(
        JSON.stringify({ error: 'Card payments are not enabled for this invoice.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { data: org, error: orgErr } = await service
      .from('organizations')
      .select('name, settings')
      .eq('id', invoice.org_id)
      .single()

    if (orgErr || !org) {
      return new Response(
        JSON.stringify({ error: 'Organization not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const settings = org.settings as Record<string, unknown> | null
    const stripeSecretKey = settings?.stripe_secret_key as string | undefined

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: 'Stripe is not configured for this organization. Ask an admin to add Stripe keys in Admin → Payments.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const amountCents = Math.round((invoice.amount_due ?? 0) * 100)
    const invoiceLabel = `${(invoice.prefix ?? 'INV-').replace(/-+$/, '')}-${String(invoice.number ?? '').padStart(4, '0')}`
    const orgName = (org.name as string) || 'Brogrammers Agency'

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${orgName} — Invoice ${invoiceLabel}`,
              description: `Payment to ${orgName}`,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        invoice_id: invoice.id,
        org_id: invoice.org_id,
      },
      success_url: successUrl || `${req.headers.get('origin') ?? ''}/invoices/${invoice.id}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${req.headers.get('origin') ?? ''}/invoices/${invoice.id}?payment=cancelled`,
    })

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
