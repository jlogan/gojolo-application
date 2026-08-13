import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: authData, error: authError } = await userClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json().catch(() => ({})) as { orgId?: string; action?: string }
    const orgId = body.orgId
    if (!orgId) return json({ error: 'orgId required' }, 400)

    const [{ data: isAdmin }, { data: canConnect }] = await Promise.all([
      userClient.rpc('is_org_admin', { p_org_id: orgId }),
      userClient.rpc('user_has_permission', { p_org_id: orgId, p_permission: 'calendar.connect' }),
    ])

    if (!isAdmin && !canConnect) {
      return json({ error: 'Forbidden: calendar.connect required' }, 403)
    }

    const googleConfigured = !!Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')
    const microsoftConfigured = !!Deno.env.get('MICROSOFT_CALENDAR_CLIENT_ID')

    if (body.action === 'sync') {
      if (!googleConfigured && !microsoftConfigured) {
        return json({
          ok: false,
          message: 'Calendar sync is not configured. Set GOOGLE_CALENDAR_CLIENT_ID and/or MICROSOFT_CALENDAR_CLIENT_ID in Supabase secrets, then implement OAuth token exchange.',
          synced: 0,
        })
      }

      return json({
        ok: false,
        message: 'Calendar sync stub: OAuth credentials detected but sync pipeline is not implemented yet.',
        synced: 0,
      })
    }

    return json({
      ok: false,
      message: 'Calendar OAuth connect is not implemented yet. Configure provider client IDs in Supabase secrets and wire the OAuth callback flow.',
      providers: {
        google: googleConfigured,
        microsoft: microsoftConfigured,
      },
    })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
