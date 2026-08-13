/** Persisted plain-text marker when IMAP lazy-load cannot return message content. */
export const INBOX_BODY_UNAVAILABLE = '[Message no longer available on mail server]' as const

/** Persisted when MIME was fetched but contained no displayable text/html. */
export const INBOX_BODY_EMPTY_AFTER_FETCH = '[Message body could not be loaded from mail server]' as const

const UNAVAILABLE_MARKERS = new Set<string>([
  INBOX_BODY_UNAVAILABLE,
  INBOX_BODY_EMPTY_AFTER_FETCH,
])

export function isUnavailableBodyText(body: unknown): boolean {
  if (typeof body !== 'string') return false
  return UNAVAILABLE_MARKERS.has(body.trim())
}

export function unavailableBodyText(reason: 'missing' | 'empty' | 'error'): string {
  if (reason === 'empty') return INBOX_BODY_EMPTY_AFTER_FETCH
  return INBOX_BODY_UNAVAILABLE
}
