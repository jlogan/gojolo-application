// Google Calendar read-only OAuth connect + sync for Team Calendar.
//
// Required Supabase secrets:
//   GOOGLE_CALENDAR_CLIENT_ID      — OAuth 2.0 Web client ID (Google Cloud Console)
//   GOOGLE_CALENDAR_CLIENT_SECRET  — OAuth client secret
//   ENCRYPTION_KEY                   — 32-byte hex (openssl rand -hex 32); encrypts stored tokens
//   SUPABASE_SERVICE_ROLE_KEY        — service role (auto-injected on hosted Supabase)
//
// Optional:
//   GOOGLE_CALENDAR_REDIRECT_URI   — OAuth redirect (must match Google Console exactly).
//                                    Default: {SUPABASE_URL}/functions/v1/calendar-sync?action=callback
//   CALENDAR_APP_URL               — App origin for post-OAuth redirect (default: http://localhost:5173
//                                    when SUPABASE_URL is local, else https://app.gojolo.io)
//
// Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client:
//   Authorized redirect URI (production):
//     https://YOUR_PROJECT_REF.supabase.co/functions/v1/calendar-sync?action=callback
//   Local dev:
//     http://127.0.0.1:54321/functions/v1/calendar-sync?action=callback
//
// Actions:
//   POST { action: 'start', orgId, provider: 'google', returnPath?: '/calendar' }
//   GET  ?action=callback&code=...&state=...   (Google redirect; no JWT)
//   POST { action: 'sync', orgId, provider?: 'google', connectionId?: string }
//   POST { action: 'disconnect', orgId, provider?: 'google', connectionId?: string }
// Cron (pg_cron via trigger_calendar_sync_for_connected):
//   POST { action: 'sync', orgId, connectionId, provider?: 'google' } with header x-cron-secret = CRON_SECRET
//
// Deploy: supabase functions deploy calendar-sync --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const cronSecret = Deno.env.get('CRON_SECRET')
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')
const googleClientId = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')
const googleClientSecret = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
// calendar.readonly for sync; openid/email/profile for userinfo (account id + email on callback)
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
  'profile',
].join(' ')

const SYNC_PAST_DAYS = 90
const SYNC_FUTURE_DAYS = 180
const CALENDAR_TIMEZONE = 'America/New_York'

type Provider = 'google'

type CalendarConnectionRow = {
  id: string
  org_id: string
  user_id: string
  provider: Provider
  provider_account_id: string | null
  email: string | null
  account_label: string | null
  status: string
  primary_calendar_id: string | null
}

type TokenRow = {
  connection_id: string
  access_token_encrypted: string | null
  refresh_token_encrypted: string | null
  token_expires_at: string | null
  scopes: string | null
  oauth_state: string | null
  oauth_state_expires_at: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const htmlRedirect = (url: string) =>
  new Response(null, { status: 302, headers: { Location: url } })

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

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function googleRedirectUri(): string {
  const configured = Deno.env.get('GOOGLE_CALENDAR_REDIRECT_URI')?.trim()
  if (configured) return configured
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/calendar-sync?action=callback`
}

function appBaseUrl(): string {
  const configured = Deno.env.get('CALENDAR_APP_URL')?.trim()
  if (configured) return configured.replace(/\/$/, '')
  if (supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost')) {
    return 'http://localhost:5173'
  }
  return 'https://app.gojolo.io'
}

function sanitizeReturnPath(path: string | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    return '/calendar'
  }
  return path.split('?')[0] || '/calendar'
}

function appRedirect(path: string, params: Record<string, string>): string {
  const url = new URL(path, appBaseUrl())
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

function requireEncryptionKey(): string {
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
    throw new Error('ENCRYPTION_KEY not configured (need 64 hex chars)')
  }
  return encryptionKeyHex.slice(0, 64)
}

function requireGoogleOAuth(): { clientId: string; clientSecret: string } {
  if (!googleClientId || !googleClientSecret) {
    throw new Error('Google Calendar OAuth is not configured (GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET)')
  }
  return { clientId: googleClientId, clientSecret: googleClientSecret }
}

async function hasCalendarConnect(userClient: ReturnType<typeof createClient>, orgId: string): Promise<boolean> {
  const [{ data: isAdmin }, { data: canConnect }] = await Promise.all([
    userClient.rpc('is_org_admin', { p_org_id: orgId }),
    userClient.rpc('user_has_permission', { p_org_id: orgId, p_permission: 'calendar.connect' }),
  ])
  return isAdmin === true || canConnect === true
}

async function hasCalendarManage(userClient: ReturnType<typeof createClient>, orgId: string): Promise<boolean> {
  const [{ data: isAdmin }, { data: canManage }] = await Promise.all([
    userClient.rpc('is_org_admin', { p_org_id: orgId }),
    userClient.rpc('user_has_permission', { p_org_id: orgId, p_permission: 'calendar.manage' }),
  ])
  return isAdmin === true || canManage === true
}

function getTimezoneOffsetMs(timeZone: string, date: Date): number {
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const toUtcMs = (parts: Intl.DateTimeFormatPart[]) => {
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
    return Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      Number(get('hour')),
      Number(get('minute')),
      Number(get('second')),
    )
  }
  return toUtcMs(tzParts) - toUtcMs(utcParts)
}

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
  timeZone = CALENDAR_TIMEZONE,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const offset = getTimezoneOffsetMs(timeZone, new Date(utcGuess))
  return new Date(utcGuess - offset)
}

function parseIsoDateParts(isoDate: string): { year: number; month: number; day: number } {
  const [year, month, day] = isoDate.split('-').map(Number)
  return { year, month, day }
}

function addCalendarDaysFromIso(isoDate: string, days: number): { year: number; month: number; day: number } {
  const parts = parseIsoDateParts(isoDate)
  const anchor = zonedTimeToUtc(parts.year, parts.month, parts.day, 12)
  anchor.setUTCDate(anchor.getUTCDate() + days)
  const shifted = new Intl.DateTimeFormat('en-US', {
    timeZone: CALENDAR_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(anchor)
  const get = (type: string) => Number(shifted.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

async function createPendingConnection(
  service: ReturnType<typeof createClient>,
  orgId: string,
  userId: string,
  provider: Provider,
): Promise<CalendarConnectionRow> {
  const { data, error } = await service
    .from('calendar_connections')
    .insert({
      org_id: orgId,
      user_id: userId,
      provider,
      status: 'pending',
      sync_error: null,
    })
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Failed to create calendar connection')
  return data as CalendarConnectionRow
}

async function handleStart(
  userClient: ReturnType<typeof createClient>,
  service: ReturnType<typeof createClient>,
  userId: string,
  orgId: string,
  provider: Provider,
  returnPath?: string,
) {
  if (provider !== 'google') return json({ error: 'Only Google Calendar is supported currently' }, 400)
  if (!(await hasCalendarConnect(userClient, orgId))) {
    return json({ error: 'Forbidden: calendar.connect required' }, 403)
  }

  const { clientId } = requireGoogleOAuth()
  requireEncryptionKey()

  const connection = await createPendingConnection(service, orgId, userId, provider)
  const nonce = randomNonce()
  const state = `${connection.id}.${nonce}`
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  const { error: tokenError } = await service.from('calendar_connection_tokens').upsert({
    connection_id: connection.id,
    oauth_state: nonce,
    oauth_state_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  })
  if (tokenError) return json({ error: tokenError.message }, 500)

  const redirectUri = googleRedirectUri()
  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', GOOGLE_OAUTH_SCOPES)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('state', state)

  return json({
    ok: true,
    authUrl: authUrl.toString(),
    connectionId: connection.id,
    returnPath: sanitizeReturnPath(returnPath),
  })
}

async function exchangeGoogleCode(code: string): Promise<{
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}> {
  const { clientId, clientSecret } = requireGoogleOAuth()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error_description ?? data.error ?? 'Token exchange failed')
  }
  return data
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  access_token: string
  expires_in: number
  scope?: string
}> {
  const { clientId, clientSecret } = requireGoogleOAuth()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error_description ?? data.error ?? 'Token refresh failed')
  }
  return data
}

async function fetchGoogleUserEmail(accessToken: string): Promise<{ id: string; email: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Failed to fetch Google profile')
  return { id: String(data.id ?? data.sub ?? ''), email: String(data.email ?? '') }
}

async function getValidAccessToken(
  service: ReturnType<typeof createClient>,
  connection: CalendarConnectionRow,
  tokens: TokenRow,
): Promise<string> {
  const keyHex = requireEncryptionKey()
  if (!tokens.access_token_encrypted) throw new Error('No access token stored')

  const expiresAt = tokens.token_expires_at ? new Date(tokens.token_expires_at).getTime() : 0
  const needsRefresh = Date.now() >= expiresAt - 60_000

  if (!needsRefresh) {
    return decrypt(tokens.access_token_encrypted, keyHex)
  }

  if (!tokens.refresh_token_encrypted) throw new Error('Access token expired and no refresh token')

  const refreshToken = await decrypt(tokens.refresh_token_encrypted, keyHex)
  const refreshed = await refreshGoogleAccessToken(refreshToken)
  const newAccessEncrypted = await encrypt(refreshed.access_token, keyHex)
  const tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()

  await service.from('calendar_connection_tokens').update({
    access_token_encrypted: newAccessEncrypted,
    token_expires_at: tokenExpiresAt,
    scopes: refreshed.scope ?? tokens.scopes ?? GOOGLE_OAUTH_SCOPES,
    updated_at: new Date().toISOString(),
  }).eq('connection_id', connection.id)

  return refreshed.access_token
}

type GoogleEvent = {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  visibility?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

function mapGoogleVisibility(visibility: string | undefined): 'default' | 'public' | 'private' | 'busy_only' {
  if (visibility === 'private' || visibility === 'confidential') return 'private'
  if (visibility === 'public') return 'public'
  return 'default'
}

function parseGoogleEventTimes(event: GoogleEvent): { starts_at: string; ends_at: string; all_day: boolean } | null {
  const startRaw = event.start?.dateTime ?? event.start?.date
  const endRaw = event.end?.dateTime ?? event.end?.date
  if (!startRaw || !endRaw) return null

  const allDay = Boolean(event.start?.date && !event.start?.dateTime)
  if (allDay) {
    const startParts = parseIsoDateParts(event.start!.date!)
    const starts_at = zonedTimeToUtc(startParts.year, startParts.month, startParts.day).toISOString()
    const lastDayParts = addCalendarDaysFromIso(event.end!.date!, -1)
    const ends_at = zonedTimeToUtc(
      lastDayParts.year,
      lastDayParts.month,
      lastDayParts.day,
      23,
      59,
      59,
      999,
    ).toISOString()
    return { starts_at, ends_at, all_day: true }
  }

  return {
    starts_at: new Date(startRaw).toISOString(),
    ends_at: new Date(endRaw).toISOString(),
    all_day: false,
  }
}

async function syncGoogleConnection(
  service: ReturnType<typeof createClient>,
  connection: CalendarConnectionRow,
  tokens: TokenRow,
): Promise<number> {
  const accessToken = await getValidAccessToken(service, connection, tokens)
  const calendarId = encodeURIComponent(connection.primary_calendar_id ?? 'primary')
  const timeMin = new Date(Date.now() - SYNC_PAST_DAYS * 86400000).toISOString()
  const timeMax = new Date(Date.now() + SYNC_FUTURE_DAYS * 86400000).toISOString()

  const seenExternalIds = new Set<string>()
  let synced = 0
  let pageToken: string | undefined

  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`)
    url.searchParams.set('timeMin', timeMin)
    url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    url.searchParams.set('showDeleted', 'true')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message ?? 'Google Calendar fetch failed')

    const items = (data.items ?? []) as GoogleEvent[]
    for (const event of items) {
      if (!event.id) continue
      seenExternalIds.add(event.id)

      const times = parseGoogleEventTimes(event)
      if (!times) continue

      const status = event.status === 'cancelled'
        ? 'cancelled'
        : event.status === 'tentative'
        ? 'tentative'
        : 'confirmed'

      const row = {
        org_id: connection.org_id,
        connection_id: connection.id,
        user_id: connection.user_id,
        external_id: event.id,
        title: event.summary?.trim() || null,
        description: event.description?.trim() || null,
        location: event.location?.trim() || null,
        starts_at: times.starts_at,
        ends_at: times.ends_at,
        all_day: times.all_day,
        visibility: mapGoogleVisibility(event.visibility),
        status,
        updated_at: new Date().toISOString(),
      }

      const { error } = await service
        .from('calendar_events')
        .upsert(row, { onConflict: 'connection_id,external_id' })
      if (error) throw new Error(error.message)
      synced++
    }

    pageToken = data.nextPageToken
  } while (pageToken)

  // Remove stale events in sync window that Google no longer returns
  const { data: existing, error: listError } = await service
    .from('calendar_events')
    .select('id, external_id')
    .eq('connection_id', connection.id)
    .gte('starts_at', timeMin)
    .lt('starts_at', timeMax)

  if (listError) throw new Error(listError.message)

  const staleIds = (existing ?? [])
    .filter((e: { external_id: string }) => !seenExternalIds.has(e.external_id))
    .map((e: { id: string }) => e.id)

  if (staleIds.length > 0) {
    await service.from('calendar_events').delete().in('id', staleIds)
  }

  await service.from('calendar_connections').update({
    status: 'connected',
    sync_error: null,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', connection.id)

  return synced
}

async function handleCallback(service: ReturnType<typeof createClient>, req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  if (oauthError) {
    return htmlRedirect(appRedirect('/calendar', { calendar: 'error', message: oauthError }))
  }
  if (!code || !state) {
    return htmlRedirect(appRedirect('/calendar', { calendar: 'error', message: 'missing_code_or_state' }))
  }

  const [connectionId, nonce] = state.split('.')
  if (!connectionId || !nonce) {
    return htmlRedirect(appRedirect('/calendar', { calendar: 'error', message: 'invalid_state' }))
  }

  try {
    requireEncryptionKey()
    requireGoogleOAuth()

    const { data: connection, error: connError } = await service
      .from('calendar_connections')
      .select('*')
      .eq('id', connectionId)
      .single()
    if (connError || !connection) throw new Error('Connection not found')

    const { data: tokens, error: tokenError } = await service
      .from('calendar_connection_tokens')
      .select('*')
      .eq('connection_id', connectionId)
      .single()
    if (tokenError || !tokens) throw new Error('OAuth state not found')

    const tokenRow = tokens as TokenRow
    if (!tokenRow.oauth_state || tokenRow.oauth_state !== nonce) {
      throw new Error('OAuth state mismatch')
    }
    if (tokenRow.oauth_state_expires_at && new Date(tokenRow.oauth_state_expires_at).getTime() < Date.now()) {
      throw new Error('OAuth state expired')
    }

    const tokenResponse = await exchangeGoogleCode(code)
    const keyHex = requireEncryptionKey()
    const accessEncrypted = await encrypt(tokenResponse.access_token, keyHex)
    const tokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()

    const profile = await fetchGoogleUserEmail(tokenResponse.access_token)
    const defaultAccountLabel = profile.email?.trim() || null

    let existingSameAccount: CalendarConnectionRow | null = null
    if (profile.id) {
      const { data } = await service
        .from('calendar_connections')
        .select('*')
        .eq('org_id', connection.org_id)
        .eq('user_id', connection.user_id)
        .eq('provider', connection.provider)
        .eq('provider_account_id', profile.id)
        .neq('id', connectionId)
        .maybeSingle()
      existingSameAccount = (data as CalendarConnectionRow | null) ?? null
    }

    let targetConnectionId = connectionId
    let targetConnection = connection as CalendarConnectionRow
    let existingTargetTokens: TokenRow | null = null

    if (existingSameAccount) {
      targetConnectionId = existingSameAccount.id
      targetConnection = existingSameAccount as CalendarConnectionRow
      const { data: targetTokens } = await service
        .from('calendar_connection_tokens')
        .select('*')
        .eq('connection_id', existingSameAccount.id)
        .maybeSingle()
      existingTargetTokens = (targetTokens as TokenRow | null) ?? null
      const { error: deleteError } = await service.from('calendar_connections').delete().eq('id', connectionId)
      if (deleteError) throw new Error(`Failed to merge duplicate connection: ${deleteError.message}`)
    }

    const refreshEncrypted = tokenResponse.refresh_token
      ? await encrypt(tokenResponse.refresh_token, keyHex)
      : existingTargetTokens?.refresh_token_encrypted ?? tokenRow.refresh_token_encrypted

    const { error: tokenUpsertError } = await service.from('calendar_connection_tokens').upsert({
      connection_id: targetConnectionId,
      access_token_encrypted: accessEncrypted,
      refresh_token_encrypted: refreshEncrypted,
      token_expires_at: tokenExpiresAt,
      scopes: tokenResponse.scope ?? existingTargetTokens?.scopes ?? GOOGLE_OAUTH_SCOPES,
      oauth_state: null,
      oauth_state_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    if (tokenUpsertError) throw new Error(`Failed to store tokens: ${tokenUpsertError.message}`)

    const existingAccountLabel = targetConnection.account_label?.trim()
    const accountLabel = existingAccountLabel || defaultAccountLabel

    const { error: connUpdateError } = await service.from('calendar_connections').update({
      status: 'connected',
      provider_account_id: profile.id || null,
      email: profile.email || null,
      account_label: accountLabel,
      sync_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', targetConnectionId)
    if (connUpdateError) throw new Error(`Failed to update connection: ${connUpdateError.message}`)

    const updatedTokens = {
      ...tokenRow,
      connection_id: targetConnectionId,
      access_token_encrypted: accessEncrypted,
      refresh_token_encrypted: refreshEncrypted,
      token_expires_at: tokenExpiresAt,
    }
    await syncGoogleConnection(service, targetConnection, updatedTokens)

    return htmlRedirect(appRedirect('/calendar', { calendar: 'connected', provider: 'google' }))
  } catch (err) {
    const message = encodeURIComponent((err as Error).message)
    if (connectionId) {
      await service.from('calendar_connections').update({
        status: 'error',
        sync_error: (err as Error).message,
        updated_at: new Date().toISOString(),
      }).eq('id', connectionId)
    }
    return htmlRedirect(appRedirect('/calendar', { calendar: 'error', message }))
  }
}

async function getConnectionWithTokens(
  service: ReturnType<typeof createClient>,
  connection: CalendarConnectionRow,
): Promise<{ connection: CalendarConnectionRow; tokens: TokenRow } | null> {
  const { data: tokens, error: tokenError } = await service
    .from('calendar_connection_tokens')
    .select('*')
    .eq('connection_id', connection.id)
    .maybeSingle()
  if (tokenError || !tokens) {
    return { connection, tokens: { connection_id: connection.id } as TokenRow }
  }
  return { connection, tokens: tokens as TokenRow }
}

async function getUserConnections(
  service: ReturnType<typeof createClient>,
  orgId: string,
  userId: string,
  provider: Provider,
  connectionId?: string,
): Promise<CalendarConnectionRow[]> {
  let query = service
    .from('calendar_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('provider', provider)
    .in('status', ['connected', 'error'])

  if (connectionId) query = query.eq('id', connectionId)

  const { data, error } = await query.order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as CalendarConnectionRow[]
}

async function disconnectConnection(
  service: ReturnType<typeof createClient>,
  pair: { connection: CalendarConnectionRow; tokens: TokenRow },
): Promise<void> {
  try {
    const keyHex = requireEncryptionKey()
    if (pair.tokens.access_token_encrypted) {
      const accessToken = await decrypt(pair.tokens.access_token_encrypted, keyHex)
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, { method: 'POST' })
    }
  } catch {
    // Best-effort revoke; continue disconnect locally
  }

  await service.from('calendar_events').delete().eq('connection_id', pair.connection.id)
  await service.from('calendar_connection_tokens').delete().eq('connection_id', pair.connection.id)
  await service.from('calendar_connections').update({
    status: 'disconnected',
    sync_error: null,
    last_synced_at: null,
    provider_account_id: null,
    email: null,
    account_label: null,
    updated_at: new Date().toISOString(),
  }).eq('id', pair.connection.id)
}

async function getOrgConnection(
  service: ReturnType<typeof createClient>,
  orgId: string,
  provider: Provider,
  connectionId: string,
): Promise<CalendarConnectionRow | null> {
  const { data, error } = await service
    .from('calendar_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('provider', provider)
    .eq('id', connectionId)
    .in('status', ['connected', 'error'])
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as CalendarConnectionRow | null) ?? null
}

async function syncConnections(
  service: ReturnType<typeof createClient>,
  connections: CalendarConnectionRow[],
) {
  let totalSynced = 0
  const errors: string[] = []

  for (const connection of connections) {
    const pair = await getConnectionWithTokens(service, connection)
    if (!pair?.tokens.access_token_encrypted) continue

    try {
      totalSynced += await syncGoogleConnection(service, pair.connection, pair.tokens)
    } catch (err) {
      errors.push((err as Error).message)
      await service.from('calendar_connections').update({
        status: 'error',
        sync_error: (err as Error).message,
        updated_at: new Date().toISOString(),
      }).eq('id', pair.connection.id)
    }
  }

  if (errors.length > 0 && totalSynced === 0) {
    return json({ ok: false, synced: 0, message: errors[0] })
  }

  return json({
    ok: true,
    synced: totalSynced,
    message: errors.length > 0
      ? `Synced ${totalSynced} events with ${errors.length} error(s)`
      : `Synced ${totalSynced} events`,
  })
}

async function handleSync(
  userClient: ReturnType<typeof createClient>,
  service: ReturnType<typeof createClient>,
  userId: string,
  orgId: string,
  provider: Provider = 'google',
  connectionId?: string,
) {
  const canConnect = await hasCalendarConnect(userClient, orgId)
  const canManage = await hasCalendarManage(userClient, orgId)

  let connections: CalendarConnectionRow[] = []

  if (connectionId && canManage) {
    const connection = await getOrgConnection(service, orgId, provider, connectionId)
    if (!connection) {
      return json({ ok: false, message: 'No connected calendar found', synced: 0 })
    }
    connections = [connection]
  } else if (canConnect) {
    connections = await getUserConnections(service, orgId, userId, provider, connectionId)
  } else {
    return json({ error: 'Forbidden: calendar.connect or calendar.manage required' }, 403)
  }

  if (connections.length === 0) {
    return json({ ok: false, message: 'No connected calendar found', synced: 0 })
  }

  return syncConnections(service, connections)
}

async function handleCronSync(
  service: ReturnType<typeof createClient>,
  orgId?: string,
  provider: Provider = 'google',
  connectionId?: string,
) {
  if (!orgId || !connectionId) {
    return json({ ok: false, message: 'orgId and connectionId required for cron sync', synced: 0 })
  }

  const connection = await getOrgConnection(service, orgId, provider, connectionId)
  if (!connection) {
    return json({ ok: false, message: 'No connected calendar found', synced: 0 })
  }

  return syncConnections(service, [connection])
}

async function handleDisconnect(
  userClient: ReturnType<typeof createClient>,
  service: ReturnType<typeof createClient>,
  userId: string,
  orgId: string,
  provider: Provider = 'google',
  connectionId?: string,
) {
  if (!(await hasCalendarConnect(userClient, orgId))) {
    return json({ error: 'Forbidden: calendar.connect required' }, 403)
  }

  const connections = await getUserConnections(service, orgId, userId, provider, connectionId)
  if (connections.length === 0) return json({ ok: true, message: 'Already disconnected' })

  for (const connection of connections) {
    const pair = await getConnectionWithTokens(service, connection)
    if (!pair) continue
    await disconnectConnection(service, pair)
  }

  return json({ ok: true, message: connectionId ? 'Calendar account disconnected' : 'Calendar disconnected' })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    })
  }

  if (!serviceKey) return json({ error: 'Server misconfiguration: missing service role key' }, 500)

  const service = createClient(supabaseUrl, serviceKey)
  const url = new URL(req.url)
  const queryAction = url.searchParams.get('action')

  if (req.method === 'GET' && queryAction === 'callback') {
    return handleCallback(service, req)
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const isCron = req.headers.get('x-cron-secret') === cronSecret && cronSecret
    const body = await req.json().catch(() => ({})) as {
      orgId?: string
      action?: string
      provider?: Provider
      returnPath?: string
      connectionId?: string
    }

    if (isCron) {
      const action = body.action ?? 'sync'
      if (action !== 'sync') return json({ error: 'Unknown cron action' }, 400)
      const provider: Provider = body.provider === 'google' ? 'google' : 'google'
      return await handleCronSync(service, body.orgId, provider, body.connectionId)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: authData, error: authError } = await userClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Unauthorized' }, 401)

    const orgId = body.orgId
    if (!orgId) return json({ error: 'orgId required' }, 400)

    const action = body.action ?? queryAction ?? 'status'
    const provider: Provider = body.provider === 'google' ? 'google' : 'google'

    if (action === 'start') {
      return await handleStart(userClient, service, authData.user.id, orgId, provider, body.returnPath)
    }
    if (action === 'sync') {
      return await handleSync(userClient, service, authData.user.id, orgId, provider, body.connectionId)
    }
    if (action === 'disconnect') {
      return await handleDisconnect(userClient, service, authData.user.id, orgId, provider, body.connectionId)
    }

    const googleConfigured = !!(googleClientId && googleClientSecret)
    const encryptionConfigured = !!(encryptionKeyHex && encryptionKeyHex.length >= 64)

    return json({
      ok: googleConfigured && encryptionConfigured,
      message: googleConfigured
        ? encryptionConfigured
          ? 'Google Calendar OAuth is configured'
          : 'Set ENCRYPTION_KEY to enable calendar connect'
        : 'Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET in Supabase secrets',
      providers: { google: googleConfigured },
      redirectUri: googleConfigured ? googleRedirectUri() : null,
    })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
