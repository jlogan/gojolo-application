/** Gmail IMAP helpers for inbox thread deep links (mail.google.com #inbox/{threadId}). */

export function isGmailImapHost(host: string | null | undefined): boolean {
  return !!host && host.toLowerCase().includes('gmail.com')
}

export function buildGmailThreadUrl(gmailThreadId: string): string {
  const id = gmailThreadId.trim()
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`
}

type GmailThreadLinkThread = {
  imap_account_id?: string | null
  gmail_thread_id?: string | null
}

type GmailThreadLinkAccount = {
  id: string
  host: string
}

/** Returns a Gmail web URL when the thread belongs to a Gmail IMAP account and has a stored thread id. */
export function getGmailThreadUrlForThread(
  thread: GmailThreadLinkThread,
  imapAccounts: GmailThreadLinkAccount[],
): string | null {
  const gmailThreadId = thread.gmail_thread_id?.trim()
  if (!gmailThreadId) return null
  const account = imapAccounts.find((a) => a.id === thread.imap_account_id)
  if (!account || !isGmailImapHost(account.host)) return null
  return buildGmailThreadUrl(gmailThreadId)
}
