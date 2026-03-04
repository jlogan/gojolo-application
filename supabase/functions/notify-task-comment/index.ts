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

    const { data: task, error: taskErr } = await admin.from('tasks').select('id, title, org_id, status, priority').eq('id', taskId).single()
    if (taskErr || !task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    const taskData = task as { id: string; title: string; org_id: string; status?: string; priority?: string }

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
      .select('bot_token, notify_on_task_comment')
      .eq('org_id', task.org_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()

    if (cfgErr || !config?.bot_token) {
      return new Response(JSON.stringify({ ok: true, skipped: 'Slack not configured or inactive' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (config.notify_on_task_comment === false) {
      return new Response(JSON.stringify({ ok: true, skipped: 'Task comment notifications disabled' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const taskTitle = (taskData.title || 'Task').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    const preview = (contentPreview ?? '').slice(0, 300).replace(/\[[^\]]*\]\([^)]+\)/g, '[attachment]').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    const author = (authorName ?? 'Someone').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    const taskUrl = `https://app.gojolo.io/projects/${projectId}/tasks/${taskId}`
    const now = new Date()
    const footerTs = now.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }) + ' at ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const priority = (taskData.priority ?? '—').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    const status = (taskData.status ?? '—').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

    const payload = {
      channel: channelRow.channel_id,
      text: `New comment on task: ${taskData.title || 'Task'}`,
      unfurl_links: false,
      attachments: [
        {
          color: '#4A90D9',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*New comment on task:* <${taskUrl}|${taskTitle}>`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: preview || '(no text)',
              },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Commented By*\n${author}` },
                { type: 'mrkdwn', text: `*Priority*\n${priority}` },
                { type: 'mrkdwn', text: `*Time*\n${footerTs}` },
                { type: 'mrkdwn', text: `*Status*\n${status}` },
              ],
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `JoloCRM Task Comment ${footerTs}` },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.bot_token}` },
      body: JSON.stringify(payload),
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
