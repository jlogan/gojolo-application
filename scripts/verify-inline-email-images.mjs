/**
 * Quick check for resolveInlineEmailImages (run: node --experimental-strip-types scripts/verify-inline-email-images.mjs)
 */
import { resolveInlineEmailImages } from '../src/lib/emailSanitizer.ts'

const signed = 'https://example.supabase.co/storage/v1/object/sign/inbox-attachments/org/thread/file.png?token=abc'
const attachments = [
  {
    file_name: 'screenshot.png',
    file_path: 'org/thread/123-0-screenshot.png',
    signedUrl: signed,
    content_type: 'image/png',
  },
  {
    file_name: 'inline-ii_abc123',
    file_path: 'org/thread/456-0-inline-ii_abc123',
    signedUrl: 'https://example.supabase.co/storage/v1/object/sign/inbox-attachments/org/thread/inline.png?token=def',
    content_type: 'image/png',
  },
]

const publicHtml =
  '<p>Hi</p><img alt="inline_image" src="https://proj.supabase.co/storage/v1/object/public/inbox-attachments/org/thread/123-0-screenshot.png">'
const cidHtml = '<img alt="inline_image" src="cid:ii_abc123">'
const cidAngleHtml = '<img alt="inline_image" src="cid:<ii_abc123@mail.gmail.com>">'

function assert(name, html, atts, expectIncludes, expectExcludes = []) {
  const out = resolveInlineEmailImages(html, atts)
  for (const s of expectIncludes) {
    if (!out.includes(s)) {
      console.error(`FAIL ${name}: expected to include ${s}\n${out}`)
      process.exit(1)
    }
  }
  for (const s of expectExcludes) {
    if (out.includes(s)) {
      console.error(`FAIL ${name}: expected to exclude ${s}\n${out}`)
      process.exit(1)
    }
  }
  console.log(`ok ${name}`)
}

assert('public storage url → signed', publicHtml, attachments, [signed], ['object/public/inbox-attachments'])
assert('cid reference → signed', cidHtml, attachments, [attachments[1].signedUrl], ['cid:ii_abc123'])
assert('cid with angle brackets → signed (by inline- name)', cidAngleHtml, attachments, [attachments[1].signedUrl], ['cid:'])

console.log('All resolveInlineEmailImages checks passed.')
