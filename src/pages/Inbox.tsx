import { useEffect, useState, useCallback } from 'react'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  Inbox as InboxIcon,
  User,
  Mail,
  MessageSquare,
  Check,
  Archive,
  List,
  ChevronRight,
} from 'lucide-react'

type InboxFilter = 'inbox' | 'assigned' | 'trash' | 'all'

type ThreadAssignment = {
  user_id: string
}

type InboxThread = {
  id: string
  org_id: string
  channel: string
  status: string
  subject: string | null
  last_message_at: string
  created_at: string
  inbox_thread_assignments?: ThreadAssignment[] | null
}

type InboxMessage = {
  id: string
  thread_id: string
  channel: string
  direction: string
  from_identifier: string
  to_identifier: string | null
  body: string | null
  received_at: string
}

type OrgMemberOption = {
  user_id: string
  display_name: string | null
}

const FILTERS: { id: InboxFilter; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'assigned', label: 'Assigned To Me', icon: User },
  { id: 'trash', label: 'Trash', icon: Archive },
  { id: 'all', label: 'All Threads', icon: List },
]

export default function Inbox() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [filter, setFilter] = useState<InboxFilter>('inbox')
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [members, setMembers] = useState<OrgMemberOption[]>([])
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [showReplyComposer, setShowReplyComposer] = useState(false)

  const userId = user?.id ?? null

  const looksLikeHtml = (text: string | null) =>
    text != null && /<\s*(html|div|p|table|body|span)[\s>]/i.test(text)

  /** Decode quoted-printable (RFC 2045) so MIME parts render correctly. */
  const decodeQuotedPrintable = (s: string): string => {
    return s
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }

  /** Extract clean HTML or plain text from body; strip MIME boundaries and headers so it renders like an email. */
  const cleanMessageBody = (body: string | null): { html: boolean; content: string } => {
    if (!body || !body.trim()) return { html: false, content: '—' }
    const raw = body.trim()
    const boundaryMatch = raw.match(/boundary="?([^"\s;]+)"?/i)
    const boundary = boundaryMatch?.[1]
    const decodePart = (part: string, content: string): string => {
      const isQp = /Content-Transfer-Encoding:\s*quoted-printable/i.test(part)
      return isQp ? decodeQuotedPrintable(content) : content
    }
    if (boundary) {
      const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`, 'g'))
      let htmlPart = ''
      let textPart = ''
      for (const part of parts) {
        if (!part.trim()) continue
        const ct = part.match(/Content-Type:\s*text\/html[^\n]*/i)
        const ctPlain = part.match(/Content-Type:\s*text\/plain[^\n]*/i)
        const headerEnd = part.indexOf('\n\n') >= 0 ? part.indexOf('\n\n') + 2 : part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') + 4 : 0
        const content = decodePart(part, part.slice(headerEnd).replace(/\r\n/g, '\n').trim())
        if (ct && content) htmlPart = content
        else if (ctPlain && content && !htmlPart) textPart = content
      }
      if (htmlPart) return { html: true, content: htmlPart }
      if (textPart) return { html: false, content: textPart }
    }
    if (raw.includes('Content-Type:') && (raw.includes('text/html') || raw.includes('text/plain'))) {
      const htmlIdx = raw.toLowerCase().indexOf('content-type: text/html')
      const plainIdx = raw.toLowerCase().indexOf('content-type: text/plain')
      let start = 0
      if (htmlIdx >= 0) {
        start = raw.indexOf('\n\n', htmlIdx) >= 0 ? raw.indexOf('\n\n', htmlIdx) + 2 : raw.indexOf('\r\n\r\n', htmlIdx) + 4
        const end = raw.indexOf('------', start) >= 0 ? raw.indexOf('------', start) : raw.length
        const content = decodeQuotedPrintable(raw.slice(start, end).replace(/\r\n/g, '\n').trim())
        if (content && /<[a-z]/.test(content)) return { html: true, content }
      }
      if (plainIdx >= 0) {
        start = raw.indexOf('\n\n', plainIdx) >= 0 ? raw.indexOf('\n\n', plainIdx) + 2 : raw.indexOf('\r\n\r\n', plainIdx) + 4
        const end = raw.indexOf('------', start) >= 0 ? raw.indexOf('------', start) : raw.length
        const content = decodeQuotedPrintable(raw.slice(start, end).replace(/\r\n/g, '\n').trim())
        if (content) return { html: false, content }
      }
    }
    if (looksLikeHtml(raw)) return { html: true, content: raw }
    return { html: false, content: raw }
  }

  const fetchThreads = useCallback(async () => {
    if (!currentOrg?.id || !userId) return
    setLoading(true)
    setMessage(null)
    try {
      if (filter === 'assigned') {
        const { data: assignments, error } = await supabase
          .from('inbox_thread_assignments')
          .select('thread_id, inbox_threads(id, org_id, channel, status, subject, last_message_at, created_at, inbox_thread_assignments(user_id))')
          .eq('user_id', userId)
        if (error) throw error
        const threadList = (assignments ?? [])
          .map((a: { thread_id: string; inbox_threads: InboxThread | null }) => a.inbox_threads)
          .filter(Boolean) as InboxThread[]
        threadList.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
        setThreads(threadList)
      } else if (filter === 'trash') {
        const { data, error } = await supabase
          .from('inbox_threads')
          .select('id, org_id, channel, status, subject, last_message_at, created_at, inbox_thread_assignments(user_id)')
          .eq('org_id', currentOrg.id)
          .eq('status', 'archived')
          .order('last_message_at', { ascending: false })
        if (error) throw error
        setThreads((data as InboxThread[]) ?? [])
      } else if (filter === 'all') {
        const { data, error } = await supabase
          .from('inbox_threads')
          .select('id, org_id, channel, status, subject, last_message_at, created_at, inbox_thread_assignments(user_id)')
          .eq('org_id', currentOrg.id)
          .order('last_message_at', { ascending: false })
        if (error) throw error
        setThreads((data as InboxThread[]) ?? [])
      } else {
        const { data, error } = await supabase
          .from('inbox_threads')
          .select('id, org_id, channel, status, subject, last_message_at, created_at, inbox_thread_assignments(user_id)')
          .eq('org_id', currentOrg.id)
          .eq('status', 'open')
          .order('last_message_at', { ascending: false })
        if (error) throw error
        const list = (data as InboxThread[]) ?? []
        const filtered = list.filter((t) => {
          const assignments = Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments : []
          return assignments.length === 0 || assignments.some((a) => a.user_id === userId)
        })
        setThreads(filtered)
      }
    } catch (e) {
      console.error(e)
      const errMsg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? 'Failed to load threads'
      setMessage(errMsg)
      setThreads([])
    } finally {
      setLoading(false)
    }
  }, [currentOrg?.id, filter, userId])

  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])

  useEffect(() => {
    if (!currentOrg?.id) return
    supabase
      .from('organization_users')
      .select('user_id, profiles(display_name)')
      .eq('org_id', currentOrg.id)
      .then(({ data }) => {
        setMembers(
          (data ?? []).map((r: { user_id: string; profiles: { display_name: string | null } | null }) => ({
            user_id: r.user_id,
            display_name: r.profiles?.display_name ?? null,
          }))
        )
      })
  }, [currentOrg?.id])

  useEffect(() => {
    setReplyBody('')
    setShowReplyComposer(false)
    if (!selectedThreadId) {
      setMessages([])
      return
    }
    setMessagesLoading(true)
    supabase
      .from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, body, received_at')
      .eq('thread_id', selectedThreadId)
      .order('received_at', { ascending: true })
      .then(({ data, error }) => {
        setMessagesLoading(false)
        if (error) {
          setMessages([])
          return
        }
        setMessages((data as InboxMessage[]) ?? [])
      })
  }, [selectedThreadId])

  const selectedThread = threads.find((t) => t.id === selectedThreadId)

  const assigneeName = (t: InboxThread) => {
    if (filter === 'assigned') return 'Me'
    const a = Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments[0] : null
    if (!a) return 'Unassigned'
    const member = members.find((m) => m.user_id === a.user_id)
    return member?.display_name ?? a.user_id.slice(0, 8) + '…'
  }

  const currentAssigneeId = (selectedThread?.inbox_thread_assignments?.[0] as { user_id?: string } | undefined)?.user_id ?? ''
  const currentUserDisplayName = userId ? (members.find((m) => m.user_id === userId)?.display_name ?? 'Me') : 'Me'

  const handleAssignToMe = async () => {
    if (!selectedThreadId || !userId) return
    setActionLoading(true)
    setMessage(null)
    try {
      await supabase.from('inbox_thread_assignments').upsert(
        { thread_id: selectedThreadId, user_id: userId },
        { onConflict: 'thread_id' }
      )
      await fetchThreads()
      setMessage(null)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed to assign')
    } finally {
      setActionLoading(false)
    }
  }

  const handleAssignTo = async (assignUserId: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    setMessage(null)
    try {
      await supabase.from('inbox_thread_assignments').upsert(
        { thread_id: selectedThreadId, user_id: assignUserId },
        { onConflict: 'thread_id' }
      )
      await fetchThreads()
      setMessage(null)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed to assign')
    } finally {
      setActionLoading(false)
    }
  }

  const handleClose = async () => {
    if (!selectedThreadId) return
    setActionLoading(true)
    setMessage(null)
    try {
      await supabase.from('inbox_threads').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', selectedThreadId)
      await fetchThreads()
      setSelectedThreadId(null)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed to close')
    } finally {
      setActionLoading(false)
    }
  }

  const handleMoveToTrash = async () => {
    if (!selectedThreadId) return
    setActionLoading(true)
    setMessage(null)
    try {
      await supabase.from('inbox_threads').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', selectedThreadId)
      await fetchThreads()
      setSelectedThreadId(null)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed to move to trash')
    } finally {
      setActionLoading(false)
    }
  }

  const channelIcon = (channel: string) => (channel === 'email' ? <Mail className="w-4 h-4 shrink-0" /> : <MessageSquare className="w-4 h-4 shrink-0" />)

  const replyToAddress = selectedThread?.channel === 'email' && messages.length > 0
    ? (messages.find((m) => m.direction === 'inbound')?.from_identifier ?? messages[messages.length - 1]?.from_identifier)
    : ''

  const handleSendReply = async () => {
    if (!selectedThreadId || !replyBody.trim() || selectedThread?.channel !== 'email') return
    if (!replyToAddress?.includes('@')) {
      setMessage('Cannot determine recipient for reply.')
      return
    }
    setSendingReply(true)
    setMessage(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setMessage('Please sign in again.')
      setSendingReply(false)
      return
    }
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        threadId: selectedThreadId,
        body: replyBody.trim(),
        subject: selectedThread?.subject ?? undefined,
        to: replyToAddress,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean; closed?: boolean }
    setSendingReply(false)
    if (data?.error) {
      setMessage(data.error)
      return
    }
    setReplyBody('')
    setMessage(data?.closed ? 'Reply sent and thread closed.' : 'Reply sent.')
    const { data: newMessages } = await supabase
      .from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, body, received_at')
      .eq('thread_id', selectedThreadId)
      .order('received_at', { ascending: true })
    setMessages((newMessages as InboxMessage[]) ?? [])
    if (data?.closed) {
      await fetchThreads()
      setSelectedThreadId(null)
    }
  }

  if (!currentOrg) {
    return (
      <div className="p-4 md:p-6" data-testid="inbox-page">
        <p className="text-gray-400">Select a workspace.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="inbox-page">
      <div className="p-4 border-b border-border shrink-0">
        <h1 className="text-xl font-semibold text-white mb-4">Inbox</h1>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ${
                filter === f.id ? 'bg-accent text-accent-foreground' : 'bg-surface-muted text-gray-300 hover:bg-surface-muted/80'
              }`}
            >
              <f.icon className="w-4 h-4" />
              {f.label}
            </button>
          ))}
        </div>
        {message && <p className={`mt-2 text-sm ${message.startsWith('Failed') ? 'text-red-400' : 'text-accent'}`}>{message}</p>}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-full md:w-96 border-r border-border flex flex-col min-h-0 bg-surface-muted/30">
          {loading ? (
            <div className="p-4 text-gray-400 text-sm">Loading…</div>
          ) : threads.length === 0 ? (
            <div className="p-4 text-gray-400 text-sm">No threads.</div>
          ) : (
            <ul className="overflow-y-auto divide-y divide-border">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedThreadId(t.id)}
                    className={`w-full text-left px-4 py-3 flex flex-col gap-1 hover:bg-surface-muted/50 ${selectedThreadId === t.id ? 'bg-surface-muted' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">{channelIcon(t.channel)}</span>
                      <span className="text-gray-200 font-medium truncate flex-1">{t.subject || '(No subject)'}</span>
                      <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span>{assigneeName(t)}</span>
                      <span>·</span>
                      <span>{new Date(t.last_message_at).toLocaleDateString()}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {!selectedThread ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm p-4">Select a thread</div>
          ) : (
            <>
              <div className="border-b border-border px-4 py-3 flex flex-wrap items-center gap-2 shrink-0">
                <h2 className="text-white font-medium truncate flex-1">{selectedThread.subject || '(No subject)'}</h2>
                <div className="flex items-center gap-2">
                  <select
                    value={currentAssigneeId}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v) handleAssignTo(v)
                    }}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1 rounded border border-border bg-surface-muted pl-2 pr-6 py-1.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="">Assign to…</option>
                    {userId && (
                      <option value={userId}>
                        {currentUserDisplayName} (Me)
                      </option>
                    )}
                    {members
                      .filter((m) => m.user_id !== userId)
                      .map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.display_name || m.user_id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={actionLoading || selectedThread.status === 'closed'}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"
                    title="Close thread"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={handleMoveToTrash}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"
                    title="Move to trash"
                  >
                    <Archive className="w-3.5 h-3.5" />
                    Trash
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {messagesLoading ? (
                  <div className="text-gray-400 text-sm">Loading messages…</div>
                ) : (
                  messages.map((m) => {
                    const { html, content } = cleanMessageBody(m.body)
                    const safeHtml = content
                      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                      .replace(/on\w+="[^"]*"/gi, '')
                      .replace(/"/g, '&quot;')
                    return (
                      <article
                        key={m.id}
                        className="w-full rounded-lg border border-border bg-surface-muted/80 overflow-hidden"
                      >
                        <header className="px-4 py-2 border-b border-border bg-surface-muted/50 text-xs text-gray-400 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <span className="text-gray-300">
                            <span className="text-gray-500">From:</span> {m.from_identifier}
                          </span>
                          {m.to_identifier && (
                            <span>
                              <span className="text-gray-500">To:</span> {m.to_identifier}
                            </span>
                          )}
                          <span>{new Date(m.received_at).toLocaleString()}</span>
                        </header>
                        <div className="p-4 text-gray-200">
                          {html ? (
                            <iframe
                              title="Message body"
                              srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0;padding:0;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#e5e7eb;">${safeHtml}</body></html>`}
                              className="w-full min-h-[80px] border-0 rounded bg-transparent text-gray-200"
                              sandbox="allow-same-origin"
                              style={{ height: 'min(400px, 50vh)' }}
                            />
                          ) : (
                            <div className="text-sm whitespace-pre-wrap break-words">{content}</div>
                          )}
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
              <div className="border-t border-border p-4 shrink-0">
                {selectedThread?.channel === 'email' ? (
                  <div className="space-y-2">
                    {!showReplyComposer ? (
                      <button
                        type="button"
                        onClick={() => setShowReplyComposer(true)}
                        className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90"
                      >
                        Reply
                      </button>
                    ) : (
                      <>
                        <textarea
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          placeholder="Type your reply…"
                          rows={3}
                          className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 resize-y"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={handleSendReply}
                            disabled={sendingReply || !replyBody.trim()}
                            className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                          >
                            {sendingReply ? 'Sending…' : 'Send reply'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setShowReplyComposer(false); setReplyBody('') }}
                            className="px-4 py-2 rounded-lg border border-border bg-surface-muted text-gray-200 text-sm font-medium hover:bg-surface-muted/80"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500 text-xs">Reply is only supported for email threads.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
