// Send a test DM to a Slack user. Used from Admin > Slack > User mapping to verify the bot can message users.
// Slack bot needs im:write (or chat:write) to open DMs and post to them.

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
    const body = (await req.json().catch(() => ({}))) as { orgId?: string; slackUserId?: string }
    const { orgId, slackUserId } = body
    if (!orgId || !slackUserId) {
      return new Response(JSON.stringify({ error: 'orgId and slackUserId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const admin = createClient(supabaseUrl, serviceKey)

    const { data: config, error: cfgErr } = await admin
      .from('slack_configs')
      .select('bot_token')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()

    if (cfgErr || !config?.bot_token) {
      return new Response(JSON.stringify({ error: 'Slack is not configured or inactive for this workspace.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.bot_token}` },
      body: JSON.stringify({ users: slackUserId }),
    })
    const openData = await openRes.json() as { ok?: boolean; error?: string; channel?: { id?: string } }
    if (!openRes.ok || !openData.ok) {
      const err = openData.error ?? 'Slack API error'
      let msg = err
      if (err === 'missing_scope') msg = 'Bot needs im:write scope to open DMs. Add it in Slack app settings (OAuth & Permissions) and reinstall.'
      else if (err === 'user_not_found' || err === 'invalid_users') msg = 'Slack user not found or not in this workspace.'
      else if (err === 'method_not_supported_for_channel_type') msg = 'Cannot open a DM with this user. Check app permissions.'
      return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const channelId = openData.channel?.id
    if (!channelId) {
      return new Response(JSON.stringify({ error: 'No channel ID returned from Slack.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const text = '✅ *Test from jolo* — If you see this, the bot can send you DMs. Assignment and mention notifications will work here.'

    const postRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.bot_token}` },
      body: JSON.stringify({ channel: channelId, text, unfurl_links: false }),
    })

    const postData = await postRes.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!postRes.ok || !postData.ok) {
      const msg = postData.error === 'channel_not_found' ? 'Could not send to DM channel.' : (postData.error ?? 'Slack API error')
      return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true, message: 'Test DM sent. Check the user\'s Slack DMs.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
