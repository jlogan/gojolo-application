import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const INTERNAL_AI_CHAT_KEY = Deno.env.get('INTERNAL_AI_CHAT_KEY') ?? ''

type SlackEventPayload = {
  type?: string
  challenge?: string
  api_app_id?: string
  team_id?: string
  event?: {
    type?: string
    subtype?: string
    bot_id?: string
    text?: string
    channel?: string
    ts?: string
    thread_ts?: string
    user?: string
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

async function verifySlackSignature(rawBody: string, timestamp: string, signature: string, signingSecret: string) {
  const now = Math.floor(Date.now() / 1000)
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 5) return false
  const base = `v0:${timestamp}:${rawBody}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base))
  const computed = `v0=${toHex(new Uint8Array(digest))}`
  return safeEqual(computed, signature)
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    if (!INTERNAL_AI_CHAT_KEY) return json({ error: 'INTERNAL_AI_CHAT_KEY not configured' }, 500)
    if (req.headers.get('x-slack-retry-num')) return json({ ok: true })

    const rawBody = await req.text()
    const payload = JSON.parse(rawBody) as SlackEventPayload

    const appId = payload.api_app_id?.trim()
    const teamId = payload.team_id?.trim()
    if (!appId && !teamId) return json({ error: 'Missing app/team identifier' }, 400)

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    let cfgQuery = admin
      .from('slack_configs')
      .select('org_id, bot_token, signing_secret, app_id, bot_user_id, is_active')
      .eq('is_active', true)
      .limit(1)
    cfgQuery = appId ? cfgQuery.eq('app_id', appId) : cfgQuery.eq('team_id', teamId!)
    const { data: cfg, error: cfgErr } = await cfgQuery.single()
    if (cfgErr || !cfg) return json({ error: 'Slack config not found for app/team' }, 404)
    if (!cfg.signing_secret) return json({ error: 'Signing secret not configured' }, 400)
    if (!cfg.bot_token) return json({ error: 'Bot token not configured' }, 400)

    const slackSignature = req.headers.get('x-slack-signature') ?? ''
    const slackTimestamp = req.headers.get('x-slack-request-timestamp') ?? ''
    const isValid = await verifySlackSignature(rawBody, slackTimestamp, slackSignature, cfg.signing_secret)
    if (!isValid) return json({ error: 'Invalid Slack signature' }, 401)

    if (payload.type === 'url_verification') return json({ challenge: payload.challenge ?? '' })
    if (payload.type !== 'event_callback') return json({ ok: true })

    const ev = payload.event
    if (!ev) return json({ ok: true })
    if ((ev.type !== 'message' && ev.type !== 'app_mention') || ev.subtype || ev.bot_id) return json({ ok: true })
    if (!ev.channel || !ev.ts) return json({ ok: true })

    const threadTs = ev.thread_ts ?? ev.ts
    const cleanedText = (ev.text ?? '')
      .replace(/<@[^>]+>/g, '')
      .trim()
    if (!cleanedText) return json({ ok: true })

    const aiRes = await fetch(`${SUPABASE_URL}/functions/v1/ai-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-ai-key': INTERNAL_AI_CHAT_KEY,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        orgId: cfg.org_id,
        message: cleanedText,
      }),
    })

    const aiData = await aiRes.json().catch(() => ({})) as { message?: string; error?: string }
    const aiMessage = (aiData.message ?? '').trim()
    const reply = aiMessage || 'I could not generate a response right now. Please try again.'

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.bot_token}`,
      },
      body: JSON.stringify({
        channel: ev.channel,
        thread_ts: threadTs,
        text: reply,
        unfurl_links: false,
      }),
    })

    return json({ ok: true })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})

