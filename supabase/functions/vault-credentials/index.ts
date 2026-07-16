import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

type Action = 'list' | 'save' | 'delete' | 'reveal'

type Body = {
  action: Action
  orgId: string
  credentialId?: string | null
  companyId?: string | null
  projectId?: string | null
  label?: string | null
  credentialType?: string | null
  username?: string | null
  password?: string | null
  url?: string | null
  notes?: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

function keyBytesFromHex(keyHex: string) {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  return keyBytes
}

async function encrypt(plain: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytesFromHex(keyHex), { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, new TextEncoder().encode(plain))
  const combined = new Uint8Array(iv.length + cipher.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(cipher), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function decrypt(cipherText: string, keyHex: string): Promise<string> {
  const combined = Uint8Array.from(atob(cipherText), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const cipher = combined.slice(12)
  const key = await crypto.subtle.importKey('raw', keyBytesFromHex(keyHex), { name: 'AES-GCM' }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, cipher)
  return new TextDecoder().decode(plain)
}

function authToken(authHeader: string | null) {
  return authHeader?.replace(/^Bearer\s+/i, '') ?? ''
}

function tokenIssuedAt(authHeader: string | null): number | null {
  try {
    const token = authToken(authHeader)
    const payload = token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(atob(normalized)) as { iat?: number }
    return typeof parsed.iat === 'number' ? parsed.iat : null
  } catch {
    return null
  }
}

async function hasPermission(client: ReturnType<typeof createClient>, orgId: string, permission: string) {
  const { data, error } = await client.rpc('user_has_permission', { p_org_id: orgId, p_permission: permission })
  return !error && data === true
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!serviceKey) return json({ error: 'Server misconfiguration: missing service role key' }, 500)

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  let body: Body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { action, orgId } = body
  if (!action || !orgId) return json({ error: 'Missing action or orgId' }, 400)

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } })
  const service = createClient(supabaseUrl, serviceKey)
  const { data: userData, error: userError } = await userClient.auth.getUser(authToken(auth))
  const user = userData?.user
  if (userError || !user) return json({ error: 'Unauthorized' }, 401)

  if (action === 'list') {
    if (!(await hasPermission(userClient, orgId, 'vault.view'))) return json({ error: 'Forbidden' }, 403)

    const companyIds = new Set<string>()
    const linkedProjectIds = new Set<string>()
    if (body.companyId) companyIds.add(body.companyId)
    if (body.projectId) {
      const { data: linkedCompanies, error: linkError } = await userClient
        .from('project_companies')
        .select('company_id')
        .eq('project_id', body.projectId)
      if (linkError) return json({ error: linkError.message }, 400)
      ;(linkedCompanies ?? []).forEach((row: { company_id: string }) => companyIds.add(row.company_id))
    }
    if (body.companyId && !body.projectId) {
      const { data: linkedProjects, error: linkError } = await userClient
        .from('project_companies')
        .select('project_id')
        .eq('company_id', body.companyId)
      if (linkError) return json({ error: linkError.message }, 400)
      ;(linkedProjects ?? []).forEach((row: { project_id: string }) => linkedProjectIds.add(row.project_id))
    }

    let query = service
      .from('vault_credentials')
      .select('id, org_id, company_id, project_id, label, credential_type, username, url, notes, created_at, updated_at')
      .eq('org_id', orgId)
      .order('label')

    if (body.projectId && companyIds.size > 0) {
      query = query.or(`project_id.eq.${body.projectId},company_id.in.(${Array.from(companyIds).join(',')})`)
    } else if (body.projectId) {
      query = query.eq('project_id', body.projectId)
    } else if (body.companyId && linkedProjectIds.size > 0) {
      query = query.or(`company_id.eq.${body.companyId},project_id.in.(${Array.from(linkedProjectIds).join(',')})`)
    } else if (companyIds.size > 0) {
      query = query.in('company_id', Array.from(companyIds))
    } else {
      return json({ credentials: [] })
    }

    const { data, error } = await query
    if (error) return json({ error: error.message }, 400)
    return json({ credentials: data ?? [] })
  }

  if (action === 'save') {
    const isUpdate = Boolean(body.credentialId)
    const permission = isUpdate ? 'vault.update' : 'vault.create'
    if (!(await hasPermission(userClient, orgId, permission))) return json({ error: 'Forbidden' }, 403)
    if (!body.label?.trim()) return json({ error: 'Label is required' }, 400)
    if (!body.companyId && !body.projectId) return json({ error: 'Choose a company or project for this credential' }, 400)
    if (!isUpdate && !body.password) return json({ error: 'Password is required when adding a credential' }, 400)
    if (body.password && (!encryptionKeyHex || encryptionKeyHex.length < 64)) {
      return json({ error: 'Server not configured for vault encryption' }, 500)
    }

    const row: Record<string, unknown> = {
      org_id: orgId,
      company_id: body.companyId || null,
      project_id: body.projectId || null,
      label: body.label.trim(),
      credential_type: body.credentialType?.trim() || 'login',
      username: body.username?.trim() || null,
      url: body.url?.trim() || null,
      notes: body.notes?.trim() || null,
      updated_at: new Date().toISOString(),
    }
    if (body.password) row.password_encrypted = await encrypt(body.password, encryptionKeyHex!.slice(0, 64))

    let error
    if (isUpdate) {
      ;({ error } = await service.from('vault_credentials').update(row).eq('id', body.credentialId).eq('org_id', orgId))
    } else {
      row.created_by = user.id
      ;({ error } = await service.from('vault_credentials').insert(row))
    }
    if (error) return json({ error: error.message }, 400)
    await service.from('vault_access_log').insert({ org_id: orgId, credential_id: body.credentialId ?? null, user_id: user.id, action: isUpdate ? 'update' : 'create' })
    return json({ ok: true })
  }

  if (action === 'delete') {
    if (!(await hasPermission(userClient, orgId, 'vault.delete'))) return json({ error: 'Forbidden' }, 403)
    if (!body.credentialId) return json({ error: 'Missing credentialId' }, 400)
    const { error } = await service.from('vault_credentials').delete().eq('id', body.credentialId).eq('org_id', orgId)
    if (error) return json({ error: error.message }, 400)
    await service.from('vault_access_log').insert({ org_id: orgId, credential_id: body.credentialId, user_id: user.id, action: 'delete' })
    return json({ ok: true })
  }

  if (action === 'reveal') {
    if (!(await hasPermission(userClient, orgId, 'vault.reveal'))) return json({ error: 'Forbidden' }, 403)
    if (!body.credentialId) return json({ error: 'Missing credentialId' }, 400)
    if (!encryptionKeyHex || encryptionKeyHex.length < 64) return json({ error: 'Server not configured for vault encryption' }, 500)
    const iat = tokenIssuedAt(auth)
    if (!iat || Math.floor(Date.now() / 1000) - iat > 5 * 60) {
      return json({ error: 'Please unlock again before revealing this password.' }, 401)
    }
    const { data, error } = await service
      .from('vault_credentials')
      .select('id, password_encrypted')
      .eq('id', body.credentialId)
      .eq('org_id', orgId)
      .single()
    if (error || !data) return json({ error: 'Credential not found' }, 404)
    const encrypted = (data as { password_encrypted: string | null }).password_encrypted
    if (!encrypted) return json({ password: '' })
    const password = await decrypt(encrypted, encryptionKeyHex.slice(0, 64))
    await service.from('vault_access_log').insert({ org_id: orgId, credential_id: body.credentialId, user_id: user.id, action: 'reveal' })
    return json({ password })
  }

  return json({ error: 'Unsupported action' }, 400)
})
