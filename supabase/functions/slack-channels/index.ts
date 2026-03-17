import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const { orgId } = await req.json().catch(() => ({})) as { orgId?: string }
  if (!orgId) return new Response(JSON.stringify({ error: 'orgId required' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const service = createClient(supabaseUrl, serviceKey)
  const { data: config, error: cfgErr } = await service
    .from('slack_configs')
    .select('bot_token, is_active')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (cfgErr) {
    return new Response(JSON.stringify({ error: `Failed to load Slack config: ${cfgErr.message}`, channels: [] }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  if (!config?.bot_token) {
    return new Response(JSON.stringify({ error: 'No Slack bot token configured for this workspace.', channels: [] }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const [channelsRes, authRes] = await Promise.all([
      fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=1000', {
        headers: { 'Authorization': `Bearer ${config.bot_token}` },
      }),
      fetch('https://slack.com/api/auth.test', {
        headers: { 'Authorization': `Bearer ${config.bot_token}` },
      }),
    ])

    const channelsData = await channelsRes.json()
    if (!channelsData.ok) {
      const err = channelsData.error ?? 'unknown_error'
      return new Response(JSON.stringify({ error: `Slack API error: ${err}`, channels: [] }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const authData = await authRes.json().catch(() => ({}))
    const workspaceDomain = typeof authData?.url === 'string'
      ? (authData.url.match(/^https?:\/\/([a-z0-9-]+)\.slack\.com/i)?.[1] ?? null)
      : null

    const channels = (channelsData.channels ?? [])
      .map((c: { id: string; name: string; is_private?: boolean; is_member?: boolean }) => ({
        id: c.id,
        name: c.name,
        is_private: c.is_private ?? false,
        is_member: c.is_member ?? false,
      }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))

    return new Response(JSON.stringify({ channels, workspaceDomain, isActive: config.is_active ?? false }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message, channels: [] }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
