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
    const body = (await req.json().catch(() => ({}))) as { taskId?: string; projectId?: string; commentId?: string; contentPreview?: string; authorName?: string }
    const { taskId, projectId, contentPreview, authorName } = body
    if (!taskId || !projectId) {
      return new Response(JSON.stringify({ error: 'taskId and projectId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const admin = createClient(supabaseUrl, serviceKey)

    const { data: task, error: taskErr } = await admin.from('tasks').select('id, title, org_id').eq('id', taskId).single()
    if (taskErr || !task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: channelRow, error: chErr } = await admin
      .from('slack_project_channels')
      .select('channel_id')
      .eq('project_id', projectId)
      .limit(1)
      .maybeSingle()

    if (chErr || !channelRow?.channel_id) {
      return new Response(JSON.stringify({ ok: true, skipped: 'No Slack channel linked to project' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: config, error: cfgErr } = await admin
      .from('slack_configs')
      .select('bot_token')
      .eq('org_id', task.org_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()

    if (cfgErr || !config?.bot_token) {
      return new Response(JSON.stringify({ ok: true, skipped: 'Slack not configured or inactive' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const preview = (contentPreview ?? '').slice(0, 300).replace(/\[[^\]]*\]\([^)]+\)/g, '[attachment]')
    const text = `💬 New comment on task *${(task.title || 'Task').replace(/[*_~`]/g, '')}* by ${authorName ?? 'Someone'}:\n${preview || '(no text)'}`

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.bot_token}` },
      body: JSON.stringify({ channel: channelRow.channel_id, text, unfurl_links: false }),
    })

    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) {
      return new Response(JSON.stringify({ error: data.error ?? 'Slack API error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
