// Process all pending notification_queue rows for an org. Called from Admin when app_config was missing
// so queued items were never sent. Requires JWT and org admin; uses NOTIFICATION_INTERNAL_SECRET to
// call process-user-notification for each pending row.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const internalSecret = Deno.env.get('NOTIFICATION_INTERNAL_SECRET') ?? ''

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  let orgId: string
  try {
    const body = (await req.json().catch(() => ({}))) as { orgId?: string }
    orgId = body.orgId ?? ''
    if (!orgId) {
      return new Response(JSON.stringify({ error: 'orgId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isAdmin, error: rpcErr } = await userClient.rpc('is_org_admin', { p_org_id: orgId })
  if (rpcErr || !isAdmin) {
    return new Response(JSON.stringify({ error: 'Not an org admin' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  if (!internalSecret) {
    return new Response(JSON.stringify({ error: 'Notification processor not configured (missing NOTIFICATION_INTERNAL_SECRET)' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const admin = createClient(supabaseUrl, serviceKey)
  const { data: rows, error: listErr } = await admin
    .from('notification_queue')
    .select('id')
    .eq('org_id', orgId)
    .is('sent_at', null)
    .order('created_at', { ascending: true })

  if (listErr) {
    return new Response(JSON.stringify({ error: listErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const ids = (rows ?? []) as { id: string }[]
  const processorUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/process-user-notification`
  let processed = 0
  for (const row of ids) {
    const res = await fetch(processorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': internalSecret,
      },
      body: JSON.stringify({ queue_id: row.id }),
    })
    if (res.ok) processed += 1
  }

  return new Response(JSON.stringify({ ok: true, processed, total: ids.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
