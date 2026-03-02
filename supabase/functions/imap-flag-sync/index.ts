import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ImapFlow } from 'npm:imapflow'
import { corsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const encryptionKeyHex = Deno.env.get('ENCRYPTION_KEY')

async function decrypt(ct: string, keyHex: string): Promise<string> {
  const kb = new Uint8Array(32)
  for (let i = 0; i < 32; i++) kb[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', kb, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = Uint8Array.from(atob(ct), c => c.charCodeAt(0))
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 }, key, combined.slice(12)))
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const auth = req.headers.get('Authorization')
  if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const body = await req.json().catch(() => ({})) as { threadId: string; action: 'archive' | 'trash' | 'unarchive' }
  if (!body.threadId || !body.action) return new Response(JSON.stringify({ error: 'threadId and action required' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const service = createClient(supabaseUrl, serviceKey)
  if (!encryptionKeyHex || encryptionKeyHex.length < 64) return new Response(JSON.stringify({ error: 'ENCRYPTION_KEY not configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const { data: msgs } = await service.from('inbox_messages').select('external_uid, imap_account_id').eq('thread_id', body.threadId).not('external_uid', 'is', null).not('imap_account_id', 'is', null)
  if (!msgs?.length) return new Response(JSON.stringify({ ok: true, message: 'No IMAP messages to sync' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const accountId = msgs[0].imap_account_id
  const { data: acc } = await service.from('imap_accounts').select('id, host, port, imap_encryption, imap_username, credentials_encrypted').eq('id', accountId).single()
  if (!acc) return new Response(JSON.stringify({ error: 'Account not found' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  let password: string
  try { password = await decrypt(acc.credentials_encrypted as string, encryptionKeyHex.slice(0, 64)) }
  catch { return new Response(JSON.stringify({ error: 'Decrypt failed' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

  const secure = acc.imap_encryption === 'ssl' || acc.imap_encryption === 'tls'
  const client = new ImapFlow({ host: acc.host as string, port: Number(acc.port) || 993, secure, auth: { user: acc.imap_username as string, pass: password } })

  try {
    await client.connect()
    const isGmail = (acc.host as string).toLowerCase().includes('gmail.com')
    const mailboxPath = isGmail ? '[Gmail]/All Mail' : 'INBOX'
    const trashPath = isGmail ? '[Gmail]/Trash' : 'Trash'
    const uids = msgs.map(m => m.external_uid as number)

    if (body.action === 'archive') {
      const lock = await client.getMailboxLock(mailboxPath)
      try {
        if (isGmail) {
          await client.messageFlagsRemove({ uid: uids.join(',') }, ['\\Inbox'], { uid: true }).catch(() => {})
        }
        await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true }).catch(() => {})
      } finally { await lock.release() }
    } else if (body.action === 'trash') {
      const lock = await client.getMailboxLock(mailboxPath)
      try {
        await client.messageMove({ uid: uids.join(',') }, trashPath, { uid: true }).catch(() => {})
      } finally { await lock.release() }
    } else if (body.action === 'unarchive') {
      const lock = await client.getMailboxLock(mailboxPath)
      try {
        if (isGmail) {
          await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Inbox'], { uid: true }).catch(() => {})
        }
      } finally { await lock.release() }
    }

    await client.logout().catch(() => client.close())
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    try { await client.logout() } catch { client.close() }
    return new Response(JSON.stringify({ error: (err as Error).message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
