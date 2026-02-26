// Test IMAP/SMTP connection and optionally save account (credentials encrypted server-side).
// Requires: ENCRYPTION_KEY (32-byte hex) in secrets for saving.
// Call with Authorization: Bearer <user jwt>. User must be org admin for the given org.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import nodemailer from 'npm:nodemailer'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

interface Body {
  orgId: string
  email: string
  host: string
  port: number
  imapEncryption?: 'none' | 'tls' | 'ssl'
  username: string
  password: string
  label?: string | null
  save?: boolean
  testSmtpOnly?: boolean
  smtpHost?: string | null
  smtpPort?: number
  smtpEncryption?: 'none' | 'tls' | 'ssl'
  smtpUsername?: string | null
  smtpPassword?: string | null
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

async function encrypt(plain: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plain)
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    encoded
  )
  const combined = new Uint8Array(iv.length + cipher.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(cipher), iv.length)
  return btoa(String.fromCharCode(...combined))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors() })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  const auth = req.headers.get('Authorization')
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  const {
    orgId,
    email,
    host,
    port,
    imapEncryption = 'ssl',
    username,
    password,
    label,
    save,
    testSmtpOnly,
    smtpHost,
    smtpPort,
    smtpEncryption = 'tls',
    smtpUsername,
    smtpPassword,
  } = body

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: auth } },
  })

  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_org_admin', {
    p_org_id: orgId,
  })
  if (!orgId || rpcError || !isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden: not an org admin' }), {
      status: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
    })
  }

  if (testSmtpOnly) {
    if (!smtpHost?.trim() || !smtpUsername?.trim() || !smtpPassword) {
      return new Response(
        JSON.stringify({ error: 'Missing SMTP host, username, or password' }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
    const secure = smtpEncryption === 'ssl'
    const smtpPortNum = Number(smtpPort) || (secure ? 465 : 587)
    const transporter = nodemailer.createTransport({
      host: smtpHost.trim(),
      port: smtpPortNum,
      secure,
      auth: { user: smtpUsername.trim(), pass: smtpPassword },
    })
    try {
      await transporter.verify()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(
        JSON.stringify({ error: 'SMTP connection failed: ' + message }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
    return new Response(
      JSON.stringify({ ok: true, message: 'SMTP connection successful' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  if (!email?.trim() || !host?.trim() || !username?.trim() || !password) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: orgId, email, host, username, password' }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  const secureImap = imapEncryption === 'ssl' || imapEncryption === 'tls'
  const imapPortNum = Number(port) || (imapEncryption === 'ssl' ? 993 : 143)
  const client = new ImapFlow({
    host: host.trim(),
    port: imapPortNum,
    secure: secureImap,
    auth: { user: username.trim(), pass: password },
  })

  try {
    await client.connect()
    await client.logout()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(
      JSON.stringify({ error: 'IMAP connection failed: ' + message }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  }

  if (save) {
    if (!encryptionKeyHex || encryptionKeyHex.length < 64) {
      return new Response(
        JSON.stringify({ error: 'Server not configured for saving (ENCRYPTION_KEY missing)' }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
    let credentialsEncrypted: string
    try {
      credentialsEncrypted = await encrypt(password, encryptionKeyHex.slice(0, 64))
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Encryption failed' }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }

    let smtpCredentialsEncrypted: string | null = null
    if (smtpHost?.trim() && smtpUsername?.trim() && smtpPassword) {
      try {
        smtpCredentialsEncrypted = await encrypt(smtpPassword, encryptionKeyHex.slice(0, 64))
      } catch {
        return new Response(
          JSON.stringify({ error: 'SMTP encryption failed' }),
          { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
        )
      }
    }

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!serviceKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration (missing service role key)' }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
    const service = createClient(supabaseUrl, serviceKey)
    const row: Record<string, unknown> = {
      org_id: orgId,
      email: email.trim(),
      label: label?.trim() || null,
      host: host.trim(),
      port: imapPortNum,
      use_tls: secureImap,
      imap_encryption: imapEncryption,
      imap_username: username.trim(),
      credentials_encrypted: credentialsEncrypted,
      is_active: true,
    }
    if (smtpHost?.trim()) {
      row.smtp_host = smtpHost.trim()
      row.smtp_port = Number(smtpPort) || (smtpEncryption === 'ssl' ? 465 : 587)
      row.smtp_use_tls = smtpEncryption === 'tls' || smtpEncryption === 'ssl'
      row.smtp_username = smtpUsername?.trim() || null
      if (smtpCredentialsEncrypted) row.smtp_credentials_encrypted = smtpCredentialsEncrypted
    }
    const { error: insertError } = await service.from('imap_accounts').insert(row)
    if (insertError) {
      return new Response(
        JSON.stringify({ error: insertError.message }),
        { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
      )
    }
  }

  return new Response(
    JSON.stringify(save ? { ok: true, message: 'Account added' } : { ok: true, message: 'IMAP connection successful' }),
    { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
})
