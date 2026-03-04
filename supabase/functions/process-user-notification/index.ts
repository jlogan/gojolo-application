// Process one notification from the queue: respect user preference (Slack / Email / Both), send via Slack DM and/or Resend.
// Secrets: RESEND_API_KEY, RESEND_FROM (optional), NOTIFICATION_INTERNAL_SECRET (must match app_config.notification_internal_secret)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
const resendFrom = Deno.env.get('RESEND_FROM') ?? 'jolo <onboarding@resend.dev>'
const internalSecret = Deno.env.get('NOTIFICATION_INTERNAL_SECRET') ?? ''

type Channel = 'slack' | 'email' | 'both'
type EventType = 'task_assigned' | 'thread_assigned' | 'mentioned_in_thread'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const secret = req.headers.get('x-internal-secret')
  if (!internalSecret || secret !== internalSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  let queueId: string
  try {
    const body = (await req.json().catch(() => ({}))) as { queue_id?: string }
    queueId = body.queue_id ?? ''
    if (!queueId) {
      return new Response(JSON.stringify({ error: 'queue_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const admin = createClient(supabaseUrl, serviceKey)

  const { data: row, error: rowErr } = await admin
    .from('notification_queue')
    .select('id, user_id, org_id, event_type, payload, sent_at')
    .eq('id', queueId)
    .single()

  if (rowErr || !row) {
    return new Response(JSON.stringify({ error: 'Queue item not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  const item = row as { id: string; user_id: string; org_id: string; event_type: EventType; payload: Record<string, unknown>; sent_at: string | null }
  if (item.sent_at) {
    return new Response(JSON.stringify({ ok: true, already_sent: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const { data: pref } = await admin
    .from('user_notification_preferences')
    .select('channel')
    .eq('user_id', item.user_id)
    .eq('org_id', item.org_id)
    .eq('notification_type', item.event_type)
    .maybeSingle()

  const channel: Channel = (pref as { channel?: Channel } | null)?.channel ?? 'both'

  const appUrl = 'https://app.gojolo.io'
  let subject = ''
  let htmlBody = ''
  let slackText = ''

  if (item.event_type === 'task_assigned') {
    const p = item.payload as { task_id?: string; project_id?: string; task_title?: string; assigner_name?: string }
    const taskUrl = `${appUrl}/projects/${p.project_id}/tasks/${p.task_id}`
    subject = `Task assigned: ${p.task_title ?? 'Task'}`
    slackText = `*Task assigned to you:* ${p.task_title ?? 'Task'}\nAssigned by ${p.assigner_name ?? 'Someone'}\n<${taskUrl}|Open task>`
    htmlBody = `<p><strong>${p.assigner_name ?? 'Someone'}</strong> assigned you to a task.</p><p><strong>Task:</strong> ${escapeHtml(p.task_title ?? 'Task')}</p><p><a href="${taskUrl}">Open task in jolo</a></p>`
  } else if (item.event_type === 'thread_assigned') {
    const p = item.payload as { thread_id?: string; subject?: string; assigner_name?: string }
    const threadUrl = `${appUrl}/inbox/${p.thread_id}`
    subject = `Thread assigned: ${p.subject ?? 'Inbox thread'}`
    slackText = `*Thread assigned to you:* ${p.subject ?? 'Inbox thread'}\nAssigned by ${p.assigner_name ?? 'Someone'}\n<${threadUrl}|Open thread>`
    htmlBody = `<p><strong>${p.assigner_name ?? 'Someone'}</strong> assigned you to an inbox thread.</p><p><strong>Subject:</strong> ${escapeHtml(p.subject ?? 'Inbox thread')}</p><p><a href="${threadUrl}">Open thread in jolo</a></p>`
  } else if (item.event_type === 'mentioned_in_thread') {
    const p = item.payload as { thread_id?: string; subject?: string; commenter_name?: string; content_preview?: string }
    const threadUrl = `${appUrl}/inbox/${p.thread_id}`
    subject = `${p.commenter_name ?? 'Someone'} mentioned you in: ${p.subject ?? 'Thread'}`
    slackText = `*${p.commenter_name ?? 'Someone'}* mentioned you in a thread: _${p.subject ?? 'Thread'}_\n${escapeSlack(p.content_preview ?? '')}\n<${threadUrl}|Open thread>`
    htmlBody = `<p><strong>${p.commenter_name ?? 'Someone'}</strong> mentioned you in an inbox thread.</p><p><strong>Subject:</strong> ${escapeHtml(p.subject ?? 'Thread')}</p><p>${escapeHtml(p.content_preview ?? '')}</p><p><a href="${threadUrl}">Open thread in jolo</a></p>`
  }

  const sendSlack = channel === 'slack' || channel === 'both'
  const sendEmail = channel === 'email' || channel === 'both'

  if (sendSlack) {
    const { data: slackMapping } = await admin.from('user_slack_mappings').select('slack_user_id').eq('user_id', item.user_id).eq('org_id', item.org_id).maybeSingle()
    const slackUserId = (slackMapping as { slack_user_id?: string } | null)?.slack_user_id
    if (slackUserId) {
      const { data: config } = await admin.from('slack_configs').select('bot_token').eq('org_id', item.org_id).eq('is_active', true).maybeSingle()
      const botToken = (config as { bot_token?: string } | null)?.bot_token
      if (botToken) {
        const openRes = await fetch('https://slack.com/api/conversations.open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${botToken}` },
          body: JSON.stringify({ users: slackUserId }),
        })
        const openData = await openRes.json() as { ok?: boolean; channel?: { id?: string } }
        if (openData.ok && openData.channel?.id) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${botToken}` },
            body: JSON.stringify({ channel: openData.channel.id, text: slackText, unfurl_links: false }),
          })
        }
      }
    }
  }

  if (sendEmail) {
    const { data: profile } = await admin.from('profiles').select('email').eq('id', item.user_id).maybeSingle()
    const to = (profile as { email?: string } | null)?.email
    if (to && resendApiKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
        body: JSON.stringify({
          from: resendFrom,
          to: [to],
          subject,
          html: htmlBody,
        }),
      })
    }
  }

  await admin.from('notification_queue').update({ sent_at: new Date().toISOString() }).eq('id', queueId)

  return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
