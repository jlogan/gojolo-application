import assert from 'node:assert/strict'
import { decodeEscapedHtmlMarkup, looksLikeHtmlBody, normalizeInboxBody } from '../src/lib/inboxBodyDisplay.ts'

const raw = '<div>Hi Charles and Bill,</div><div><br></div>'
assert.equal(looksLikeHtmlBody(raw), true)
assert.deepEqual(normalizeInboxBody(raw), { content: raw, html: true })

const escaped = '&lt;div&gt;Hi Charles and Bill,&lt;/div&gt;'
const expectedDecoded = '<div>Hi Charles and Bill,</div>'
assert.equal(decodeEscapedHtmlMarkup(escaped), expectedDecoded)
assert.equal(normalizeInboxBody(escaped).html, true)
assert.equal(normalizeInboxBody(escaped).content, expectedDecoded)

const plain = 'Use < and > for comparison; this is not an HTML email.'
assert.equal(looksLikeHtmlBody(plain), false)
assert.deepEqual(normalizeInboxBody(plain), { content: plain, html: false })

console.log('Inbox body display checks passed (3 cases).')
