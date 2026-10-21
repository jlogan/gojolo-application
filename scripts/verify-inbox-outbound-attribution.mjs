import assert from 'node:assert/strict'
import { getOutboundSenderUserId } from '../src/lib/inboxMessageAttribution.ts'

const attributed = {
  direction: 'outbound',
  is_draft: false,
  meta: { sent_by_user_id: 'user-123', sent_via: 'gojolo' },
}
assert.equal(getOutboundSenderUserId(attributed), 'user-123')
assert.equal(getOutboundSenderUserId({ ...attributed, meta: { sent_by_user_id: '  user-123  ' } }), 'user-123')
assert.equal(getOutboundSenderUserId({ ...attributed, direction: 'inbound' }), null)
assert.equal(getOutboundSenderUserId({ ...attributed, is_draft: true }), null)
assert.equal(getOutboundSenderUserId({ ...attributed, meta: null }), null)
assert.equal(getOutboundSenderUserId({ ...attributed, meta: { sent_by_user_id: '' } }), null)
assert.equal(getOutboundSenderUserId({ ...attributed, meta: { sent_by_user_id: 123 } }), null)

console.log('All outbound attribution checks passed.')
