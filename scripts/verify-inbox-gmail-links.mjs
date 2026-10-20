/**
 * Regression checks for Gmail deep-link URL builders (stored IMAP ids + RFC822 fallback).
 *
 * Run: node --experimental-strip-types scripts/verify-inbox-gmail-links.mjs
 */
import {
  buildGmailInboxMessageUrl,
  buildGmailInboxThreadUrl,
  buildGmailRfc822SearchUrl,
  getGmailMessageUrlForMessage,
  getGmailThreadUrlForThread,
  isRfc822MessageId,
  isSyntheticExternalId,
  normalizeGmailImapId,
  normalizeRfc822MessageId,
} from '../src/lib/inboxGmail.ts'

let passed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

const gmailAccount = { id: 'acct-gmail', host: 'imap.gmail.com' }
const otherAccount = { id: 'acct-other', host: 'imap.example.com' }

assert(isSyntheticExternalId('uid-123'), 'uid-* is synthetic')
assert(!isSyntheticExternalId('<msg@example.com>'), 'RFC822 is not synthetic')
assert(normalizeRfc822MessageId('<abc@mail.com>') === 'abc@mail.com', 'strip angle brackets')
assert(isRfc822MessageId('abc@mail.com'), 'valid RFC822')
assert(!isRfc822MessageId('uid-99'), 'uid is not RFC822')

assert(normalizeGmailImapId(' 1847293 ') === '1847293', 'trim gmail id')
assert(normalizeGmailImapId('abc') === null, 'reject non-decimal gmail id')

const searchUrl = buildGmailRfc822SearchUrl('<test@example.org>')
assert(searchUrl.includes('#search/'), 'RFC822 search uses hash search')
assert(decodeURIComponent(searchUrl.split('#search/')[1]).includes('rfc822msgid:test@example.org'), 'RFC822 query')

assert(
  buildGmailInboxThreadUrl('999001') === 'https://mail.google.com/mail/u/0/#inbox/999001',
  'thread inbox url',
)
assert(
  buildGmailInboxMessageUrl('999001', '888002') === 'https://mail.google.com/mail/u/0/#inbox/999001/888002',
  'message inbox url',
)

assert(
  getGmailThreadUrlForThread(
    { imap_account_id: 'acct-gmail', gmail_thread_id: '111' },
    [gmailAccount],
    [],
  ) === 'https://mail.google.com/mail/u/0/#inbox/111',
  'thread url prefers stored gmail_thread_id',
)

const fallbackThreadUrl = getGmailThreadUrlForThread(
  { imap_account_id: 'acct-gmail', gmail_thread_id: null },
  [gmailAccount],
  [{ message_id_header: '<fallback@x.com>', received_at: '2026-01-01' }],
)
assert(
  fallbackThreadUrl !== null &&
    decodeURIComponent(fallbackThreadUrl.split('#search/')[1] ?? '').includes('rfc822msgid:fallback@x.com'),
  'thread url falls back to RFC822',
)

assert(
  getGmailThreadUrlForThread({ imap_account_id: 'acct-other' }, [otherAccount], []) === null,
  'non-gmail thread has no url',
)

assert(
  getGmailMessageUrlForMessage(
    { imap_account_id: 'acct-gmail', gmail_thread_id: '10', gmail_message_id: '20' },
    { imap_account_id: 'acct-gmail' },
    [gmailAccount],
  ) === 'https://mail.google.com/mail/u/0/#inbox/10/20',
  'message url from stored ids on message',
)

assert(
  getGmailMessageUrlForMessage(
    { imap_account_id: 'acct-gmail', gmail_message_id: '20' },
    { imap_account_id: 'acct-gmail', gmail_thread_id: '10' },
    [gmailAccount],
  ) === 'https://mail.google.com/mail/u/0/#inbox/10/20',
  'message url uses thread gmail_thread_id when message omits it',
)

assert(
  getGmailMessageUrlForMessage(
    { imap_account_id: 'acct-gmail', external_id: 'uid-1' },
    { imap_account_id: 'acct-gmail', gmail_thread_id: '10' },
    [gmailAccount],
  ) === null,
  'synthetic row without RFC822 stays linkless',
)

const fallbackMessageUrl = getGmailMessageUrlForMessage(
  { imap_account_id: 'acct-gmail', message_id_header: '<one@two.com>' },
  { imap_account_id: 'acct-gmail' },
  [gmailAccount],
)
assert(
  fallbackMessageUrl !== null &&
    decodeURIComponent(fallbackMessageUrl.split('#search/')[1] ?? '').includes('rfc822msgid:one@two.com'),
  'message RFC822 fallback when gmail ids missing',
)

console.log(`verify-inbox-gmail-links: ${passed} assertions passed`)
