/** Must stay in sync with supabase/functions/_shared/inboxBodyUnavailable.ts */
export const INBOX_BODY_UNAVAILABLE = '[Message no longer available on mail server]' as const
export const INBOX_BODY_EMPTY_AFTER_FETCH = '[Message body could not be loaded from mail server]' as const

const UNAVAILABLE_MARKERS = new Set<string>([
  INBOX_BODY_UNAVAILABLE,
  INBOX_BODY_EMPTY_AFTER_FETCH,
])

export function isUnavailableBodyText(body: string | null | undefined): boolean {
  if (!body?.trim()) return false
  return UNAVAILABLE_MARKERS.has(body.trim())
}

export function isMessageBodyEmpty(body: string | null | undefined, htmlBody: string | null | undefined): boolean {
  if (isUnavailableBodyText(body)) return false
  const bodyEmpty = !body?.trim()
  const htmlEmpty = !htmlBody?.trim()
  return bodyEmpty && htmlEmpty
}

export type BodyFetchStatus = 'loading' | 'failed' | 'unavailable'
