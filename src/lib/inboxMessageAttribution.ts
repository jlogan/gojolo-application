export type InboxMessageAttributionInput = {
  direction?: string | null
  is_draft?: boolean | null
  meta?: Record<string, unknown> | null
}

/** Return the GoJoLo user ID recorded for a sent outbound message, if available. */
export function getOutboundSenderUserId(message: InboxMessageAttributionInput): string | null {
  if (message.direction !== 'outbound' || message.is_draft) return null
  const userId = message.meta?.sent_by_user_id
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null
}
