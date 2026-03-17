import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { projectId?: string }
    const { projectId } = body
    if (!projectId) {
      return new Response(JSON.stringify({ error: 'projectId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const admin = createClient(supabaseUrl, serviceKey)

    const { data: project, error: projErr } = await admin.from('projects').select('id, org_id').eq('id', projectId).single()
    if (projErr || !project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: channelRow, error: chErr } = await admin
      .from('slack_project_channels')
      .select('channel_id')
      .eq('project_id', projectId)
      .limit(1)
      .maybeSingle()

    if (chErr || !channelRow?.channel_id) {
      return new Response(JSON.stringify({ error: 'No Slack channel linked to this project.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: config, error: cfgErr } = await admin
      .from('slack_configs')
      .select('bot_token')
      .eq('org_id', project.org_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()

    if (cfgErr || !config?.bot_token) {
      return new Response(JSON.stringify({ error: 'Slack is not configured or inactive for this workspace.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const text = '✅ *Test from jolo* — If you see this, project channel alerts are working. Task and email notifications will post here.'

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.bot_token}` },
      body: JSON.stringify({ channel: channelRow.channel_id, text, unfurl_links: false }),
    })

    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) {
      const msg = data.error === 'channel_not_found' ? 'Channel not found. Invite the jolo app to this channel in Slack.' : (data.error ?? 'Slack API error')
      return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true, message: 'Test message sent. Check the Slack channel.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
