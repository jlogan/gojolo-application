/** When saving IMAP accounts, ENCRYPTION_KEY is required for creates and any new password. */
export function imapSaveRequiresEncryptionKey({ isUpdate, hasImapPassword, hasSmtpPassword }) {
  if (!isUpdate) return true
  return Boolean(hasImapPassword || hasSmtpPassword)
}
