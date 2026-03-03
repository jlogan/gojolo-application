import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const auth = req.headers.get('Authorization')
  if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const { orgId } = await req.json().catch(() => ({})) as { orgId?: string }
  if (!orgId) return new Response(JSON.stringify({ error: 'orgId required' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const service = createClient(supabaseUrl, serviceKey)
  const { data: config } = await service.from('slack_configs').select('bot_token').eq('org_id', orgId).eq('is_active', true).single()

  if (!config?.bot_token) {
    return new Response(JSON.stringify({ error: 'No Slack bot configured', channels: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const res = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200', {
      headers: { 'Authorization': `Bearer ${config.bot_token}` },
    })
    const data = await res.json()
    if (!data.ok) {
      return new Response(JSON.stringify({ error: data.error, channels: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const channels = (data.channels ?? [])
      .filter((c: { is_member?: boolean }) => c.is_member)
      .map((c: { id: string; name: string; is_private?: boolean }) => ({
        id: c.id, name: c.name, is_private: c.is_private ?? false,
      }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))

    return new Response(JSON.stringify({ channels }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message, channels: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
