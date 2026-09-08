import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the real Edge handler with isolated provider/storage/database doubles.
const source = fs.readFileSync(new URL('../supabase/functions/sync-profile-avatar/index.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
let handler
const profile = { display_name: 'Admin Edited Name', email: 'workspace@example.test' }
const admin = {
  auth: { getUser: async () => ({ data: { user: { id: 'test-user', email: 'old@example.test', user_metadata: { full_name: 'Old Google Name', avatar_url: 'https://example.test/avatar.png' } } } }) },
  storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example.test/avatar.png' } }) }) },
  from: (table) => {
    assert.equal(table, 'profiles')
    return { update: (payload) => ({ eq: async (key, id) => {
      assert.equal(key, 'id')
      assert.equal(id, 'test-user')
      assert.ok(!('display_name' in payload))
      assert.ok(!('email' in payload))
      Object.assign(profile, payload)
      return { error: null }
    } }) }
  },
}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {
  Deno: { env: { get: () => '' }, serve: (fn) => { handler = fn } },
  createClient: () => admin, corsHeaders: {}, Response, Uint8Array,
  fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
})
for (let i = 0; i < 3; i++) {
  const response = await handler(new Request('https://example.test/sync', { method: 'POST', headers: { Authorization: 'Bearer test' } }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  assert.equal(profile.display_name, 'Admin Edited Name')
  assert.equal(profile.email, 'workspace@example.test')
}
assert.equal(profile.avatar_url, 'https://storage.example.test/avatar.png')
const unauthorized = await handler(new Request('https://example.test/sync', { method: 'POST' }))
assert.equal(unauthorized.status, 401)
const authSource = fs.readFileSync(new URL('../src/contexts/AuthContext.tsx', import.meta.url), 'utf8')
assert.match(authSource, /onConflict: 'id', ignoreDuplicates: true/)
console.log('PASS: repeated avatar sync preserves admin name/email, updates avatar, rejects missing auth; fallback is insert-only')
