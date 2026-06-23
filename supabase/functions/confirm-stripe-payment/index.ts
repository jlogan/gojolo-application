import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { invoiceId, sessionId } = await req.json() as { invoiceId?: string; sessionId?: string }
    if (!invoiceId || !sessionId) {
      return new Response(JSON.stringify({ error: 'invoiceId and sessionId are required' }), {
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

    const stripeSecretKey = (org?.settings as Record<string, unknown> | null)?.stripe_secret_key as string | undefined
    if (orgErr || !stripeSecretKey) {
      return new Response(JSON.stringify({ error: 'Stripe is not configured' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.metadata?.invoice_id !== invoiceId) {
      return new Response(JSON.stringify({ error: 'Session does not match invoice' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (session.payment_status !== 'paid') {
      return new Response(JSON.stringify({ paid: false, status: session.payment_status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const txnId = (session.payment_intent as string | null) || session.id
    const amount = ((session.amount_total ?? Math.round((invoice.amount_due ?? 0) * 100)) / 100)

    const { data: existing } = await service
      .from('invoice_payments')
      .select('id')
      .eq('invoice_id', invoiceId)
      .eq('transaction_id', txnId)
      .maybeSingle()

    if (!existing) {
      const { error: payErr } = await service.from('invoice_payments').insert({
        invoice_id: invoiceId,
        amount,
        payment_method: 'stripe',
        transaction_id: txnId,
        payment_date: new Date().toISOString().slice(0, 10),
        note: `Stripe checkout — Session ${session.id}`,
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
