import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const { orgId } = (await req.json().catch(() => ({}))) as { orgId?: string }
  if (!orgId) {
    return new Response(JSON.stringify({ error: 'orgId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const service = createClient(supabaseUrl, serviceKey)
  const { data: config, error: cfgErr } = await service
    .from('slack_configs')
    .select('bot_token')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  if (cfgErr || !config?.bot_token) {
    return new Response(JSON.stringify({ error: 'Slack not configured or inactive for this workspace.', users: [] }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const res = await fetch('https://slack.com/api/users.list?limit=500', {
      headers: { 'Authorization': `Bearer ${config.bot_token}` },
    })
    const data = await res.json() as { ok?: boolean; error?: string; members?: { id: string; name: string; real_name?: string; profile?: { email?: string }; is_bot?: boolean; deleted?: boolean }[] }
    if (!data.ok) {
      return new Response(JSON.stringify({ error: data.error ?? 'Slack API error', users: [] }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const users = (data.members ?? [])
      .filter((m) => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT')
      .map((m) => ({
        id: m.id,
        label: [m.real_name || m.name, m.profile?.email].filter(Boolean).join(' • ') || m.name,
        name: m.real_name || m.name,
        email: m.profile?.email ?? null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))

    return new Response(JSON.stringify({ users }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message, users: [] }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
