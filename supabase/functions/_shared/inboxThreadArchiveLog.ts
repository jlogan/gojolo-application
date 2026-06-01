/** Persisted when a thread is moved to Trash (status archived) from IMAP sync or AI tools. Query: tag = thread_archived */

export const THREAD_ARCHIVE_DEBUG_TAG = 'thread_archived'

type ServiceClient = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => Promise<{ error: { message: string } | null }>
  }
}

export async function logThreadArchiveDebug(
  service: ServiceClient,
  row: { thread_id: string; org_id: string; payload: Record<string, unknown> },
  logContext: string,
): Promise<void> {
  const { error } = await service.from('inbox_debug_log').insert({
    user_id: null,
    org_id: row.org_id,
    thread_id: row.thread_id,
    tag: THREAD_ARCHIVE_DEBUG_TAG,
    payload: row.payload,
  })
  if (error) console.warn(logContext, 'inbox_debug_log thread_archived insert failed:', error.message)
}
