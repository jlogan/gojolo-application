import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  Inbox as InboxIcon, Mail, MessageSquare, Check, Archive,
  List, ChevronRight, ChevronDown, Plus, Reply, ReplyAll, Forward,
  RotateCcw, Send, RefreshCw, Paperclip, Download,
  Search, User, Link2,
} from 'lucide-react'
import RichTextEditor from '@/components/inbox/RichTextEditor'
import { sanitizeEmailHtml, buildEmailSrcDoc } from '@/lib/emailSanitizer'

type InboxFilter = 'inbox' | 'assigned' | 'closed' | 'trash' | 'all'
type ThreadAssignment = { user_id: string }
type InboxThread = {
  id: string; org_id: string; channel: string; status: string
  subject: string | null; last_message_at: string; created_at: string
  from_address: string | null; imap_account_id: string | null
  inbox_thread_assignments?: ThreadAssignment[] | null
  /** Populated when select includes inbox_messages(count) */
  inbox_messages?: { count: number }[] | null
}
type InboxMessage = {
  id: string; thread_id: string; channel: string; direction: string
  from_identifier: string; to_identifier: string | null; cc: string | null
  body: string | null; html_body: string | null; received_at: string
  imap_account_id?: string | null
  external_uid?: number | null
}
type InboxComment = {
  id: string; thread_id: string; user_id: string; content: string
  mentions: string[] | null; created_at: string; display_name?: string | null; avatar_url?: string | null
}
type Attachment = { id: string; message_id: string | null; thread_id: string; file_name: string; file_path: string; file_size: number | null; created_at: string; signedUrl?: string | null }
type TimelineItem = { kind: 'message'; data: InboxMessage; ts: string } | { kind: 'comment'; data: InboxComment; ts: string }
type InboxUser = { user_id: string; display_name: string | null; email: string | null; avatar_url?: string | null }
type ImapAccount = { id: string; email: string; label: string | null; addresses: string[] | null }
type ContactMatch = { contact_id: string; name: string; email: string | null }
type ReadStatus = { thread_id: string; last_read_at: string }

const FILTERS: { id: InboxFilter; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'assigned', label: 'Mine', icon: User },
  { id: 'closed', label: 'Closed', icon: Check },
  { id: 'trash', label: 'Trash', icon: Archive },
  { id: 'all', label: 'All', icon: List },
]

// Match @mention: @ plus one word, then optionally more words that start with uppercase (name parts).
// Stops at trailing text like " hey" or " im testing" so only the name is gold, rest is white.
const MENTION_REGEX = /(@\S+(?:\s+[A-Z][A-Za-z0-9]*)*)/g

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** True when TipTap/HTML body has no visible text (allows attachment-only send). */
function isHtmlBodyEffectivelyEmpty(html: string): boolean {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u200b/g, '')
    .trim()
  return text.length === 0
}

function sanitizeInboxStorageFileName(name: string): string {
  const base = name.replace(/[/\\]/g, '_').trim() || 'attachment'
  return base.length > 180 ? base.slice(0, 180) : base
}

/** Render comment content with @mentions in amber, non-mention text in white (for display in thread) */
function renderCommentContentWithMentions(content: string): React.ReactNode {
  if (!content) return null
  const parts = content.split(MENTION_REGEX)
  return parts.map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className="text-amber-400 font-medium">{part}</span>
    ) : (
      <span key={i} className="text-white">{part}</span>
    )
  )
}

/** Return HTML string with mention spans (for contenteditable; inline styles so they apply when set via innerHTML) */
function commentContentToHtml(content: string): string {
  if (!content) return ''
  return content.split(MENTION_REGEX).map(part =>
    part.startsWith('@')
      ? `<span style="color:#fbbf24;font-weight:500">${escapeHtml(part)}</span>`
      : `<span style="color:#fff">${escapeHtml(part)}</span>`
  ).join('')
}

// Resolve email to contact name
function resolveEmail(email: string, contacts: ContactMatch[]): { name: string | null; contactId: string | null } {
  const match = contacts.find(c => c.email?.toLowerCase() === email?.toLowerCase())
  return match ? { name: match.name, contactId: match.contact_id } : { name: null, contactId: null }
}

export default function Inbox() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const { threadId: urlThreadId } = useParams<{ threadId?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const inboxDebug = searchParams.get('debug') === '1'
  const debugEnabledRef = useRef(inboxDebug)
  debugEnabledRef.current = inboxDebug
  const debugLog = useCallback((tag: string, payload: Record<string, unknown>, threadId?: string | null) => {
    if (!debugEnabledRef.current) return
    console.log(`[Inbox:${tag}]`, payload)
    const uid = user?.id ?? null
    if (uid && currentOrg?.id) {
      supabase.from('inbox_debug_log').insert({
        user_id: uid,
        org_id: currentOrg.id,
        thread_id: threadId ?? null,
        tag,
        payload,
      }).then(({ error }) => { if (error) console.warn('[Inbox:debugLog] supabase insert failed', error) })
    }
  }, [user?.id, currentOrg?.id])
  const debugLogRef = useRef(debugLog)
  debugLogRef.current = debugLog
  const [filter, setFilter] = useState<InboxFilter>(() => (urlThreadId ? 'all' : 'inbox'))

  // Log all Inbox route entries (direct load, sidebar click, external link)
  useEffect(() => {
    console.log('[Inbox:nav] Inbox page mounted/entered', { urlThreadId, pathname: window.location.pathname })
  }, [])
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(urlThreadId ?? null)
  const [selectedThreadFallback, setSelectedThreadFallback] = useState<InboxThread | null>(null)

  // Keep selectedThreadId in sync with URL (direct load, back/forward, link navigation)
  useEffect(() => {
    console.log('[Inbox:nav] URL sync → selectedThreadId', { urlThreadId, from: 'useEffect(urlThreadId)' })
    setSelectedThreadId(urlThreadId ?? null)
  }, [urlThreadId])

  // Fallback: when thread is selected via URL but not in list (e.g. trashed, or paginated out), fetch it so we can display it
  useEffect(() => {
    if (!selectedThreadId || !currentOrg?.id) {
      setSelectedThreadFallback(null)
      return
    }
    const inList = threads.some(t => t.id === selectedThreadId)
    if (inList) {
      setSelectedThreadFallback(null)
      return
    }
    supabase.from('inbox_threads')
      .select('id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, inbox_thread_assignments(user_id), inbox_messages(count)')
      .eq('id', selectedThreadId).eq('org_id', currentOrg.id).single()
      .then(({ data }) => setSelectedThreadFallback((data as InboxThread) ?? null), () => setSelectedThreadFallback(null))
  }, [selectedThreadId, threads, currentOrg?.id])

  // When navigating to a thread via URL, switch filter only if the thread isn't already in the list
  // (avoids replacing threads and losing the selected one when clicking from Inbox/Mine/etc.)
  // "All" excludes trash, so we must pick the right filter (trash vs all) based on thread status
  const urlThreadFilterSwitchedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!urlThreadId || !currentOrg?.id) return
    if (urlThreadFilterSwitchedRef.current && urlThreadFilterSwitchedRef.current !== urlThreadId) {
      urlThreadFilterSwitchedRef.current = null
    }
    const alreadyInList = threads.some(t => t.id === urlThreadId)
    if (alreadyInList) {
      urlThreadFilterSwitchedRef.current = urlThreadId
      return
    }
    if (urlThreadFilterSwitchedRef.current === urlThreadId) return
    urlThreadFilterSwitchedRef.current = urlThreadId
    supabase.from('inbox_threads').select('status').eq('id', urlThreadId).eq('org_id', currentOrg.id).single()
      .then(({ data }) => {
        const status = (data as { status?: string } | null)?.status
        const targetFilter: InboxFilter = status === 'archived' ? 'trash' : 'all'
        console.log('[Inbox:nav] URL has threadId → switch filter', { urlThreadId, status, targetFilter })
        setFilter(targetFilter)
      }, () => setFilter('all'))
  }, [urlThreadId, threads, currentOrg?.id])

  // Update browser URL when thread selection changes
  useEffect(() => {
    const currentPath = window.location.pathname
    const targetPath = selectedThreadId ? `/inbox/${selectedThreadId}` : '/inbox'
    if (currentPath !== targetPath) {
      console.log('[Inbox:nav] navigate()', { from: currentPath, to: targetPath, selectedThreadId })
      navigate(targetPath, { replace: true })
    }
  }, [selectedThreadId, navigate])
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [comments, setComments] = useState<InboxComment[]>([])
  const [inboxUsers, setInboxUsers] = useState<InboxUser[]>([])
  const [imapAccounts, setImapAccounts] = useState<ImapAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Accordion: which messages are expanded (last one auto-expanded)
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set())

  // Pagination
  const [pageSize] = useState(50)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // Read tracking
  const [readStatuses, setReadStatuses] = useState<ReadStatus[]>([])

  // Reply
  const [replyMode, setReplyMode] = useState<'reply' | 'reply_all' | 'forward' | 'compose' | null>(null)
  const [replyAnchorMsgId, setReplyAnchorMsgId] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState('')
  const [replyCc, setReplyCc] = useState('')
  const [replyBcc, setReplyBcc] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [replyHtml, setReplyHtml] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [replyAttachments, setReplyAttachments] = useState<File[]>([])

  // Comment
  const [commentText, setCommentText] = useState('')
  const [showMentionPicker, setShowMentionPicker] = useState(false)
  const commentInputRef = useRef<HTMLDivElement>(null)
  const commentProgrammaticRef = useRef(false)

  // Contacts, attachments, all contacts for autocomplete
  const [threadContacts, setThreadContacts] = useState<ContactMatch[]>([])
  const [allContacts, setAllContacts] = useState<{ id: string; name: string; email: string | null }[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toSuggestions, setToSuggestions] = useState<{ name: string; email: string }[]>([])
  const [showToSuggestions, setShowToSuggestions] = useState(false)

  // Drag state
  const [isDragging, setIsDragging] = useState(false)
  const [imapReloadingId, setImapReloadingId] = useState<string | null>(null)

  // Assign popover (multi-select)
  const [showAssignPopover, setShowAssignPopover] = useState(false)
  const [selectedAssignUserIds, setSelectedAssignUserIds] = useState<Set<string>>(new Set())

  const userId = user?.id ?? null
  const timelineEndRef = useRef<HTMLDivElement>(null)
  const replyFileRef = useRef<HTMLInputElement>(null)
  const sendingReplyRef = useRef(false)
  const outboundEmptyWarnedKeyRef = useRef<string | null>(null)

  const looksLikeHtml = (t: string | null) => t != null && /<\s*(html|div|p|table|body|span)[\s>]/i.test(t)
  const decodeQP = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

  const cleanMessageBody = (msg: InboxMessage): { html: boolean; content: string } => {
    if (msg.html_body) return { html: true, content: msg.html_body }
    const body = msg.body
    if (!body?.trim()) {
      debugLog(
        'cleanMessageBody',
        {
          event: 'EMPTY_body_placeholder',
          messageId: msg.id,
          threadId: msg.thread_id,
          direction: msg.direction,
          external_uid: msg.external_uid,
          imap_account_id: msg.imap_account_id ?? null,
          hasHtmlBody: !!(msg.html_body?.trim()),
        },
        msg.thread_id,
      )
      return { html: false, content: 'Downloading message...' }
    }
    const raw = body.trim()
    const bm = raw.match(/boundary="?([^"\s;]+)"?/i)
    if (bm?.[1]) {
      const parts = raw.split(new RegExp(`--${bm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`, 'g'))
      let hp = '', tp = ''
      for (const p of parts) {
        if (!p.trim()) continue
        const he = p.indexOf('\n\n') >= 0 ? p.indexOf('\n\n') + 2 : p.indexOf('\r\n\r\n') >= 0 ? p.indexOf('\r\n\r\n') + 4 : 0
        const isQp = /Content-Transfer-Encoding:\s*quoted-printable/i.test(p)
        const c = isQp ? decodeQP(p.slice(he).replace(/\r\n/g, '\n').trim()) : p.slice(he).replace(/\r\n/g, '\n').trim()
        if (/Content-Type:\s*text\/html/i.test(p) && c) hp = c
        else if (/Content-Type:\s*text\/plain/i.test(p) && c && !hp) tp = c
      }
      if (hp) return { html: true, content: hp }
      if (tp) return { html: false, content: tp }
    }
    if (looksLikeHtml(raw)) return { html: true, content: raw }
    return { html: false, content: raw }
  }

  const timeline: TimelineItem[] = [
    ...messages.map(m => ({ kind: 'message' as const, data: m, ts: m.received_at })),
    ...comments.map(c => ({ kind: 'comment' as const, data: c, ts: c.created_at })),
  ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())

  const initialLoadDone = useRef(false)
  const fetchFilterRef = useRef<InboxFilter>(filter)

  // Data fetching — on re-fetch, merge new threads on top instead of clearing + "Loading"
  const fetchThreads = useCallback(async () => {
    fetchFilterRef.current = filter
    if (!currentOrg?.id || !userId) {
      debugLog('fetchThreads', { event: 'SKIP', orgId: currentOrg?.id, userId })
      return
    }
    if (!initialLoadDone.current) setLoading(true)
    try {
      debugLog('fetchThreads', { event: 'START', orgId: currentOrg.id, userId, filter, pageSize })
      let query = supabase.from('inbox_threads')
        .select('id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, inbox_thread_assignments(user_id), inbox_messages(count)')
        .eq('org_id', currentOrg.id).order('last_message_at', { ascending: false }).limit(pageSize)
      if (filter === 'inbox') {
        query = query.eq('status', 'open')
      } else if (filter === 'assigned') {
        const { data: assigned, error: assignErr } = await supabase.from('inbox_thread_assignments').select('thread_id').eq('user_id', userId)
        debugLog('fetchThreads', { event: 'assigned_query', userId, count: (assigned ?? []).length, tids: (assigned ?? []).map((a: { thread_id: string }) => a.thread_id), error: assignErr?.message })
        const tids = (assigned ?? []).map((a: { thread_id: string }) => a.thread_id)
        if (!tids.length) { setThreads([]); setLoading(false); initialLoadDone.current = true; return }
        query = query.in('id', tids)
      } else if (filter === 'closed') query = query.eq('status', 'closed')
      else if (filter === 'trash') query = query.eq('status', 'archived')
      else if (filter === 'all') query = query.neq('status', 'archived')
      const { data, error: threadsErr } = await query
      let result = (data as InboxThread[]) ?? []
      // Hide orphan threads (no inbox_messages rows) — they break fetch-thread-bodies and confuse the UI
      const beforeOrphans = result.length
      result = result.filter((t) => {
        const cnt = (t as InboxThread).inbox_messages?.[0]?.count ?? 0
        return cnt > 0
      })
      if (beforeOrphans !== result.length) {
        debugLog('fetchThreads', { event: 'orphan_threads_hidden', before: beforeOrphans, after: result.length })
      }
      debugLog('fetchThreads', { event: 'threads_raw', count: result.length, error: threadsErr?.message, threads: result.map(t => ({ id: t.id, subject: t.subject?.slice(0, 30), status: t.status, assigns: (t.inbox_thread_assignments ?? []).map((a: { user_id: string }) => a.user_id) })) })
      // For inbox filter: only show threads assigned to me or unassigned
      if (filter === 'inbox') {
        const before = result.length
        result = result.filter(t => {
          const assigns = Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments : []
          const show = assigns.length === 0 || assigns.some(a => a.user_id === userId)
          if (!show) debugLog('fetchThreads', { event: 'HIDDEN_inbox_filter', threadId: t.id, subject: t.subject, assigns, userId })
          return show
        })
        if (before !== result.length) debugLog('fetchThreads', { event: 'inbox_filter_applied', before, after: result.length })
      }
      // Ensure selected thread is always in list (may be missing when filter='all' returns top 50 and our thread is older)
      const sid = selectedThreadIdRef.current
      if (sid && !result.some(t => t.id === sid)) {
        const { data: single } = await supabase.from('inbox_threads')
          .select('id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, inbox_thread_assignments(user_id), inbox_messages(count)')
          .eq('id', sid).eq('org_id', currentOrg!.id).single()
        const thread = single as InboxThread | null
        if (thread && (filter !== 'all' || thread.status !== 'archived')) {
          result = [thread, ...result]
          debugLog('fetchThreads', { event: 'prepended_selected_thread', threadId: sid })
        }
      }
      debugLog('fetchThreads', { event: 'DONE', count: result.length, threadIds: result.map(t => t.id) })
      if (fetchFilterRef.current !== filter) {
        debugLog('fetchThreads', { event: 'SKIP_stale', fetchedFilter: fetchFilterRef.current, currentFilter: filter })
        return
      }
      setThreads(result)
      initialLoadDone.current = true
    } catch (e) {
      debugLog('fetchThreads', { event: 'ERROR', error: String(e) })
      if (fetchFilterRef.current === filter && !initialLoadDone.current) setThreads([])
    }
    setLoading(false)
  }, [currentOrg?.id, filter, userId, debugLog])

  const fetchAttachments = useCallback(async (tid: string) => {
    const { data } = await supabase.from('inbox_attachments').select('*').eq('thread_id', tid).order('created_at')
    const rows = (data as Attachment[]) ?? []
    const withSignedUrls = await Promise.all(
      rows.map(async (a) => {
        const { data: signed } = await supabase.storage.from('inbox-attachments').createSignedUrl(a.file_path, 3600)
        return { ...a, signedUrl: signed?.signedUrl ?? null }
      })
    )
    setAttachments(prev => {
      if (selectedThreadIdRef.current !== tid) return prev
      return withSignedUrls
    })
  }, [])

  const fetchMessages = useCallback(async (tid: string) => {
    debugLog('fetchMessages', { event: 'START', threadId: tid }, tid)
    setMessagesLoading(true)
    let msgs: InboxMessage[] = []
    const { data, error: queryError } = await supabase.from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, cc, body, html_body, received_at, imap_account_id, external_uid')
      .eq('thread_id', tid).order('received_at', { ascending: true })
    msgs = (data as InboxMessage[]) ?? []
    debugLog('fetchMessages', { event: 'messages_query', threadId: tid, count: msgs.length, error: queryError?.message, messages: msgs.map(m => ({ id: m.id, hasBody: !!(m.body?.trim()), hasHtmlBody: !!(m.html_body?.trim()), external_uid: m.external_uid, direction: m.direction })) }, tid)
    if (queryError) {
      console.error('[Inbox] inbox_messages query failed:', queryError.message, queryError)
    }

    // If thread has no messages, trigger IMAP backfill (orphan thread recovery). imap_account_id may be null — pick any active account for the org.
    if (msgs.length === 0) {
      debugLog('fetchMessages', { event: 'backfill_trigger', threadId: tid }, tid)
      const { data: threadRow } = await supabase.from('inbox_threads')
        .select('org_id, imap_account_id')
        .eq('id', tid)
        .single()
      const thread = threadRow as { org_id: string; imap_account_id: string | null } | null
      let accountId = thread?.imap_account_id ?? null
      if (thread?.org_id && !accountId) {
        const { data: accPick } = await supabase.from('imap_accounts')
          .select('id')
          .eq('org_id', thread.org_id)
          .eq('is_active', true)
          .order('email')
          .limit(1)
        accountId = accPick?.[0]?.id ?? null
      }
      if (thread?.org_id && accountId) {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          try {
            const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-sync`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
                apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({ orgId: thread.org_id, accountId, backfillForThread: tid }),
            })
            if (res.ok) {
              const { data: dataAfter } = await supabase.from('inbox_messages')
                .select('id, thread_id, channel, direction, from_identifier, to_identifier, cc, body, html_body, received_at, imap_account_id, external_uid')
                .eq('thread_id', tid).order('received_at', { ascending: true })
              msgs = (dataAfter as InboxMessage[]) ?? []
              debugLog('fetchMessages', { event: 'after_backfill', threadId: tid, count: msgs.length }, tid)
            }
          } catch {
            // ignore sync failure, keep msgs empty
          }
        }
      } else if (thread?.org_id && !accountId) {
        console.warn('[Inbox] Thread has no messages and no active IMAP account to backfill', { threadId: tid, orgId: thread.org_id })
      }
    }

    setMessages(msgs)
    setMessagesLoading(false)
    setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)

    // Mark as read
    if (userId) {
      await supabase.from('inbox_thread_reads').upsert({ thread_id: tid, user_id: userId, last_read_at: new Date().toISOString() }, { onConflict: 'thread_id,user_id' })
    }

    // Lazy-load bodies from IMAP only when at least one row has no body/html in DB (avoids edge round-trip when data is already complete)
    if (msgs.length > 0) {
      const emptyBeforeBodies = msgs.filter(m => !m.body?.trim() && !m.html_body?.trim())
      if (emptyBeforeBodies.length === 0) {
        debugLog('fetchMessages', { event: 'SKIP_fetch_thread_bodies', reason: 'all_bodies_in_db', messageCount: msgs.length }, tid)
      } else {
        debugLog('fetchMessages', { event: 'empty_bodies_before_fetch', messageIds: emptyBeforeBodies.map(m => m.id), count: emptyBeforeBodies.length }, tid)
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          try {
            const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-thread-bodies`
            const t0 = performance.now()
            console.log('[Inbox:fetch-thread-bodies] calling', { threadId: tid, messageCount: msgs.length, emptyCount: emptyBeforeBodies.length })
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
              body: JSON.stringify({ threadId: tid }),
            })
            const elapsed = Math.round(performance.now() - t0)
            const result = await res.json().catch(() => ({}))
            console.log('[Inbox:fetch-thread-bodies] response', { threadId: tid, elapsedMs: elapsed, status: res.status, ok: res.ok, messageCount: result.messages?.length ?? 0, hasMore: result.hasMore, error: result.error })
            debugLog('fetchMessages', { event: 'fetch_thread_bodies_response', elapsedMs: elapsed, status: res.status, ok: res.ok, messageCount: result.messages?.length ?? 0, hasMore: result.hasMore, error: result.error, bodies: (result.messages ?? []).map((m: { id: string; body?: string | null; htmlBody?: string | null }) => ({ id: m.id, hasBody: !!(m.body?.trim()), hasHtmlBody: !!(m.htmlBody?.trim()) })) }, tid)
            if (!res.ok) {
              console.warn('[Inbox] fetch-thread-bodies HTTP error', { threadId: tid, status: res.status, error: (result as { error?: string }).error })
              debugLog('fetchMessages', { event: 'fetch_thread_bodies_http_error', status: res.status, error: (result as { error?: string }).error }, tid)
            }
            if (result.messages?.length) {
              if (selectedThreadIdRef.current !== tid) return // user switched thread, don't update
              type BodyEntry = { body: string | null; html_body: string | null }
              const bodyMap = new Map<string, BodyEntry>(result.messages.map((r: { id: string; body: string | null; htmlBody: string | null }) => [r.id, { body: r.body, html_body: r.htmlBody }]))
              const stillEmptyAfter = msgs.filter((pm) => {
                const b = bodyMap.get(pm.id)
                const bodyVal = b ? (b.body ?? pm.body) : pm.body
                const htmlVal = b ? (b.html_body ?? pm.html_body) : pm.html_body
                return !(bodyVal && String(bodyVal).trim()) && !(htmlVal && String(htmlVal).trim())
              })
              if (stillEmptyAfter.length > 0 && !result.hasMore) {
                const details = stillEmptyAfter.map((m) => ({
                  id: m.id,
                  direction: m.direction,
                  external_uid: m.external_uid,
                  imap_account_id: m.imap_account_id,
                }))
                console.warn('[Inbox] After fetch-thread-bodies, some messages still have no body (see Edge Function logs / IMAP UID)', { threadId: tid, count: stillEmptyAfter.length, details })
                debugLog('fetchMessages', { event: 'bodies_still_empty_after_fetch', threadId: tid, count: stillEmptyAfter.length, details }, tid)
              }
              setMessages(prev => {
                const merged = prev.map(pm => {
                  const b = bodyMap.get(pm.id)
                  return b ? { ...pm, body: b.body ?? pm.body, html_body: b.html_body ?? pm.html_body } : pm
                })
                return merged.sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime())
              })
              fetchAttachments(tid)
              if (result.hasMore) {
                const retry = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY }, body: JSON.stringify({ threadId: tid }) })
                  .then(r => r.json().catch(() => ({})))
                  .then(r => {
                    if (selectedThreadIdRef.current !== tid) return // user switched thread, cancel retries
                    if (r.messages?.length) {
                      const m = new Map<string, BodyEntry>(r.messages.map((x: { id: string; body: string | null; htmlBody: string | null }) => [x.id, { body: x.body, html_body: x.htmlBody }]))
                      setMessages(prev2 => prev2.map(p => {
                        const entry = m.get(p.id)
                        return entry ? { ...p, body: entry.body ?? p.body, html_body: entry.html_body ?? p.html_body } : p
                      }).sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime()))
                      fetchAttachments(tid)
                      if (r.hasMore) setTimeout(retry, 800)
                    }
                  })
                  .catch(() => {})
                setTimeout(retry, 800)
              }
            }
          } catch (err) {
            console.error('[Inbox] Failed to fetch thread bodies:', err)
          }
        } else {
          console.log('[Inbox] Skipping fetch-thread-bodies: no session/access_token')
          debugLog('fetchMessages', { event: 'SKIP_fetch_thread_bodies', reason: 'no_session' }, tid)
        }
      }
    } else {
      console.log('[Inbox] Skipping fetch-thread-bodies: no messages', { threadId: tid })
      debugLog('fetchMessages', { event: 'SKIP_fetch_thread_bodies', reason: 'no_messages', threadId: tid }, tid)
    }
  }, [userId, fetchAttachments, debugLog])

  const fetchComments = useCallback(async (tid: string) => {
    const { data } = await supabase.from('inbox_comments').select('id, thread_id, user_id, content, mentions, created_at')
      .eq('thread_id', tid).order('created_at', { ascending: true })
    const rows = (data ?? []) as InboxComment[]
    if (rows.length > 0) {
      const uids = [...new Set(rows.map(c => c.user_id))]
      const { data: profiles } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', uids)
      const nm = new Map((profiles ?? []).map((p: { id: string; display_name: string | null; avatar_url: string | null }) => [p.id, p]))
      rows.forEach(c => { const p = nm.get(c.user_id); c.display_name = p?.display_name ?? null; c.avatar_url = p?.avatar_url ?? null })
    }
    setComments(rows)
  }, [])

  const fetchThreadContacts = useCallback(async (tid: string) => {
    const { data } = await supabase.from('inbox_thread_contacts').select('contact_id, contacts(name, email)').eq('thread_id', tid)
    setThreadContacts((data ?? []).map((r: { contact_id: string; contacts: { name: string; email: string | null } | { name: string; email: string | null }[] | null }) => {
      const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
      return { contact_id: r.contact_id, name: c?.name ?? '', email: c?.email ?? null }
    }))
  }, [])

  // Load inbox users, accounts, all contacts, read statuses
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.rpc('org_users_with_permission', { p_org_id: currentOrg.id, p_permission: 'inbox.view' })
      .then(async ({ data, error }) => {
        const users = (data ?? []) as InboxUser[]
        debugLog('org_users_with_permission', { permission: 'inbox.view', orgId: currentOrg.id, count: users.length, userIds: users.map(u => u.user_id), error: error?.message })
        if (users.length > 0) {
          const { data: profiles } = await supabase.from('profiles').select('id, avatar_url').in('id', users.map(u => u.user_id))
          const avatarMap = new Map((profiles ?? []).map((p: { id: string; avatar_url: string | null }) => [p.id, p.avatar_url]))
          users.forEach(u => { u.avatar_url = avatarMap.get(u.user_id) ?? null })
        }
        setInboxUsers(users)
      })
    supabase.from('imap_accounts').select('id, email, label, addresses').eq('org_id', currentOrg.id).eq('is_active', true)
      .then(({ data }) => {
        const accs = (data as ImapAccount[]) ?? []
        setImapAccounts(accs)
        if (accs.length > 0 && !selectedAccountId) setSelectedAccountId(accs[0].id)
      })
    supabase.from('contacts').select('id, name, email').eq('org_id', currentOrg.id).order('name')
      .then(({ data }) => setAllContacts((data as { id: string; name: string; email: string | null }[]) ?? []))
  }, [currentOrg?.id])

  useEffect(() => {
    if (!userId) return
    supabase.from('inbox_thread_reads').select('thread_id, last_read_at').eq('user_id', userId)
      .then(({ data }) => setReadStatuses((data as ReadStatus[]) ?? []))
  }, [userId])

  useEffect(() => { fetchThreads() }, [fetchThreads])

  // Close assign popover when thread changes
  useEffect(() => setShowAssignPopover(false), [selectedThreadId])

  // Refs for stable realtime callbacks (avoids channel teardown on every state change)
  const selectedThreadIdRef = useRef(selectedThreadId)
  const fetchThreadsRef = useRef(fetchThreads)
  const fetchMessagesRef = useRef(fetchMessages)
  const fetchCommentsRef = useRef(fetchComments)
  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])
  useEffect(() => { fetchThreadsRef.current = fetchThreads }, [fetchThreads])
  useEffect(() => { fetchMessagesRef.current = fetchMessages }, [fetchMessages])
  useEffect(() => { fetchCommentsRef.current = fetchComments }, [fetchComments])

  // When comment text is set programmatically (mention insert or clear), update contenteditable with styled mentions
  useEffect(() => {
    if (!commentProgrammaticRef.current || !commentInputRef.current) return
    commentProgrammaticRef.current = false
    const el = commentInputRef.current
    el.innerHTML = commentContentToHtml(commentText)
    if (commentText === '') el.focus()
    else {
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [commentText])

  // Realtime — only depends on org_id so channel stays stable
  const [realtimeConnected, setRealtimeConnected] = useState(false)

  useEffect(() => {
    if (!currentOrg?.id) return

    const channelName = `inbox-rt-${currentOrg.id}-${Date.now()}`

    const ch = supabase.channel(channelName)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'inbox_threads',
        filter: `org_id=eq.${currentOrg.id}`,
      }, (payload) => {
        debugLogRef.current('realtime', { event: 'inbox_threads', payload })
        fetchThreadsRef.current()
        const changedId = (payload.new as { id?: string })?.id
        if (changedId && changedId === selectedThreadIdRef.current) {
          fetchMessagesRef.current(selectedThreadIdRef.current)
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'inbox_messages',
      }, (payload) => {
        const tid = (payload.new as { thread_id: string }).thread_id
        debugLogRef.current('realtime', { event: 'inbox_messages_INSERT', threadId: tid, payload }, tid)
        if (tid === selectedThreadIdRef.current) {
          fetchMessagesRef.current(selectedThreadIdRef.current)
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'inbox_comments',
      }, (payload) => {
        const tid = (payload.new as { thread_id: string }).thread_id
        if (tid === selectedThreadIdRef.current) {
          fetchCommentsRef.current(selectedThreadIdRef.current)
        }
      })
      .subscribe((status) => {
        setRealtimeConnected(status === 'SUBSCRIBED')
      })

    return () => {
      supabase.removeChannel(ch)
      setRealtimeConnected(false)
    }
  }, [currentOrg?.id])

  // Polling fallback — 15s when realtime disconnected, 60s when connected
  useEffect(() => {
    const interval = setInterval(() => {
      fetchThreads()
    }, realtimeConnected ? 60_000 : 15_000)
    return () => clearInterval(interval)
  }, [fetchThreads, realtimeConnected])

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]); setComments([]); setThreadContacts([]); setAttachments([]); setReplyMode(null); setExpandedMsgs(new Set()); return
    }
    debugLog('selectThread', { selectedThreadId, filter }, selectedThreadId ?? undefined)
    setExpandedMsgs(new Set()) // Reset accordion on thread change
    // Use ref so this effect does not re-run when fetchMessages identity changes (e.g. debugLog after auth/org hydrate) — avoids duplicate fetch-thread-bodies
    fetchMessagesRef.current(selectedThreadId)
    fetchComments(selectedThreadId)
    fetchThreadContacts(selectedThreadId)
    fetchAttachments(selectedThreadId)
    supabase.rpc('match_thread_contacts', { p_thread_id: selectedThreadId }).then(() => fetchThreadContacts(selectedThreadId))
  }, [selectedThreadId, fetchComments, fetchThreadContacts, fetchAttachments, debugLog])

  /** Outbound rows from imap-sync often have null bodies until lazy IMAP fetch; helps spot stuck rows (no external_uid = cannot fetch). */
  useEffect(() => {
    if (!selectedThreadId || messagesLoading) return
    const emptyOutbound = messages.filter(
      (m) => m.direction === 'outbound' && !(m.body?.trim()) && !(m.html_body?.trim()),
    )
    if (emptyOutbound.length === 0) return
    const warnKey = `${selectedThreadId}:${emptyOutbound.map((m) => m.id).sort().join(',')}`
    if (outboundEmptyWarnedKeyRef.current === warnKey) return
    outboundEmptyWarnedKeyRef.current = warnKey
    const items = emptyOutbound.map((m) => ({
      id: m.id,
      external_uid: m.external_uid,
      imap_account_id: m.imap_account_id,
    }))
    console.warn('[Inbox] Outbound message(s) with empty body/html_body', {
      threadId: selectedThreadId,
      hint: 'If external_uid is set, fetch-thread-bodies loads from IMAP (including sent copies in All Mail/INBOX). If null, body should come from inbox-send-reply insert.',
      count: emptyOutbound.length,
      items,
    })
    debugLog('emptyOutboundBodies', { threadId: selectedThreadId, count: emptyOutbound.length, items }, selectedThreadId)
  }, [selectedThreadId, messages, messagesLoading, debugLog])

  useEffect(() => {
    outboundEmptyWarnedKeyRef.current = null
  }, [selectedThreadId])

  const selectedThread = threads.find(t => t.id === selectedThreadId) ?? selectedThreadFallback
  const getUserName = (uid: string) => inboxUsers.find(u => u.user_id === uid)?.display_name ?? uid.slice(0, 8)
  const getUserAvatar = (uid: string) => inboxUsers.find(u => u.user_id === uid)?.avatar_url ?? null
  const currentAssignees = (selectedThread?.inbox_thread_assignments ?? []) as { user_id: string }[]
  const toast = (msg: string) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3000) }

  const isUnread = (t: InboxThread) => {
    const readStatus = readStatuses.find(r => r.thread_id === t.id)
    if (!readStatus) return true
    return new Date(t.last_message_at) > new Date(readStatus.last_read_at)
  }

  // Filter by current tab so we never show trash in All or non-trash in Trash (handles stale threads during filter switch)
  const threadMatchesFilter = (t: InboxThread) => {
    if (filter === 'trash') return t.status === 'archived'
    if (filter === 'all') return t.status !== 'archived'
    if (filter === 'closed') return t.status === 'closed'
    if (filter === 'inbox') return t.status === 'open'
    return true // assigned - fetchThreads already filtered
  }

  // Filtered threads by search; include selectedThreadFallback when not in list so it can be highlighted in sidebar
  const filteredThreads = (() => {
    let base = searchQuery.trim()
      ? threads.filter(t => t.subject?.toLowerCase().includes(searchQuery.toLowerCase()) || t.from_address?.toLowerCase().includes(searchQuery.toLowerCase()))
      : threads
    base = base.filter(threadMatchesFilter)
    const fallbackMatches = selectedThreadFallback && threadMatchesFilter(selectedThreadFallback)
    const fallbackMissing = selectedThreadFallback && !base.some(t => t.id === selectedThreadFallback.id)
    if (fallbackMatches && fallbackMissing) {
      return [selectedThreadFallback, ...base]
    }
    return base
  })()

  // Sync — all accounts in parallel with timeout
  const handleSync = async () => {
    if (!currentOrg?.id || syncing) return
    console.log('[Inbox Sync] Starting sync for org:', currentOrg.id)
    setSyncing(true)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      console.error('[Inbox Sync] No session/token')
      toast('Please sign in again'); setSyncing(false); return
    }

    try {
      const { data: accounts, error: accErr } = await supabase.from('imap_accounts').select('id, email').eq('org_id', currentOrg.id).eq('is_active', true)
      if (accErr) console.error('[Inbox Sync] Failed to fetch accounts:', accErr)
      const accountList = (accounts ?? []) as { id: string; email: string }[]
      console.log('[Inbox Sync] Found', accountList.length, 'active account(s):', accountList.map(a => a.email))

      if (accountList.length === 0) { toast('No email accounts configured'); setSyncing(false); return }

      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY }
      const syncUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-sync`

      const syncAccount = async (acc: { id: string; email: string }) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90_000)
        console.log('[Inbox Sync] Syncing account:', acc.email, acc.id)
        try {
          const res = await fetch(syncUrl, {
            method: 'POST', headers, signal: controller.signal,
            body: JSON.stringify({ orgId: currentOrg.id, accountId: acc.id }),
          })
          clearTimeout(timeout)
          const text = await res.text()
          console.log('[Inbox Sync] Response for', acc.email, '- status:', res.status, '- body:', text.slice(0, 500))
          try {
            const json = JSON.parse(text)
            if (json.error) console.warn('[Inbox Sync] Error from', acc.email, ':', json.error)
            return json
          } catch {
            console.error('[Inbox Sync] Non-JSON response from', acc.email, ':', text.slice(0, 200))
            return { messagesInserted: 0, error: 'Invalid response' }
          }
        } catch (err) {
          clearTimeout(timeout)
          const msg = (err as Error).name === 'AbortError' ? 'Timeout (90s)' : (err as Error).message
          console.error('[Inbox Sync] Fetch failed for', acc.email, ':', msg)
          return { messagesInserted: 0, error: msg }
        }
      }

      const results = await Promise.allSettled(accountList.map(acc => syncAccount(acc)))
      console.log('[Inbox Sync] All results:', results.map((r, i) => ({
        account: accountList[i].email,
        status: r.status,
        value: r.status === 'fulfilled' ? r.value : (r as PromiseRejectedResult).reason,
      })))

      let totalNew = 0
      const errors: string[] = []
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        if (r.status === 'fulfilled') {
          totalNew += r.value?.messagesInserted ?? 0
          if (r.value?.error) errors.push(`${accountList[i].email}: ${r.value.error}`)
        } else {
          errors.push(`${accountList[i].email}: ${(r as PromiseRejectedResult).reason}`)
        }
      }

      console.log('[Inbox Sync] Total new:', totalNew, 'Errors:', errors)

      if (errors.length > 0 && totalNew === 0) {
        toast(`Sync error: ${errors[0]}`)
      } else if (totalNew > 0) {
        toast(`Synced ${totalNew} new message(s) from ${accountList.length} account(s)`)
      } else {
        toast(`No new messages (${accountList.length} account(s) checked)`)
      }
    } catch (e) {
      console.error('[Inbox Sync] Unexpected error:', e)
      toast(`Sync failed: ${(e as Error).message}`)
    }

    setSyncing(false)
    fetchThreads()
  }

  const handleUnassign = async (uid: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_thread_assignments').delete().eq('thread_id', selectedThreadId).eq('user_id', uid)
    await fetchThreads(); setActionLoading(false); toast('Unassigned')
  }

  const handleAssignMultiple = async (uids: string[]) => {
    if (!selectedThreadId || !currentOrg?.id || uids.length === 0) return
    setActionLoading(true)
    const selectedThread = threads.find(t => t.id === selectedThreadId)
    const subject = selectedThread?.subject ?? '(No subject)'
    const assignerName = user?.id ? getUserName(user.id) : 'Someone'
    const rows = uids.map(user_id => ({ thread_id: selectedThreadId, user_id }))
    const { error: assignErr } = await supabase.from('inbox_thread_assignments').insert(rows)
    if (assignErr) {
      console.warn('[Inbox] Multi-assign error:', assignErr.message)
      setActionLoading(false)
      toast(assignErr.message)
      return
    }
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      for (const uid of uids) {
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-user-notification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
          body: JSON.stringify({ event_type: 'thread_assigned', user_id: uid, org_id: currentOrg.id, payload: { thread_id: selectedThreadId, subject, assigner_name: assignerName } }),
        }).catch(() => {})
      }
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-flag-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ threadId: selectedThreadId, action: 'archive' }),
      }).catch(() => {})
    }
    setShowAssignPopover(false)
    setSelectedAssignUserIds(new Set())
    await fetchThreads()
    setActionLoading(false)
    toast(`Assigned to ${uids.length} person${uids.length > 1 ? 's' : ''}`)
  }

  const handleBulkAssignTo = async (uid: string) => {
    if (!currentOrg?.id || selectedIds.size === 0) return
    setActionLoading(true)
    const assignerName = user?.id ? getUserName(user.id) : 'Someone'
    const { data: { session } } = await supabase.auth.getSession()
    const rows = [...selectedIds].map(thread_id => ({ thread_id, user_id: uid }))
    const { error: assignErr } = await supabase.from('inbox_thread_assignments').insert(rows)
    if (assignErr) {
      console.warn('[Inbox] Bulk assign error:', assignErr.message)
      setActionLoading(false)
      toast(assignErr.message)
      return
    }
    if (session?.access_token) {
      for (const tid of selectedIds) {
        const t = threads.find(x => x.id === tid)
        const subject = t?.subject ?? '(No subject)'
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-user-notification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
          body: JSON.stringify({ event_type: 'thread_assigned', user_id: uid, org_id: currentOrg.id, payload: { thread_id: tid, subject, assigner_name: assignerName } }),
        }).catch(() => {})
      }
    }
    setSelectedIds(new Set())
    await fetchThreads()
    setActionLoading(false)
    toast(`Assigned ${rows.length} thread(s) to ${getUserName(uid)}`)
  }

  const handleUpdateStatus = async (status: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_threads').update({ status, updated_at: new Date().toISOString() }).eq('id', selectedThreadId)

    // Sync flags back to IMAP server
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      const action = status === 'archived' ? 'trash' : status === 'closed' ? 'archive' : 'unarchive'
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-flag-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ threadId: selectedThreadId, action }),
      }).catch(() => {})
    }

    await fetchThreads(); setActionLoading(false)
    if (status === 'archived' || status === 'closed') {
      // Auto-load next thread
      const currentIdx = threads.findIndex(t => t.id === selectedThreadId)
      const nextThread = threads[currentIdx + 1] ?? threads[currentIdx - 1]
      const nextId = nextThread?.id ?? null
      console.log('[Inbox:nav] handleUpdateStatus auto-advance', { status, fromThreadId: selectedThreadId, toThreadId: nextId, currentIdx })
      setSelectedThreadId(nextId)
      toast(status === 'archived' ? 'Moved to trash' : 'Thread closed')
    } else {
      toast('Thread re-opened')
    }
  }

  const getSendableAddresses = (): { accountId: string; email: string; label: string }[] => {
    const addrs: { accountId: string; email: string; label: string }[] = []
    for (const acc of imapAccounts) {
      addrs.push({ accountId: acc.id, email: acc.email, label: acc.label ? `${acc.label} <${acc.email}>` : acc.email })
      for (const alias of acc.addresses ?? []) {
        if (alias.toLowerCase() !== acc.email.toLowerCase())
          addrs.push({ accountId: acc.id, email: alias, label: `${acc.label ?? 'Alias'} <${alias}>` })
      }
    }
    return addrs
  }

  // Parse "Name <email>" or plain email into lowercase email
  const parseEmail = (s: string | null): string | null => {
    if (!s?.trim()) return null
    const m = s.trim().match(/<([^>]+)>/)
    return m ? m[1].trim().toLowerCase() : s.trim().toLowerCase()
  }

  // Find which IMAP account to use based on our address in the last message
  // Inbound: we're in to_identifier or cc. Outbound: we're in from_identifier
  const findFromAccountForReply = (lastMsg: InboxMessage): string => {
    const ourAddresses: string[] = []
    if (lastMsg.direction === 'inbound') {
      const to = parseEmail(lastMsg.to_identifier)
      if (to) ourAddresses.push(to)
      for (const part of (lastMsg.cc ?? '').split(/[,;]/)) {
        const e = parseEmail(part)
        if (e) ourAddresses.push(e)
      }
    } else {
      const from = parseEmail(lastMsg.from_identifier)
      if (from) ourAddresses.push(from)
    }
    for (const addr of ourAddresses) {
      for (const acc of imapAccounts) {
        const accEmails = [acc.email.toLowerCase(), ...(acc.addresses ?? []).map(a => a.toLowerCase())]
        if (accEmails.includes(addr)) return acc.id
      }
    }
    return selectedAccountId
  }

  // Collect all unique addresses in the thread (from, to, cc) excluding any address that appears in the From dropdown; for Reply All
  const getThreadRecipientsForReplyAll = (anchorMessage: InboxMessage | null): { to: string; cc: string } => {
    const fromDropdownEmails = new Set<string>()
    for (const acc of imapAccounts) {
      fromDropdownEmails.add(acc.email.trim().toLowerCase())
      for (const a of acc.addresses ?? []) {
        fromDropdownEmails.add(a.trim().toLowerCase())
      }
    }
    const parseAddresses = (s: string | null): string[] => {
      if (!s?.trim()) return []
      return s
        .split(/[,;]/)
        .map((e) => e.replace(/^.*<([^>]+)>$/, '$1').trim().toLowerCase())
        .filter(Boolean)
    }
    const set = new Set<string>()
    for (const m of messages) {
      const from = parseAddresses(m.from_identifier)[0]
      if (from) set.add(from)
      for (const a of parseAddresses(m.to_identifier)) set.add(a)
      for (const a of parseAddresses(m.cc)) set.add(a)
    }
    fromDropdownEmails.forEach((e) => set.delete(e))
    const lastInbound = messages.filter((m) => m.direction === 'inbound').pop()
    const primary = anchorMessage
      ? (parseAddresses(anchorMessage.from_identifier)[0] ?? '')
      : (lastInbound && parseAddresses(lastInbound.from_identifier)[0]) ?? ''
    const rest = [...set].filter((e) => e && e !== primary)
    return { to: primary, cc: rest.join(', ') }
  }

  const openReply = (mode: 'reply' | 'reply_all' | 'forward' | 'compose') => {
    setReplyAnchorMsgId(null)
    if (mode === 'compose') {
      setReplyTo(''); setReplyCc(''); setReplyBcc(''); setReplySubject(''); setReplyHtml(''); setShowCcBcc(false); setReplyAttachments([])
    } else if (selectedThread && messages.length > 0) {
      const last = messages[messages.length - 1]
      setSelectedAccountId(findFromAccountForReply(last))
      if (mode === 'reply_all') {
        const { to, cc } = getThreadRecipientsForReplyAll(null)
        setReplyTo(to)
        setReplyCc(cc)
        setShowCcBcc(!!cc.trim())
      } else {
        // Reply: inbound → reply to sender (from); outbound → reply to recipient (to)
        const replyToAddr = mode === 'forward' ? '' : (last.direction === 'inbound' ? last.from_identifier : last.to_identifier)
        setReplyTo(replyToAddr ?? '')
        setReplyCc('')
        setReplyBcc('')
        setShowCcBcc(false)
      }
      setReplyBcc('')
      const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
      const subj = selectedThread.subject ?? ''
      setReplySubject(subj.startsWith(prefix) ? subj : prefix + subj)
      if (mode === 'forward') {
        const { content } = cleanMessageBody(last)
        setReplyHtml(`<br/><br/>---------- Forwarded message ----------<br/>${content}`)
      } else setReplyHtml('')
      setReplyAttachments([])
    }
    setReplyMode(mode)
    setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 200)
  }

  const handleSendReply = async () => {
    if (!replyTo.trim() && replyMode !== 'compose') { toast('Recipient required'); return }
    const hasPendingFiles = replyAttachments.length > 0
    if (isHtmlBodyEffectivelyEmpty(replyHtml) && !hasPendingFiles) {
      toast('Message body is empty')
      return
    }
    const bodyForApi =
      isHtmlBodyEffectivelyEmpty(replyHtml) && hasPendingFiles ? '<p></p>' : replyHtml
    if (sendingReplyRef.current) {
      console.warn('[Inbox] handleSendReply: already sending, ignoring duplicate call')
      return
    }
    sendingReplyRef.current = true
    setSendingReply(true)
    const sendId = `send-${Date.now()}`
    console.log('[Inbox] handleSendReply:', sendId, 'threadId=', selectedThreadId, 'to=', replyTo?.slice(0, 50), 'mode=', replyMode, 'pendingAttachments=', replyAttachments.length)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { toast('Please sign in again'); sendingReplyRef.current = false; setSendingReply(false); return }
    let attachmentRefs: { fileName: string; filePath: string; contentType: string; fileSize?: number }[] = []
    if (replyAttachments.length > 0 && currentOrg?.id) {
      for (let i = 0; i < replyAttachments.length; i++) {
        const file = replyAttachments[i]
        const path = `${currentOrg.id}/${selectedThreadId ?? 'compose'}/${crypto.randomUUID()}-${sanitizeInboxStorageFileName(file.name)}`
        console.log('[Inbox:attachment] upload start', { sendId, index: i, path, name: file.name, size: file.size, type: file.type })
        const { error } = await supabase.storage.from('inbox-attachments').upload(path, file)
        if (error) {
          console.error('[Inbox:attachment] upload failed', { sendId, path, name: file.name, message: error.message, error })
          toast(`Could not upload "${file.name}": ${error.message}`)
          sendingReplyRef.current = false
          setSendingReply(false)
          return
        }
        attachmentRefs.push({
          fileName: file.name,
          filePath: path,
          contentType: file.type || 'application/octet-stream',
          fileSize: file.size,
        })
        console.log('[Inbox:attachment] upload ok', { sendId, path, name: file.name })
      }
    }
    const payload: Record<string, unknown> = {
      body: bodyForApi, subject: replySubject, to: replyTo.trim(),
      cc: replyCc.trim() || undefined, bcc: replyBcc.trim() || undefined,
      isHtml: true, accountId: selectedAccountId || undefined,
      attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
    }
    if (selectedThreadId && replyMode !== 'compose') payload.threadId = selectedThreadId
    else payload.compose = true
    console.log('[Inbox] handleSendReply:', sendId, 'calling inbox-send-reply', { attachmentCount: attachmentRefs.length, hasThreadId: !!payload.threadId, compose: !!payload.compose })
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    console.log('[Inbox] handleSendReply:', sendId, 'response status=', res.status, 'ok=', res.ok, 'data=', data?.error ? { error: data.error } : { ok: data.ok, threadId: data.threadId })
    sendingReplyRef.current = false
    setSendingReply(false)
    if (data?.error) { toast(data.error); return }
    setReplyMode(null); setReplyHtml(''); setReplyAttachments([])
    console.log('[Inbox] handleSendReply:', sendId, 'success, fetching threads and messages')
    toast('Sent'); fetchThreads()
    if (selectedThreadId) {
      fetchMessages(selectedThreadId)
      fetchAttachments(selectedThreadId)
    }
  }

  const handleAddComment = async () => {
    if (!selectedThreadId || !commentText.trim() || !userId || !currentOrg?.id) return
    const mentionRegex = /@(\w+)/g
    const mentionNames = [...commentText.trim().matchAll(mentionRegex)].map(m => m[1].toLowerCase())
    const mentionIds = inboxUsers.filter(u => mentionNames.some(n => u.display_name?.toLowerCase().includes(n) || u.email?.toLowerCase().includes(n))).map(u => u.user_id)
    const { error: insertErr } = await supabase.from('inbox_comments').insert({
      thread_id: selectedThreadId, user_id: userId, content: commentText.trim(),
      mentions: mentionIds.length > 0 ? mentionIds : null,
    })
    if (insertErr) return
    const contentPreview = commentText.trim().slice(0, 200) + (commentText.trim().length > 200 ? '...' : '')
    const commenterName = getUserName(userId)
    const selectedThread = threads.find(t => t.id === selectedThreadId)
    const subject = selectedThread?.subject ?? '(No subject)'
    commentProgrammaticRef.current = true
    setCommentText('')
    fetchComments(selectedThreadId)

    // Notify each mentioned user via Slack DM / email (same as thread assignment — no app_config)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    const payload = {
      thread_id: selectedThreadId,
      subject,
      commenter_name: commenterName,
      content_preview: contentPreview,
    }
    for (const mentionedId of mentionIds) {
      if (mentionedId === userId) continue
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-user-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          event_type: 'mentioned_in_thread',
          user_id: mentionedId,
          org_id: currentOrg.id,
          payload,
        }),
      }).catch(() => {})
    }
  }

  const insertMention = (u: InboxUser) => {
    const name = u.display_name ?? u.email ?? 'user'
    commentProgrammaticRef.current = true
    setCommentText(prev => {
      // Replace the @partial with the full @name (e.g. "@mu" → "@Muaz Ali ")
      const atIdx = prev.lastIndexOf('@')
      if (atIdx >= 0) return prev.slice(0, atIdx) + `@${name} `
      return prev + `@${name} `
    })
    setShowMentionPicker(false)
  }

  const updateToSuggestions = (val: string) => {
    setReplyTo(val)
    const lastPart = val.split(',').pop()?.trim().toLowerCase() ?? ''
    if (lastPart.length < 2) { setShowToSuggestions(false); return }
    const matches = allContacts.filter(c => c.email && (c.name.toLowerCase().includes(lastPart) || c.email.toLowerCase().includes(lastPart))).slice(0, 5)
    setToSuggestions(matches.map(c => ({ name: c.name, email: c.email! })))
    setShowToSuggestions(matches.length > 0)
  }

  const selectToSuggestion = (email: string) => {
    const parts = replyTo.split(',').map(s => s.trim()).filter(Boolean)
    parts.pop()
    parts.push(email)
    setReplyTo(parts.join(', ') + ', ')
    setShowToSuggestions(false)
  }

  const handleCreateContact = async (email: string) => {
    if (!currentOrg?.id || !email) return
    const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const { data, error } = await supabase.from('contacts').insert({ org_id: currentOrg.id, name, email, type: 'primary' }).select('id').single()
    if (error) { toast(error.message); return }
    if (data && selectedThreadId) {
      await supabase.from('inbox_thread_contacts').insert({ thread_id: selectedThreadId, contact_id: (data as { id: string }).id })
      fetchThreadContacts(selectedThreadId); toast(`Contact created`)
    }
  }

  const appendReplyAttachments = (files: File[]) => {
    if (files.length === 0) return
    console.log('[Inbox:attachment] add files', { count: files.length, names: files.map(f => f.name), sizes: files.map(f => f.size) })
    setReplyAttachments(prev => [...prev, ...files])
  }

  // File drop handling
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) appendReplyAttachments(Array.from(e.dataTransfer.files))
  }
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }
  const handleDragLeave = () => setIsDragging(false)

  const getDownloadUrl = (path: string) => supabase.storage.from('inbox-attachments').getPublicUrl(path).data.publicUrl
  const getAttachmentHref = (a: Attachment) => a.signedUrl ?? getDownloadUrl(a.file_path)

  const handleReloadFromImap = useCallback(async (m: InboxMessage) => {
    if (!m.imap_account_id || m.external_uid == null) return
    setImapReloadingId(m.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setToastMsg('Sign in to reload from mail server')
        setTimeout(() => setToastMsg(null), 3000)
        return
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-fetch-body`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ messageId: m.id, forceRefresh: true }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; body?: string | null; htmlBody?: string | null; attachmentCount?: number }
      if (!res.ok || data.error) {
        setToastMsg(data.error || `Reload failed (${res.status})`)
        setTimeout(() => setToastMsg(null), 4000)
        return
      }
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id ? { ...x, body: data.body ?? null, html_body: data.htmlBody ?? null } : x
        )
      )
      await fetchAttachments(m.thread_id)
      const ac = typeof data.attachmentCount === 'number' ? `${data.attachmentCount} file(s) from IMAP. ` : ''
      setToastMsg(`${ac}Reloaded from mail server.`)
      setTimeout(() => setToastMsg(null), 3500)
    } catch {
      setToastMsg('Could not reload from mail server')
      setTimeout(() => setToastMsg(null), 3000)
    } finally {
      setImapReloadingId(null)
    }
  }, [fetchAttachments])

  const attachmentsByMessageId = useMemo(() => {
    const m = new Map<string, Attachment[]>()
    for (const a of attachments) {
      if (a.message_id) {
        const list = m.get(a.message_id) ?? []
        list.push(a)
        m.set(a.message_id, list)
      }
    }
    for (const [, list] of m) {
      list.sort((x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime())
    }
    return m
  }, [attachments])

  const threadLevelAttachments = useMemo(
    () => attachments.filter((a) => !a.message_id),
    [attachments],
  )

  // Render email address with contact linking
  const renderEmail = (email: string) => {
    const { name, contactId } = resolveEmail(email, threadContacts)
    if (name && contactId) {
      return <Link to={`/contacts/${contactId}`} className="text-accent hover:underline" title={email}>{name} &lt;{email}&gt;</Link>
    }
    return (
      <span className="group inline-flex items-center gap-1">
        <span className="text-gray-300">{email}</span>
        <button type="button" onClick={() => handleCreateContact(email)} className="opacity-0 group-hover:opacity-100 transition-opacity" title="Create contact">
          <Plus className="w-3 h-3 text-gray-500 hover:text-accent" />
        </button>
      </span>
    )
  }

  if (!currentOrg) return <div className="p-4 md:p-6"><p className="text-gray-400">Select a workspace.</p></div>

  const sendableAddresses = getSendableAddresses()

  // Compose reply form (shared between compose mode and inline reply)
  const renderReplyForm = (isCompose: boolean) => (
    <div className={`rounded-lg border ${isDragging ? 'border-accent bg-accent/5' : 'border-accent/30 bg-surface-elevated'} p-4 space-y-3`}
      onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
      {isDragging && <div className="text-center py-4 text-accent text-sm font-medium">Drop files to attach</div>}
      <div className="flex items-center justify-between text-xs">
        <span className="text-accent font-medium">{replyMode === 'reply' ? 'Reply' : replyMode === 'reply_all' ? 'Reply All' : replyMode === 'forward' ? 'Forward' : 'New message'}</span>
      </div>
      <div className="space-y-2">
        {sendableAddresses.length > 1 && (
          <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-12 shrink-0">From</label>
            <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent">
              {sendableAddresses.map((a, i) => <option key={i} value={a.accountId}>{a.label}</option>)}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2 relative"><label className="text-xs text-gray-500 w-12 shrink-0">To</label>
          <div className="flex-1 relative">
            <input type="text" value={replyTo} onChange={e => updateToSuggestions(e.target.value)} onBlur={() => setTimeout(() => setShowToSuggestions(false), 200)} placeholder="recipient@example.com"
              className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
            {showToSuggestions && (
              <div className="absolute top-full left-0 mt-1 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto w-full z-20">
                {toSuggestions.map(s => (
                  <button key={s.email} type="button" onMouseDown={() => selectToSuggestion(s.email)}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-muted flex items-center justify-between">
                    <span>{s.name}</span>
                    <span className="text-xs text-gray-500">{s.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!showCcBcc && <button type="button" onClick={() => setShowCcBcc(true)} className="text-xs text-gray-400 hover:text-accent"><ChevronDown className="w-4 h-4" /></button>}
        </div>
        {showCcBcc && (
          <>
            <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-12 shrink-0">Cc</label>
              <input type="text" value={replyCc} onChange={e => setReplyCc(e.target.value)}
                className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" /></div>
            <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-12 shrink-0">Bcc</label>
              <input type="text" value={replyBcc} onChange={e => setReplyBcc(e.target.value)}
                className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" /></div>
          </>
        )}
        {isCompose && (
          <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-12 shrink-0">Subject</label>
            <input type="text" value={replySubject} onChange={e => setReplySubject(e.target.value)} placeholder="Subject"
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" /></div>
        )}
      </div>
      <RichTextEditor content={replyHtml} onChange={setReplyHtml} placeholder="Write your message…" autofocus />
      {replyAttachments.length > 0 && (
        <div className="px-1 py-2 space-y-1.5">
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Attached to this send</div>
          <div className="flex flex-wrap gap-2">
            {replyAttachments.map((f, i) => (
              <span
                key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                className="text-xs bg-surface-muted px-2 py-1 rounded text-gray-300 inline-flex items-center gap-1 max-w-full"
              >
                <Paperclip className="w-3 h-3 shrink-0" />
                <span className="truncate" title={f.name}>{f.name}</span>
                <button type="button" onClick={() => setReplyAttachments(prev => prev.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 ml-1 shrink-0">&times;</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={handleSendReply} disabled={sendingReply || !replyTo.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
          <Send className="w-4 h-4" /> {sendingReply ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={() => replyFileRef.current?.click()} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted" title="Attach file">
          <Paperclip className="w-4 h-4" />
        </button>
        <input
          ref={replyFileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) appendReplyAttachments(Array.from(e.target.files))
            e.target.value = ''
          }}
        />
        <button type="button" onClick={() => {
          console.log('[Inbox:nav] Reply form Cancel click')
          setReplyMode(null)
        }} className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted ml-auto">Cancel</button>
      </div>
    </div>
  )

  // Debug: log when URL thread is not in list (explains "thread missing for this user")
  useEffect(() => {
    if (inboxDebug && urlThreadId && threads.length > 0) {
      const inList = threads.some(t => t.id === urlThreadId)
      if (!inList) debugLog('visibility', { event: 'URL_thread_NOT_in_list', urlThreadId, threadIds: threads.map(t => t.id), filter, userId })
    }
  }, [inboxDebug, urlThreadId, threads, filter, userId])

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="inbox-page">
      {toastMsg && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-accent text-white text-sm shadow-lg">{toastMsg}</div>}
      {inboxDebug && (
        <div className="bg-amber-500/20 border-b border-amber-500/40 px-4 py-2 text-xs text-amber-200 font-mono">
          Debug mode: Console (F12, filter by &quot;Inbox&quot;) + Supabase table <code className="bg-amber-500/30 px-1 rounded">inbox_debug_log</code> — logs queries, thread visibility, and empty message bodies.
        </div>
      )}

      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {FILTERS.map(f => (
            <button key={f.id} type="button" onClick={() => {
              console.log('[Inbox:nav] filter tab click', { filterId: f.id, label: f.label })
              setFilter(f.id); setSelectedThreadId(null); initialLoadDone.current = false
            }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                filter === f.id ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300 hover:bg-surface-muted/80'}`}>
              <f.icon className="w-3.5 h-3.5" /> {f.label}
            </button>
          ))}
          {selectedIds.size > 0 && (
            <div className="inline-flex items-center gap-1.5 pl-1 border-l border-border">
              <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <select
                value=""
                onChange={e => { const uid = e.target.value; if (uid) handleBulkAssignTo(uid) }}
                disabled={actionLoading}
                className="rounded border border-border bg-surface-muted px-2 py-1.5 text-xs font-medium text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              >
                <option value="">Assign…</option>
                {inboxUsers.map(u => (
                  <option key={u.user_id} value={u.user_id}>
                    {u.display_name ?? u.email ?? u.user_id.slice(0, 8)}{u.user_id === userId ? ' (Me)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={handleSync} disabled={syncing} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted disabled:opacity-50" title="Sync emails">
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={() => {
            console.log('[Inbox:nav] Compose button click')
            setSelectedThreadId(null); openReply('compose')
          }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90">
            <Plus className="w-3.5 h-3.5" /> Compose
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Thread list */}
        <div className={`${selectedThreadId || replyMode === 'compose' ? 'hidden md:flex' : 'flex'} w-full md:w-80 lg:w-96 flex-col border-r border-border bg-surface-muted/20 shrink-0`}>
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search threads…"
                className="w-full rounded border border-border bg-surface-muted pl-8 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="px-3 py-2 border-b border-border bg-surface-elevated flex items-center gap-2">
              <span className="text-xs text-gray-300">{selectedIds.size} selected</span>
              <button type="button" onClick={async () => {
                for (const tid of selectedIds) {
                  await supabase.from('inbox_threads').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', tid)
                }
                setSelectedIds(new Set()); fetchThreads(); toast(`${selectedIds.size} thread(s) trashed`)
              }} className="px-2 py-1 rounded text-[11px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30">Trash</button>
              <button type="button" onClick={async () => {
                for (const tid of selectedIds) {
                  await supabase.from('inbox_threads').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', tid)
                }
                setSelectedIds(new Set()); fetchThreads(); toast(`${selectedIds.size} thread(s) closed`)
              }} className="px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80">Close</button>
              <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-500 hover:text-gray-300 ml-auto">Cancel</button>
            </div>
          )}

          {loading ? <div className="p-4 text-gray-400 text-sm">Loading…</div>
          : filteredThreads.length === 0 ? (
            <div className="p-4 text-gray-400 text-sm text-center mt-8"><InboxIcon className="w-8 h-8 mx-auto mb-2 opacity-40" /><p>No threads</p></div>
          ) : (
            <ul className="overflow-y-auto divide-y divide-border flex-1">
              {filteredThreads.map(t => {
                const assignees = (Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments : []) as { user_id: string }[]
                const unread = isUnread(t)
                const isSelected = selectedIds.has(t.id)
                return (
                  <li key={t.id} className="relative group/row">
                    {/* Multi-select checkbox */}
                    <input type="checkbox" checked={isSelected}
                      onChange={e => { e.stopPropagation(); const next = new Set(selectedIds); if (e.target.checked) next.add(t.id); else next.delete(t.id); setSelectedIds(next) }}
                      className="absolute left-1.5 top-4 w-3.5 h-3.5 rounded border-border bg-surface-muted text-accent focus:ring-accent opacity-0 group-hover/row:opacity-100 checked:opacity-100 z-10 cursor-pointer"
                      onClick={e => e.stopPropagation()} />
                    <button type="button" onClick={() => {
                      if (selectedIds.size > 0) { const next = new Set(selectedIds); if (isSelected) next.delete(t.id); else next.add(t.id); setSelectedIds(next); return }
                      console.log('[Inbox:nav] thread list click', { threadId: t.id, subject: t.subject?.slice(0, 40) })
                      setSelectedThreadId(t.id); setReplyMode(null)
                      if (userId) {
                        setReadStatuses(prev => {
                          const existing = prev.filter(r => r.thread_id !== t.id)
                          return [...existing, { thread_id: t.id, last_read_at: new Date().toISOString() }]
                        })
                      }
                    }}
                      className={`w-full text-left pl-5 pr-4 py-3 transition-colors border-l-2 ${unread ? 'border-accent bg-accent/5' : 'border-transparent'} ${selectedThreadId === t.id ? 'bg-surface-muted' : 'hover:bg-surface-muted/50'}`}>
                      <div className="flex items-start gap-2">
                        <span className="mt-1 shrink-0 text-gray-500">{t.channel === 'email' ? <Mail className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className={`text-sm truncate ${unread ? 'font-semibold text-white' : 'font-medium text-gray-300'}`}>{t.subject || '(No subject)'}</p>
                            <span className="text-[10px] text-gray-500 shrink-0">{(() => {
                              const d = new Date(t.last_message_at)
                              const now = new Date()
                              return d.toDateString() === now.toDateString()
                                ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                                : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                            })()}</span>
                          </div>
                          <p className="text-xs text-gray-400 truncate mt-0.5">{t.from_address ?? ''}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${t.status === 'open' ? 'bg-accent/20 text-accent' : t.status === 'closed' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{t.status === 'archived' ? 'trash' : t.status}</span>
                            {assignees.length > 0 && (
                              <span className="inline-flex items-center gap-1.5 flex-wrap">
                                {assignees.slice(0, 4).map(a => {
                                  const av = getUserAvatar(a.user_id)
                                  const name = getUserName(a.user_id)
                                  return (
                                    <span key={a.user_id} className="inline-flex items-center gap-1 text-[10px] text-gray-400">
                                      {av ? <img src={av} alt="" className="w-4 h-4 rounded-full shrink-0" /> : <span className="w-4 h-4 rounded-full bg-accent/20 flex items-center justify-center text-[8px] font-medium text-accent shrink-0">{(name)[0]?.toUpperCase()}</span>}
                                      <span className="truncate max-w-[80px]">{name}</span>
                                    </span>
                                  )
                                })}
                                {assignees.length > 4 && <span className="text-[9px] text-gray-500">+{assignees.length - 4}</span>}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className={`${selectedThreadId || replyMode === 'compose' ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0 min-h-0`}>
          {!selectedThread && replyMode !== 'compose' ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Select a thread</div>
          ) : replyMode === 'compose' && !selectedThread ? (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="border-b border-border px-4 py-2.5 shrink-0 flex items-center gap-2">
                <button type="button" onClick={() => {
                  console.log('[Inbox:nav] Compose back button (mobile)')
                  setReplyMode(null)
                }} className="md:hidden p-1 rounded text-gray-400 hover:text-white"><ChevronRight className="w-4 h-4 rotate-180" /></button>
                <h2 className="text-white font-medium text-sm">New message</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-4">{renderReplyForm(true)}</div>
            </div>
          ) : selectedThread && (
            <>
              {/* Thread header */}
              <div className="border-b border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2 mb-2">
                  <button type="button" onClick={() => {
                    console.log('[Inbox:nav] thread detail back button (mobile)', { fromThreadId: selectedThread?.id })
                    setSelectedThreadId(null); setReplyMode(null)
                  }} className="md:hidden p-1 rounded text-gray-400 hover:text-white"><ChevronRight className="w-4 h-4 rotate-180" /></button>
                  <h2 className="text-white font-medium truncate flex-1 text-sm">{selectedThread.subject || '(No subject)'}</h2>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${selectedThread.status === 'open' ? 'bg-accent/20 text-accent' : selectedThread.status === 'closed' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{selectedThread.status}</span>
                  <button type="button" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/inbox/${selectedThread.id}`); toast('Thread link copied') }}
                    className="p-1 rounded text-gray-400 hover:text-white hover:bg-surface-muted" title="Copy thread link">
                    <Link2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Reordered: Read/Unread → Reply → All → Fwd → Close → Trash → Assign → Assignees */}
                  <button type="button" onClick={async () => {
                    const isRead = !isUnread(selectedThread)
                    if (isRead) {
                      await supabase.from('inbox_thread_reads').delete().eq('thread_id', selectedThread.id).eq('user_id', userId!)
                      setReadStatuses(prev => prev.filter(r => r.thread_id !== selectedThread.id))
                    } else {
                      setReadStatuses(prev => [...prev.filter(r => r.thread_id !== selectedThread.id), { thread_id: selectedThread.id, last_read_at: new Date().toISOString() }])
                    }
                    toast(isRead ? 'Marked unread' : 'Marked read')
                  }} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80">
                    <Mail className="w-3 h-3" /> {isUnread(selectedThread) ? 'Read' : 'Unread'}
                  </button>
                  <button type="button" onClick={() => openReply('reply')} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"><Reply className="w-3 h-3" /> Reply</button>
                  <button type="button" onClick={() => openReply('reply_all')} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"><ReplyAll className="w-3 h-3" /> All</button>
                  <button type="button" onClick={() => openReply('forward')} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"><Forward className="w-3 h-3" /> Fwd</button>
                  <div className="w-px h-4 bg-border mx-0.5" />
                  {selectedThread.status === 'open' && <button type="button" onClick={() => handleUpdateStatus('closed')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"><Check className="w-3 h-3" /> Close</button>}
                  {(selectedThread.status === 'closed' || selectedThread.status === 'archived') && <button type="button" onClick={() => handleUpdateStatus('open')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"><RotateCcw className="w-3 h-3" /> Re-open</button>}
                  {selectedThread.status !== 'archived' && <button type="button" onClick={() => handleUpdateStatus('archived')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50"><Archive className="w-3 h-3" /> Trash</button>}
                  <div className="w-px h-4 bg-border mx-0.5" />
                  <div className="relative">
                    <button type="button" onClick={() => { setShowAssignPopover(v => !v); setSelectedAssignUserIds(new Set()) }} disabled={actionLoading}
                      className="rounded border border-border bg-surface-muted px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent">
                      {currentAssignees.length > 0 ? '+ Assign' : 'Assign…'}
                    </button>
                    {showAssignPopover && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowAssignPopover(false)} aria-hidden />
                        <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border border-border bg-surface-elevated shadow-lg py-1 max-h-[200px] overflow-y-auto">
                          {inboxUsers.filter(u => !currentAssignees.some(a => a.user_id === u.user_id)).length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-gray-500">Everyone is assigned</div>
                          ) : (
                            <>
                              {inboxUsers.filter(u => !currentAssignees.some(a => a.user_id === u.user_id)).map(u => (
                                <label key={u.user_id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-muted cursor-pointer">
                                  <input type="checkbox" checked={selectedAssignUserIds.has(u.user_id)}
                                    onChange={e => setSelectedAssignUserIds(prev => { const n = new Set(prev); if (e.target.checked) n.add(u.user_id); else n.delete(u.user_id); return n })}
                                    className="rounded border-border text-accent focus:ring-accent" />
                                  {getUserAvatar(u.user_id) ? <img src={getUserAvatar(u.user_id)!} alt="" className="w-5 h-5 rounded-full" /> : <span className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-[9px] font-medium text-accent">{(u.display_name || u.email || u.user_id)[0]?.toUpperCase()}</span>}
                                  <span className="text-[11px] text-gray-200 truncate">{u.display_name || u.email || u.user_id.slice(0, 8)}{u.user_id === userId ? ' (Me)' : ''}</span>
                                </label>
                              ))}
                              <div className="border-t border-border mt-1 pt-1 px-2">
                                <button type="button" onClick={() => handleAssignMultiple([...selectedAssignUserIds])} disabled={selectedAssignUserIds.size === 0 || actionLoading}
                                  className="w-full px-2 py-1 rounded text-[11px] font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
                                  Assign {selectedAssignUserIds.size > 0 ? `(${selectedAssignUserIds.size})` : ''}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {currentAssignees.map(a => (
                    <span key={a.user_id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface-muted text-[11px] text-gray-200">
                      {getUserAvatar(a.user_id) ? (
                        <img src={getUserAvatar(a.user_id)!} alt="" className="w-4 h-4 rounded-full" />
                      ) : (
                        <span className="w-4 h-4 rounded-full bg-accent/20 flex items-center justify-center text-[8px] font-medium text-accent">{(getUserName(a.user_id))[0]?.toUpperCase()}</span>
                      )}
                      {getUserName(a.user_id)}
                      <button type="button" onClick={() => handleUnassign(a.user_id)} className="text-gray-500 hover:text-red-400 ml-0.5">&times;</button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Timeline */}
              <div className="flex-1 overflow-y-auto" onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
                {isDragging && <div className="mx-4 mt-4 p-4 rounded-lg border-2 border-dashed border-accent bg-accent/5 text-center text-accent text-sm">Drop files to attach</div>}
                <div className="p-4 space-y-4">
                  {threadLevelAttachments.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap text-xs rounded-lg border border-border/60 bg-surface-elevated/40 px-3 py-2">
                      <span className="text-gray-500 shrink-0">Thread attachments:</span>
                      <span className="text-gray-500 text-[10px]">(not linked to a specific message)</span>
                      <div className="flex flex-wrap gap-2">
                        {threadLevelAttachments.map((a) => (
                          <a key={a.id} href={getAttachmentHref(a)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-muted text-gray-300 hover:text-accent">
                            <Download className="w-3 h-3 shrink-0" /> {a.file_name}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {messagesLoading ? <div className="text-gray-400 text-sm">Loading…</div> : (() => {
                    // Find the last message (for auto-expand)
                    const msgItems = timeline.filter(i => i.kind === 'message')
                    const lastMsgId = msgItems.length > 0 ? (msgItems[msgItems.length - 1].data as InboxMessage).id : null
                    return timeline.map((item) => {
                      if (item.kind === 'comment') {
                        const c = item.data
                        return (
                          <div key={`cmt-${c.id}`} className="flex gap-3">
                            {c.avatar_url ? (
                              <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full shrink-0 mt-0.5" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5 text-[11px] font-medium text-amber-400">
                                {(c.display_name ?? '?')[0].toUpperCase()}
                              </div>
                            )}
                            <div className="flex-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5">
                              <div className="flex items-baseline gap-2 text-[11px] mb-1">
                                <span className="text-amber-400 font-medium">{c.display_name ?? getUserName(c.user_id)}</span>
                                <span className="text-gray-500">{new Date(c.created_at).toLocaleString()}</span>
                                <span className="text-amber-500/50 ml-auto text-[10px]">internal comment</span>
                              </div>
                              <p className="text-sm text-white whitespace-pre-wrap break-words">{renderCommentContentWithMentions(c.content)}</p>
                            </div>
                          </div>
                        )
                      }
                      const m = item.data
                      const isExpanded = m.id === lastMsgId || expandedMsgs.has(m.id)
                      const { html, content } = isExpanded ? cleanMessageBody(m) : { html: false, content: '' }
                      const sanitized = html ? sanitizeEmailHtml(content) : content
                      const preview = !isExpanded && m.body ? m.body.replace(/<[^>]+>/g, '').slice(0, 80) : ''
                      const msgAttachments = attachmentsByMessageId.get(m.id) ?? []
                      return (<React.Fragment key={`msg-${m.id}`}>
                        <article className="rounded-lg border border-border overflow-hidden group/msg">
                          <header onClick={() => setExpandedMsgs(prev => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n })}
                            className={`px-4 py-2 text-[11px] text-gray-400 flex flex-wrap items-center gap-x-3 gap-y-0.5 bg-surface-elevated/50 ${!isExpanded ? 'cursor-pointer hover:bg-surface-muted/50' : 'border-b border-border'}`}>
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 flex-1 min-w-0">
                              <span><span className="text-gray-500">From:</span> {renderEmail(m.from_identifier)}</span>
                              {isExpanded && m.to_identifier && <span><span className="text-gray-500">To:</span> {renderEmail(m.to_identifier)}</span>}
                              {isExpanded && m.cc && <span><span className="text-gray-500">Cc:</span> {m.cc}</span>}
                              {!isExpanded && preview && <span className="text-gray-500 truncate ml-2">{preview}</span>}
                              {msgAttachments.length > 0 && (
                                <span className="inline-flex items-center gap-1 text-gray-500 shrink-0" title={`${msgAttachments.length} attachment(s)`}>
                                  <Paperclip className="w-3 h-3 text-accent/80" />
                                  {msgAttachments.length}
                                </span>
                              )}
                              <span className="ml-auto">{new Date(m.received_at).toLocaleString()}</span>
                            </div>
                            {isExpanded && <div className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity shrink-0">
                              {m.imap_account_id && m.external_uid != null && (
                                <button
                                  type="button"
                                  title="Reload body & attachments from mail server (IMAP)"
                                  disabled={imapReloadingId === m.id}
                                  onClick={(e) => { e.stopPropagation(); handleReloadFromImap(m) }}
                                  className="p-1 rounded text-gray-500 hover:text-accent hover:bg-surface-muted disabled:opacity-40 shrink-0"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${imapReloadingId === m.id ? 'animate-spin' : ''}`} />
                                </button>
                              )}
                              <button type="button" title="Reply" onClick={(e) => { e.stopPropagation()
                                setSelectedAccountId(findFromAccountForReply(m))
                                setReplyTo(m.from_identifier); setReplyCc(''); setReplyBcc('')
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Re: ') ? selectedThread!.subject! : 'Re: ' + (selectedThread?.subject ?? ''))
                                setReplyHtml(''); setShowCcBcc(false); setReplyAttachments([]); setReplyAnchorMsgId(m.id); setReplyMode('reply')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><Reply className="w-3.5 h-3.5" /></button>
                              <button type="button" title="Reply All" onClick={(e) => { e.stopPropagation()
                                setSelectedAccountId(findFromAccountForReply(m))
                                const { to, cc } = getThreadRecipientsForReplyAll(m)
                                setReplyTo(to)
                                setReplyCc(cc)
                                setReplyBcc('')
                                setShowCcBcc(!!cc.trim())
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Re: ') ? selectedThread!.subject! : 'Re: ' + (selectedThread?.subject ?? ''))
                                setReplyHtml(''); setReplyAttachments([]); setReplyAnchorMsgId(m.id); setReplyMode('reply_all')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><ReplyAll className="w-3.5 h-3.5" /></button>
                              <button type="button" title="Forward" onClick={(e) => { e.stopPropagation()
                                setSelectedAccountId(findFromAccountForReply(m))
                                setReplyTo(''); setReplyCc(''); setReplyBcc(''); setShowCcBcc(false)
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Fwd: ') ? selectedThread!.subject! : 'Fwd: ' + (selectedThread?.subject ?? ''))
                                const { content: fwdContent } = cleanMessageBody(m)
                                setReplyHtml(`<br/><br/>---------- Forwarded message ----------<br/><b>From:</b> ${m.from_identifier}<br/><b>Date:</b> ${new Date(m.received_at).toLocaleString()}<br/><b>Subject:</b> ${selectedThread?.subject ?? ''}<br/><br/>${fwdContent}`)
                                setReplyAttachments([]); setReplyAnchorMsgId(m.id); setReplyMode('forward')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><Forward className="w-3.5 h-3.5" /></button>
                            </div>}
                          </header>
                          {isExpanded && (html ? (() => {
                            const { srcDoc, isDark } = buildEmailSrcDoc(sanitized)
                            return (
                              <div style={{ background: isDark ? '#0f0f0f' : '#fff' }}>
                                <iframe title="Email" srcDoc={srcDoc}
                                  className="w-full border-0 rounded-b" sandbox="allow-same-origin allow-popups allow-top-navigation-by-user-activation"
                                  onLoad={e => { const f = e.target as HTMLIFrameElement; if (f.contentDocument?.body) { f.style.height = Math.max(80, f.contentDocument.body.scrollHeight + 20) + 'px' } }}
                                  style={{ minHeight: '80px', background: isDark ? '#0f0f0f' : '#fff' }} />
                              </div>
                            )
                          })() : (
                            <div className="text-sm whitespace-pre-wrap break-words p-4 text-gray-200">{content}</div>
                          ))}
                          {isExpanded && msgAttachments.length > 0 && (
                            <div className="border-t border-border px-4 py-2.5 bg-surface-muted/30">
                              <div className="flex flex-wrap gap-2">
                                {msgAttachments.map((a) => (
                                  <a key={a.id} href={getAttachmentHref(a)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-muted border border-border text-gray-200 hover:text-accent text-xs">
                                    <Download className="w-3.5 h-3.5 shrink-0" /> {a.file_name}
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </article>
                        {/* Render reply form directly below the anchored message */}
                        {replyMode && replyMode !== 'compose' && replyAnchorMsgId === m.id && (
                          <div className="mt-2">{renderReplyForm(replyMode === 'forward')}</div>
                        )}
                      </React.Fragment>)
                    })
                  })()}

                  {/* Fallback: render at bottom if triggered from header buttons (no anchor) */}
                  {replyMode && replyMode !== 'compose' && !replyAnchorMsgId && renderReplyForm(replyMode === 'forward')}
                  <div ref={timelineEndRef} />
                </div>
              </div>

              {/* Comment input */}
              <div className="border-t border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-amber-400 shrink-0" />
                  <div className="flex-1 relative">
                    {!commentText && (
                      <div className="pointer-events-none absolute inset-0 flex items-center px-3 py-1.5 text-sm text-gray-500" aria-hidden>
                        Add an internal comment… (type @ to mention)
                      </div>
                    )}
                    <div
                      ref={commentInputRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={(e) => {
                        const text = (e.target as HTMLDivElement).innerText
                        setCommentText(text)
                        if (text.endsWith('@')) setShowMentionPicker(true)
                        else if (!text.includes('@')) setShowMentionPicker(false)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && commentText.trim()) {
                          e.preventDefault()
                          handleAddComment()
                        }
                      }}
                      className="min-h-[38px] w-full rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    />
                    {showMentionPicker && (
                      <div className="absolute bottom-full left-0 mb-1 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto w-64 z-10">
                        {inboxUsers.map(u => (
                          <button key={u.user_id} type="button" onClick={() => insertMention(u)}
                            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-muted">{u.display_name ?? u.email}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={handleAddComment} disabled={!commentText.trim()}
                    className="px-3 py-1.5 rounded bg-amber-500/20 text-amber-400 text-sm font-medium hover:bg-amber-500/30 disabled:opacity-50">Comment</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
