import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const AVATAR_BUCKET = 'profile-avatars'

function extensionForContentType(contentType: string | null) {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('image/png')) return 'png'
  if (ct.includes('image/webp')) return 'webp'
  if (ct.includes('image/gif')) return 'gif'
  return 'jpg'
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const token = authHeader.replace('Bearer ', '').trim()
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data: { user }, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const meta = (user.user_metadata ?? {}) as { avatar_url?: string; picture?: string; full_name?: string; name?: string }
    const avatarSourceUrl = meta.avatar_url ?? meta.picture ?? null
    if (!avatarSourceUrl) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'No provider avatar URL' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const imageRes = await fetch(avatarSourceUrl)
    if (!imageRes.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch provider avatar (${imageRes.status})` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    const contentType = imageRes.headers.get('content-type')
    if (!contentType?.toLowerCase().startsWith('image/')) {
      return new Response(JSON.stringify({ error: 'Provider avatar response was not an image.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const imageBytes = new Uint8Array(await imageRes.arrayBuffer())
    const ext = extensionForContentType(contentType)
    const path = `${user.id}/avatar.${ext}`
    const { error: uploadErr } = await admin.storage.from(AVATAR_BUCKET).upload(path, imageBytes, {
      contentType,
      upsert: true,
      cacheControl: '3600',
    })
    if (uploadErr) {
      return new Response(JSON.stringify({ error: uploadErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: pub } = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path)
    const publicUrl = pub.publicUrl
    const displayName = meta.full_name ?? meta.name ?? user.email ?? null
    const { error: updateErr } = await admin
      .from('profiles')
      .update({
        avatar_url: publicUrl,
        google_avatar_url: avatarSourceUrl,
        display_name: displayName,
        email: user.email ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
    if (updateErr) {
      return new Response(JSON.stringify({ error: updateErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true, avatarUrl: publicUrl }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})

