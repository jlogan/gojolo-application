import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.text()
    const sig = req.headers.get('stripe-signature')

    // We need to determine which org this webhook is for.
    // Stripe sends the event payload directly — we parse it and look up the org from metadata.
    // Note: For production, you should verify the webhook signature per-org.
    // For now, we parse the event and use metadata.org_id to look up the Stripe key for verification.

    const event = JSON.parse(body) as Stripe.Event

    if (event.type !== 'checkout.session.completed') {
      return new Response(JSON.stringify({ received: true, ignored: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const session = event.data.object as Stripe.Checkout.Session
    const invoiceId = session.metadata?.invoice_id
    const orgId = session.metadata?.org_id

    if (!invoiceId || !orgId) {
      return new Response(
        JSON.stringify({ error: 'Missing invoice_id or org_id in session metadata' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const service = createClient(supabaseUrl, serviceKey)

    // Optionally verify webhook signature if org has a webhook secret configured
    const { data: org } = await service
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .single()

    const settings = org?.settings as Record<string, unknown> | null
    const stripeSecretKey = settings?.stripe_secret_key as string | undefined
    const webhookSecret = settings?.stripe_webhook_secret as string | undefined

    if (webhookSecret && sig && stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, {
          apiVersion: '2023-10-16',
          httpClient: Stripe.createFetchHttpClient(),
        })
        stripe.webhooks.constructEvent(body, sig, webhookSecret)
      } catch (err) {
        return new Response(
          JSON.stringify({ error: `Webhook signature verification failed: ${(err as Error).message}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // Fetch the invoice to get current state
    const { data: invoice, error: invErr } = await service
      .from('invoices')
      .select('id, amount_due, total_amount, status')
      .eq('id', invoiceId)
      .eq('org_id', orgId)
      .single()

    if (invErr || !invoice) {
      return new Response(
        JSON.stringify({ error: `Invoice not found: ${invErr?.message ?? 'unknown'}` }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const amountPaid = (session.amount_total ?? 0) / 100

    // Record the payment
    const { error: payErr } = await service
      .from('invoice_payments')
      .insert({
        invoice_id: invoiceId,
        org_id: orgId,
        amount: amountPaid,
        method: 'stripe',
        stripe_session_id: session.id,
        stripe_payment_intent: session.payment_intent as string,
        paid_at: new Date().toISOString(),
        note: `Stripe checkout payment — Session ${session.id}`,
      })

    if (payErr) {
      console.error('Failed to record payment:', payErr.message)
      return new Response(
        JSON.stringify({ error: `Failed to record payment: ${payErr.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Calculate new amount_due and update invoice status
    const newAmountDue = Math.max(0, (invoice.amount_due ?? invoice.total_amount ?? 0) - amountPaid)
    const newStatus = newAmountDue <= 0 ? 'paid' : 'partially_paid'

    const { error: updErr } = await service
      .from('invoices')
      .update({
        amount_due: newAmountDue,
        status: newStatus,
        paid_at: newStatus === 'paid' ? new Date().toISOString() : undefined,
      })
      .eq('id', invoiceId)

    if (updErr) {
      console.error('Failed to update invoice status:', updErr.message)
    }

    return new Response(
      JSON.stringify({ received: true, payment_recorded: true, new_status: newStatus }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('Webhook error:', (err as Error).message)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
