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
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const service = createClient(supabaseUrl, serviceKey)

    // Fetch the invoice with org settings
    const { data: invoice, error: invErr } = await service
      .from('invoices')
      .select('id, org_id, invoice_number, amount_due, currency, status, company_id, companies(name)')
      .eq('id', invoiceId)
      .single()

    if (invErr || !invoice) {
      return new Response(
        JSON.stringify({ error: `Invoice not found: ${invErr?.message ?? 'unknown'}` }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return new Response(
        JSON.stringify({ error: `Invoice is already ${invoice.status}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get org Stripe keys from settings
    const { data: org, error: orgErr } = await service
      .from('organizations')
      .select('settings')
      .eq('id', invoice.org_id)
      .single()

    if (orgErr || !org) {
      return new Response(
        JSON.stringify({ error: 'Organization not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const settings = org.settings as Record<string, unknown> | null
    const stripeSecretKey = settings?.stripe_secret_key as string | undefined

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: 'Stripe is not configured for this organization. Ask an admin to add Stripe keys in Admin → Payments.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const amountCents = Math.round((invoice.amount_due ?? 0) * 100)
    const companyName = Array.isArray(invoice.companies)
      ? invoice.companies[0]?.name
      : (invoice.companies as { name: string } | null)?.name

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: (invoice.currency ?? 'usd').toLowerCase(),
            product_data: {
              name: `Invoice ${invoice.invoice_number}`,
              description: companyName ? `Payment to ${companyName}` : undefined,
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
      success_url: successUrl || `${req.headers.get('origin') ?? ''}/invoices/${invoice.id}?payment=success`,
      cancel_url: cancelUrl || `${req.headers.get('origin') ?? ''}/invoices/${invoice.id}?payment=cancelled`,
    })

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
