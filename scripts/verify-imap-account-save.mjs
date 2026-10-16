/**
 * Regression checks for IMAP account save encryption gating (metadata-only updates without ENCRYPTION_KEY).
 *
 * Run: node scripts/verify-imap-account-save.mjs
 */
import { imapSaveRequiresEncryptionKey } from '../supabase/functions/_shared/imapAccountSave.mjs'

let passed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

assert(
  imapSaveRequiresEncryptionKey({ isUpdate: false, hasImapPassword: false, hasSmtpPassword: false }) === true,
  'create always requires encryption key',
)
assert(
  imapSaveRequiresEncryptionKey({ isUpdate: true, hasImapPassword: false, hasSmtpPassword: false }) === false,
  'metadata-only update does not require encryption key',
)
assert(
  imapSaveRequiresEncryptionKey({ isUpdate: true, hasImapPassword: true, hasSmtpPassword: false }) === true,
  'update with new IMAP password requires encryption key',
)
assert(
  imapSaveRequiresEncryptionKey({ isUpdate: true, hasImapPassword: false, hasSmtpPassword: true }) === true,
  'update with new SMTP password requires encryption key',
)

console.log(`verify-imap-account-save: ${passed} assertions passed`)
