import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  Inbox as InboxIcon, Mail, MessageSquare, Check, Archive, ArchiveRestore,
  List, ChevronRight, Plus, Reply, ReplyAll, Forward,
  RotateCcw, RefreshCw, Paperclip, Download,
  Search, User, Link2, Pencil, Trash2, FileText, ChevronDown, Mailbox,
} from 'lucide-react'
import EmailComposeForm from '@/components/inbox/EmailComposeForm'
import { sanitizeEmailHtml, buildEmailSrcDoc, prepareDraftHtmlForDisplay, resolveInlineEmailImages } from '@/lib/emailSanitizer'
import { parseMentionUserIds } from '@/lib/mentionUtils'
import {
  isUnavailableBodyText,
  isMessageBodyEmpty,
  type BodyFetchStatus,
} from '@/lib/inboxBodyUnavailable'
import {
  invoiceInboxDraftFailureMessage,
  invoiceInboxDraftToastMessage,
  loadInvoiceInboxDraftPayload,
} from '@/lib/invoiceResendDraft'
import { INVOICE_INBOX_DRAFT_QUERY_PARAMS, type InvoiceInboxDraftKind } from '@/lib/invoiceEmailContent'

type InboxFilter = 'inbox' | 'assigned' | 'closed' | 'trash' | 'all'
type ThreadAssignment = { user_id: string }
type InboxThread = {
  id: string; org_id: string; channel: string; status: string
  subject: string | null; last_message_at: string; created_at: string
  from_address: string | null; imap_account_id: string | null
  mailbox_address: string | null
  inbox_thread_assignments?: ThreadAssignment[] | null
  /** Message count (from mergeInboxMessageCounts / inbox_message_counts_by_thread RPC) */
  inbox_messages?: { count: number }[] | null
  /** True when thread has at least one is_draft inbox_messages row (from search_inbox_threads). */
  has_draft?: boolean
}
type InboxMessage = {
  id: string; thread_id: string; channel: string; direction: string
  from_identifier: string; to_identifier: string | null; cc: string | null
  body: string | null; html_body: string | null; received_at: string
  imap_account_id?: string | null
  external_uid?: number | null
  is_draft?: boolean | null
}
type InboxComment = {
  id: string; thread_id: string; user_id: string; content: string
  mentions: string[] | null; created_at: string; display_name?: string | null; avatar_url?: string | null
}
type Attachment = { id: string; message_id: string | null; thread_id: string; file_name: string; file_path: string; file_size: number | null; content_type: string | null; created_at: string; signedUrl?: string | null }
type TimelineItem = { kind: 'message'; data: InboxMessage; ts: string } | { kind: 'comment'; data: InboxComment; ts: string }
type InboxUser = { user_id: string; display_name: string | null; email: string | null; avatar_url?: string | null }
type ImapAccount = { id: string; email: string; label: string | null; addresses: string[] | null }
type ContactMatch = { contact_id: string; name: string; email: string | null }
type InvoiceOption = { id: string; prefix: string | null; number: number | null; status: string; companyName?: string | null }
type ThreadInvoiceLink = { invoice_id: string; invoice: InvoiceOption | null }
type ReadStatus = { thread_id: string; last_read_at: string }
type SearchInboxThreadRow = Omit<InboxThread, 'inbox_thread_assignments' | 'inbox_messages'> & {
  inbox_thread_assignments: ThreadAssignment[] | null
  message_count: number | string | null
  has_draft?: boolean | null
}

/** PostgREST list select without embedded inbox_messages(count) — counts come from inbox_message_counts_by_thread RPC. */
const INBOX_THREAD_LIST_SELECT =
  'id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, mailbox_address, inbox_thread_assignments(user_id)' as const

const INBOX_THREAD_ACTION_BTN_CLASS =
  'inline-flex items-center shrink-0 gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-50 disabled:cursor-not-allowed'

const INBOX_THREAD_ACTION_SELECT_CLASS =
  'h-auto min-h-0 appearance-none cursor-pointer bg-none [background-image:none] pr-6 max-w-[168px] truncate'

/** Single grouped count query (RLS on inbox_messages); avoids slow embedded aggregates that can 504. */
async function mergeInboxMessageCounts(threads: InboxThread[]): Promise<InboxThread[]> {
  if (threads.length === 0) return threads
  const { data: countRows, error } = await supabase.rpc('inbox_message_counts_by_thread', {
    p_thread_ids: threads.map((t) => t.id),
  })
  if (error) {
    console.warn('[Inbox] inbox_message_counts_by_thread:', error.message)
    return threads.map((t) => ({ ...t, inbox_messages: [{ count: 1 }] }))
  }
  const map = new Map(
    (countRows as { thread_id: string; msg_count: number | string }[]).map((r) => [r.thread_id, Number(r.msg_count)]),
  )
  return threads.map((t) => ({ ...t, inbox_messages: [{ count: map.get(t.id) ?? 0 }] }))
}

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

function stripHtmlToText(html: string, maxLen: number): string {
  const t = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen)}…`
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

function formatInvoiceNumber(inv: { prefix: string | null; number: number | null }): string {
  const prefix = (inv.prefix ?? 'INV-').replace(/-+$/, '')
  return inv.number ? `${prefix}-${String(inv.number).padStart(4, '0')}` : 'Invoice'
}

export default function Inbox() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const { threadId: urlThreadId } = useParams<{ threadId?: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
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
      .select(INBOX_THREAD_LIST_SELECT)
      .eq('id', selectedThreadId).eq('org_id', currentOrg.id).single()
      .then(async ({ data, error }) => {
        if (error || !data) {
          setSelectedThreadFallback(null)
          return
        }
        const merged = await mergeInboxMessageCounts([data as InboxThread])
        setSelectedThreadFallback(merged[0] ?? null)
      }, () => setSelectedThreadFallback(null))
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

  // Update browser URL when thread selection changes (preserve query params e.g. invoice draft deep links)
  useEffect(() => {
    const currentPath = window.location.pathname
    const targetPath = selectedThreadId ? `/inbox/${selectedThreadId}` : '/inbox'
    if (currentPath !== targetPath) {
      console.log('[Inbox:nav] navigate()', { from: currentPath, to: targetPath, selectedThreadId })
      navigate({ pathname: targetPath, search: window.location.search }, { replace: true })
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
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [mailboxFilterId, setMailboxFilterId] = useState<string | null>(null)
  const [mailboxFilterOpen, setMailboxFilterOpen] = useState(false)
  const [hasMoreThreads, setHasMoreThreads] = useState(false)
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false)

  // Read tracking
  const [readStatuses, setReadStatuses] = useState<ReadStatus[]>([])

  // Reply
  const [replyMode, setReplyMode] = useState<'reply' | 'reply_all' | 'forward' | 'compose' | null>(null)
  const [replyAnchorMsgId, setReplyAnchorMsgId] = useState<string | null>(null)
  /** When set, compose replaces that draft bubble (edit/save flow). Cleared on cancel/send. */
  const [draftMessageId, setDraftMessageId] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState('')
  const [replyCc, setReplyCc] = useState('')
  const [replyBcc, setReplyBcc] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [replyHtml, setReplyHtml] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [selectedFromAddress, setSelectedFromAddress] = useState('')
  const [replyAttachments, setReplyAttachments] = useState<File[]>([])
  const [savingDraft, setSavingDraft] = useState(false)

  // Comment
  const [commentText, setCommentText] = useState('')
  const [showMentionPicker, setShowMentionPicker] = useState(false)
  const commentInputRef = useRef<HTMLDivElement>(null)
  const commentProgrammaticRef = useRef(false)

  // Contacts, invoice links, attachments, all contacts for autocomplete
  const [threadContacts, setThreadContacts] = useState<ContactMatch[]>([])
  const [threadInvoiceLinks, setThreadInvoiceLinks] = useState<ThreadInvoiceLink[]>([])
  const [invoiceOptions, setInvoiceOptions] = useState<InvoiceOption[]>([])
  const [allContacts, setAllContacts] = useState<{ id: string; name: string; email: string | null }[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toSuggestions, setToSuggestions] = useState<{ name: string; email: string }[]>([])
  const [showToSuggestions, setShowToSuggestions] = useState(false)

  // Drag state
  const [isDragging, setIsDragging] = useState(false)
  const [imapReloadingId, setImapReloadingId] = useState<string | null>(null)
  const [bodyFetchStatus, setBodyFetchStatus] = useState<Record<string, BodyFetchStatus>>({})

  // Assign popover (multi-select)
  const [showAssignPopover, setShowAssignPopover] = useState(false)
  const [selectedAssignUserIds, setSelectedAssignUserIds] = useState<Set<string>>(new Set())
  const [showLinkInvoicePicker, setShowLinkInvoicePicker] = useState(false)

  const userId = user?.id ?? null
  const timelineEndRef = useRef<HTMLDivElement>(null)
  const draftMessageIdRef = useRef<string | null>(null)
  const sendingReplyRef = useRef(false)
  const outboundEmptyWarnedKeyRef = useRef<string | null>(null)
  /** Per-thread guard: draft reconciliation via fetch-thread-bodies runs once per thread load unless bodies are empty. */
  const draftReconcileDoneForThreadRef = useRef<string | null>(null)
  /** Per-thread guard: phantom outbound (misclassified Gmail draft) heal via fetch-thread-bodies. */
  const phantomHealDoneForThreadRef = useRef<string | null>(null)
  /** When set (from /inbox?compose=1&leadId=...), a successful send logs a lead_attempt for that lead. */
  const leadComposeContextRef = useRef<{ leadId: string; contactId: string | null } | null>(null)
  /** When set (from /inbox/:threadId?resendInvoice=... or ?followUpInvoice=...), a successful send updates invoice email_sent_at. */
  const invoiceInboxDraftContextRef = useRef<{ invoiceId: string } | null>(null)
  const invoiceInboxDraftProcessedRef = useRef<string | null>(null)
  const invoiceInboxDraftExpandIdRef = useRef<string | null>(null)

  const looksLikeHtml = (t: string | null) => t != null && /<\s*(html|div|p|table|body|span)[\s>]/i.test(t)
  const decodeQP = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

  const cleanMessageBody = (
    msg: InboxMessage,
    fetchStatus?: BodyFetchStatus | null,
  ): { html: boolean; content: string; loading?: boolean; failed?: boolean; unavailable?: boolean } => {
    if (msg.html_body?.trim()) return { html: true, content: msg.html_body }
    const body = msg.body
    if (isUnavailableBodyText(body)) {
      return { html: false, content: body!.trim(), unavailable: true }
    }
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
          fetchStatus: fetchStatus ?? null,
        },
        msg.thread_id,
      )
      if (fetchStatus === 'loading') return { html: false, content: 'Downloading message...', loading: true }
      if (fetchStatus === 'failed') return { html: false, content: 'Could not load message body.', failed: true }
      if (fetchStatus === 'unavailable') return { html: false, content: body?.trim() || 'Message is no longer available on the mail server.', unavailable: true }
      if (!msg.imap_account_id || msg.external_uid == null) {
        return { html: false, content: 'Message body is not available for this message.', failed: true }
      }
      return { html: false, content: 'Downloading message...', loading: true }
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

  const syncBodyFetchStatus = useCallback((
    msgs: InboxMessage[],
    bodyMap: Map<string, { body: string | null; html_body: string | null; bodyUnavailable?: boolean }>,
    deletedIds: Set<string>,
    options?: { fetchFailed?: boolean; pendingMore?: boolean },
  ) => {
    setBodyFetchStatus((prev) => {
      const next = { ...prev }
      for (const m of msgs) {
        if (deletedIds.has(m.id)) {
          delete next[m.id]
          continue
        }
        const entry = bodyMap.get(m.id)
        const bodyVal = entry ? (entry.body ?? m.body) : m.body
        const htmlVal = entry ? (entry.html_body ?? m.html_body) : m.html_body
        if (entry?.bodyUnavailable || isUnavailableBodyText(bodyVal)) {
          next[m.id] = 'unavailable'
        } else if (isMessageBodyEmpty(bodyVal, htmlVal)) {
          if (options?.pendingMore) next[m.id] = 'loading'
          else next[m.id] = 'failed'
        } else {
          delete next[m.id]
        }
      }
      if (options?.fetchFailed) {
        for (const m of msgs) {
          if (deletedIds.has(m.id)) continue
          const entry = bodyMap.get(m.id)
          const bodyVal = entry ? (entry.body ?? m.body) : m.body
          const htmlVal = entry ? (entry.html_body ?? m.html_body) : m.html_body
          if (isMessageBodyEmpty(bodyVal, htmlVal) && !isUnavailableBodyText(bodyVal)) {
            next[m.id] = 'failed'
          }
        }
      }
      return next
    })
  }, [])

  const markMessagesBodyLoading = useCallback((msgs: InboxMessage[]) => {
    setBodyFetchStatus((prev) => {
      const next = { ...prev }
      for (const m of msgs) {
        if (isMessageBodyEmpty(m.body, m.html_body)) next[m.id] = 'loading'
      }
      return next
    })
  }, [])

  const timeline: TimelineItem[] = [
    ...messages.map(m => ({ kind: 'message' as const, data: m, ts: m.received_at })),
    ...comments.map(c => ({ kind: 'comment' as const, data: c, ts: c.created_at })),
  ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())

  const mapSearchInboxRows = (rows: SearchInboxThreadRow[]): InboxThread[] => rows.map((row) => ({
    id: row.id,
    org_id: row.org_id,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    from_address: row.from_address,
    imap_account_id: row.imap_account_id,
    mailbox_address: row.mailbox_address,
    inbox_thread_assignments: Array.isArray(row.inbox_thread_assignments) ? row.inbox_thread_assignments : [],
    inbox_messages: [{ count: Number(row.message_count ?? 0) }],
    has_draft: !!row.has_draft,
  }))

  const initialLoadDone = useRef(false)
  const fetchFilterRef = useRef<InboxFilter>(filter)
  const fetchMailboxFilterRef = useRef<string | null>(mailboxFilterId)

  // Data fetching — paginated and server-side searchable so older/unloaded threads can be found.
  const fetchThreadsPage = useCallback(async (offset = 0, append = false) => {
    fetchFilterRef.current = filter
    fetchMailboxFilterRef.current = mailboxFilterId
    if (!currentOrg?.id || !userId) {
      debugLog('fetchThreads', { event: 'SKIP', orgId: currentOrg?.id, userId })
      return
    }
    if (append) setLoadingMoreThreads(true)
    else if (!initialLoadDone.current) setLoading(true)
    try {
      const query = searchQuery.trim()
      debugLog('fetchThreads', { event: 'START', orgId: currentOrg.id, userId, filter, mailboxFilterId, pageSize, offset, append, query })

      const { data, error } = await supabase.rpc('search_inbox_threads', {
        p_org_id: currentOrg.id,
        p_user_id: userId,
        p_filter: filter,
        p_query: query || null,
        p_limit: pageSize,
        p_offset: offset,
        p_imap_account_id: mailboxFilterId,
      })

      if (error) {
        console.error('[Inbox] search_inbox_threads failed:', error.message, error)
        debugLog('fetchThreads', { event: 'ERROR_rpc', error: error.message })
        if (!append) setThreads([])
        setHasMoreThreads(false)
        return
      }

      const result = mapSearchInboxRows((data as SearchInboxThreadRow[]) ?? [])
      const hasMore = result.length === pageSize
      debugLog('fetchThreads', {
        event: 'DONE',
        count: result.length,
        hasMore,
        offset,
        query: query || null,
        threadIds: result.map(t => t.id),
      })
      if (fetchFilterRef.current !== filter || fetchMailboxFilterRef.current !== mailboxFilterId) {
        debugLog('fetchThreads', {
          event: 'SKIP_stale',
          fetchedFilter: fetchFilterRef.current,
          currentFilter: filter,
          fetchedMailboxFilterId: fetchMailboxFilterRef.current,
          currentMailboxFilterId: mailboxFilterId,
        })
        return
      }

      setThreads(prev => {
        if (!append) return result
        const seen = new Set(prev.map(t => t.id))
        return [...prev, ...result.filter(t => !seen.has(t.id))]
      })
      setHasMoreThreads(hasMore)
      initialLoadDone.current = true
    } catch (e) {
      debugLog('fetchThreads', { event: 'ERROR', error: String(e) })
      if (!append && fetchFilterRef.current === filter && fetchMailboxFilterRef.current === mailboxFilterId && !initialLoadDone.current) setThreads([])
      setHasMoreThreads(false)
    } finally {
      if (append) setLoadingMoreThreads(false)
      else setLoading(false)
    }
  }, [currentOrg?.id, filter, mailboxFilterId, userId, debugLog, pageSize, searchQuery])

  const fetchThreads = useCallback(() => fetchThreadsPage(0, false), [fetchThreadsPage])

  const loadOlderThreads = useCallback(() => {
    if (loadingMoreThreads || !hasMoreThreads) return
    void fetchThreadsPage(threads.length, true)
  }, [fetchThreadsPage, hasMoreThreads, loadingMoreThreads, threads.length])

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

  const clearComposeIfDraftDeleted = useCallback((deletedIds: Set<string>) => {
    const editingDraftId = draftMessageIdRef.current
    if (!editingDraftId || !deletedIds.has(editingDraftId)) return
    setDraftMessageId(null)
    setReplyMode(null)
    setReplyAnchorMsgId(null)
    setReplyHtml('')
    setReplyAttachments([])
  }, [])

  const fetchMessages = useCallback(async (tid: string, options?: { background?: boolean }) => {
    const background = options?.background ?? false
    debugLog('fetchMessages', { event: 'START', threadId: tid, background }, tid)
    if (!background) setMessagesLoading(true)
    let msgs: InboxMessage[] = []
    const { data, error: queryError } = await supabase.from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, cc, body, html_body, received_at, imap_account_id, external_uid, is_draft')
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
              body: JSON.stringify({ orgId: thread.org_id, accountId, backfillForThread: tid, backfillOnly: true, backfillSentForThread: true }),
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
    if (!background) setMessagesLoading(false)

    const expandDraftId = invoiceInboxDraftExpandIdRef.current
    if (expandDraftId && msgs.some((m) => m.id === expandDraftId)) {
      setExpandedMsgs((prev) => new Set([...prev, expandDraftId]))
      setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } else if (!background) {
      setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }

    // Mark as read
    if (userId) {
      await supabase.from('inbox_thread_reads').upsert({ thread_id: tid, user_id: userId, last_read_at: new Date().toISOString() }, { onConflict: 'thread_id,user_id' })
    }

    // Lazy-load bodies from IMAP when rows lack body/html, or reconcile DB drafts against provider Drafts mailbox
    if (msgs.length > 0) {
      const emptyBeforeBodies = msgs.filter(m => isMessageBodyEmpty(m.body, m.html_body))
      const hasDraftRows = msgs.some(m => m.is_draft)
      const mayHavePhantomOutbound = !hasDraftRows && msgs.some(m => m.direction === 'outbound' && !m.is_draft && m.external_uid != null)
      const needsBodyFetch = emptyBeforeBodies.length > 0
      const needsDraftReconcile = hasDraftRows && draftReconcileDoneForThreadRef.current !== tid
      const needsPhantomHeal = mayHavePhantomOutbound && phantomHealDoneForThreadRef.current !== tid
      if (!needsBodyFetch && !needsDraftReconcile && !needsPhantomHeal) {
        debugLog('fetchMessages', { event: 'SKIP_fetch_thread_bodies', reason: hasDraftRows ? 'draft_reconcile_already_done' : needsPhantomHeal ? 'phantom_heal_done' : 'all_bodies_in_db_no_drafts', messageCount: msgs.length }, tid)
      } else {
        if (hasDraftRows) draftReconcileDoneForThreadRef.current = tid
        if (needsPhantomHeal) phantomHealDoneForThreadRef.current = tid
        debugLog('fetchMessages', { event: needsBodyFetch ? 'empty_bodies_before_fetch' : needsPhantomHeal ? 'phantom_heal_before_fetch' : 'draft_reconcile_before_fetch', messageIds: emptyBeforeBodies.map(m => m.id), draftCount: msgs.filter(m => m.is_draft).length, count: emptyBeforeBodies.length }, tid)
        if (needsBodyFetch) markMessagesBodyLoading(msgs)
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          try {
            const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-thread-bodies`
            const t0 = performance.now()
            console.log('[Inbox:fetch-thread-bodies] calling', { threadId: tid, messageCount: msgs.length, emptyCount: emptyBeforeBodies.length, draftCount: msgs.filter(m => m.is_draft).length })
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
              body: JSON.stringify({ threadId: tid }),
            })
            const elapsed = Math.round(performance.now() - t0)
            const result = await res.json().catch(() => ({}))
            console.log('[Inbox:fetch-thread-bodies] response', { threadId: tid, elapsedMs: elapsed, status: res.status, ok: res.ok, messageCount: result.messages?.length ?? 0, deletedCount: result.deletedMessageIds?.length ?? 0, hasMore: result.hasMore, error: result.error })
            debugLog('fetchMessages', { event: 'fetch_thread_bodies_response', elapsedMs: elapsed, status: res.status, ok: res.ok, messageCount: result.messages?.length ?? 0, deletedCount: result.deletedMessageIds?.length ?? 0, hasMore: result.hasMore, error: result.error, bodies: (result.messages ?? []).map((m: { id: string; body?: string | null; htmlBody?: string | null }) => ({ id: m.id, hasBody: !!(m.body?.trim()), hasHtmlBody: !!(m.htmlBody?.trim()) })) }, tid)
            if (!res.ok) {
              console.warn('[Inbox] fetch-thread-bodies HTTP error', { threadId: tid, status: res.status, error: (result as { error?: string }).error })
              debugLog('fetchMessages', { event: 'fetch_thread_bodies_http_error', status: res.status, error: (result as { error?: string }).error }, tid)
            }
            const deletedIds = new Set<string>((result.deletedMessageIds ?? []) as string[])
            type BodyEntry = {
              body: string | null
              html_body: string | null
              from_identifier?: string | null
              to_identifier?: string | null
              cc?: string | null
              is_draft?: boolean | null
              bodyUnavailable?: boolean
            }
            const bodyMap = new Map<string, BodyEntry>((result.messages ?? []).map((r: { id: string; body: string | null; htmlBody: string | null; isDraft?: boolean; from_identifier?: string | null; to_identifier?: string | null; cc?: string | null; bodyUnavailable?: boolean }) => [r.id, {
              body: r.body,
              html_body: r.htmlBody,
              from_identifier: r.from_identifier,
              to_identifier: r.to_identifier,
              cc: r.cc,
              is_draft: r.isDraft ?? undefined,
              bodyUnavailable: r.bodyUnavailable,
            }]))
            if (result.messages?.length || deletedIds.size > 0 || !res.ok) {
              if (selectedThreadIdRef.current !== tid) return // user switched thread, don't update
              clearComposeIfDraftDeleted(deletedIds)
              const stillEmptyAfter = msgs.filter((pm) => {
                if (deletedIds.has(pm.id)) return false
                const b = bodyMap.get(pm.id)
                const bodyVal = b ? (b.body ?? pm.body) : pm.body
                const htmlVal = b ? (b.html_body ?? pm.html_body) : pm.html_body
                return isMessageBodyEmpty(bodyVal, htmlVal)
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
              syncBodyFetchStatus(msgs, bodyMap, deletedIds, { fetchFailed: !res.ok, pendingMore: !!result.hasMore })
              setMessages(prev => {
                const merged = prev
                  .filter(pm => !deletedIds.has(pm.id))
                  .map(pm => {
                    const b = bodyMap.get(pm.id)
                    if (!b) return pm
                    return {
                      ...pm,
                      body: b.body ?? pm.body,
                      html_body: b.html_body ?? pm.html_body,
                      from_identifier: b.from_identifier ?? pm.from_identifier,
                      to_identifier: b.to_identifier ?? pm.to_identifier,
                      cc: b.cc ?? pm.cc,
                      is_draft: b.is_draft != null ? b.is_draft : pm.is_draft,
                    }
                  })
                return merged.sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime())
              })
              fetchAttachments(tid)
              if (result.hasMore) {
                const retry = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY }, body: JSON.stringify({ threadId: tid }) })
                  .then(async (res) => {
                    const payload = await res.json().catch(() => ({}))
                    return { res, payload }
                  })
                  .then(({ res, payload: r }) => {
                    if (selectedThreadIdRef.current !== tid) return // user switched thread, cancel retries
                    const retryDeleted = new Set<string>((r.deletedMessageIds ?? []) as string[])
                    if (r.messages?.length || retryDeleted.size > 0 || !res.ok) {
                      clearComposeIfDraftDeleted(retryDeleted)
                      const m = new Map<string, BodyEntry>((r.messages ?? []).map((x: { id: string; body: string | null; htmlBody: string | null; from_identifier?: string | null; to_identifier?: string | null; cc?: string | null; bodyUnavailable?: boolean }) => [x.id, {
                        body: x.body,
                        html_body: x.htmlBody,
                        from_identifier: x.from_identifier,
                        to_identifier: x.to_identifier,
                        cc: x.cc,
                        bodyUnavailable: x.bodyUnavailable,
                      }]))
                      syncBodyFetchStatus(msgs, m, retryDeleted, { fetchFailed: !res.ok, pendingMore: !!r.hasMore })
                      setMessages(prev2 => prev2
                        .filter(p => !retryDeleted.has(p.id))
                        .map(p => {
                          const entry = m.get(p.id)
                          if (!entry) return p
                          return {
                            ...p,
                            body: entry.body ?? p.body,
                            html_body: entry.html_body ?? p.html_body,
                            from_identifier: entry.from_identifier ?? p.from_identifier,
                            to_identifier: entry.to_identifier ?? p.to_identifier,
                            cc: entry.cc ?? p.cc,
                          }
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
            syncBodyFetchStatus(msgs, new Map(), new Set(), { fetchFailed: true })
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
  }, [userId, fetchAttachments, debugLog, clearComposeIfDraftDeleted, markMessagesBodyLoading, syncBodyFetchStatus])

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

  const fetchThreadInvoiceLinks = useCallback(async (tid: string) => {
    const { data } = await supabase
      .from('inbox_thread_invoices')
      .select('invoice_id, invoices(id, prefix, number, status, companies(name))')
      .eq('thread_id', tid)
      .order('created_at', { ascending: false })
    setThreadInvoiceLinks((data ?? []).map((r: { invoice_id: string; invoices: { id: string; prefix: string | null; number: number | null; status: string; companies?: { name: string | null } | { name: string | null }[] | null } | { id: string; prefix: string | null; number: number | null; status: string; companies?: { name: string | null } | { name: string | null }[] | null }[] | null }) => {
      const inv = Array.isArray(r.invoices) ? r.invoices[0] : r.invoices
      const company = inv?.companies ? (Array.isArray(inv.companies) ? inv.companies[0] : inv.companies) : null
      return {
        invoice_id: r.invoice_id,
        invoice: inv ? { id: inv.id, prefix: inv.prefix, number: inv.number, status: inv.status, companyName: company?.name ?? null } : null,
      }
    }))
  }, [])

  // Load inbox users, accounts, all contacts, invoice options, read statuses
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
        if (accs.length > 0 && !selectedFromAddress) setSelectedFromAddress(accs[0].email)
      })
    supabase.from('contacts').select('id, name, email').eq('org_id', currentOrg.id).order('name')
      .then(({ data }) => setAllContacts((data as { id: string; name: string; email: string | null }[]) ?? []))
    supabase.from('invoices').select('id, prefix, number, status, companies(name)').eq('org_id', currentOrg.id).eq('direction', 'outbound').order('created_at', { ascending: false }).limit(200)
      .then(({ data }) => setInvoiceOptions(((data ?? []) as { id: string; prefix: string | null; number: number | null; status: string; companies?: { name: string | null } | { name: string | null }[] | null }[]).map((inv) => {
        const company = inv.companies ? (Array.isArray(inv.companies) ? inv.companies[0] : inv.companies) : null
        return { id: inv.id, prefix: inv.prefix, number: inv.number, status: inv.status, companyName: company?.name ?? null }
      })))
  }, [currentOrg?.id, selectedAccountId, selectedFromAddress])

  useEffect(() => {
    setMailboxFilterId(null)
    setMailboxFilterOpen(false)
  }, [currentOrg?.id])

  useEffect(() => {
    if (!userId) return
    supabase.from('inbox_thread_reads').select('thread_id, last_read_at').eq('user_id', userId)
      .then(({ data }) => setReadStatuses((data as ReadStatus[]) ?? []))
  }, [userId])

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => { fetchThreads() }, [fetchThreads])

  // Close assign / link-invoice UI when thread changes
  useEffect(() => {
    setShowAssignPopover(false)
    setShowLinkInvoicePicker(false)
  }, [selectedThreadId])

  // Refs for stable realtime callbacks (avoids channel teardown on every state change)
  const selectedThreadIdRef = useRef(selectedThreadId)
  const fetchThreadsRef = useRef(fetchThreads)
  const fetchMessagesRef = useRef(fetchMessages)
  const fetchCommentsRef = useRef(fetchComments)
  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])
  useEffect(() => { draftMessageIdRef.current = draftMessageId }, [draftMessageId])
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
          fetchMessagesRef.current(selectedThreadIdRef.current, { background: true })
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'inbox_messages',
      }, (payload) => {
        const tid = (payload.new as { thread_id: string }).thread_id
        debugLogRef.current('realtime', { event: 'inbox_messages_INSERT', threadId: tid, payload }, tid)
        fetchThreadsRef.current()
        if (tid === selectedThreadIdRef.current) {
          fetchMessagesRef.current(selectedThreadIdRef.current, { background: true })
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'inbox_messages',
      }, (payload) => {
        const tid = ((payload.new as { thread_id?: string })?.thread_id
          ?? (payload.old as { thread_id?: string })?.thread_id) as string | undefined
        debugLogRef.current('realtime', { event: 'inbox_messages_UPDATE', threadId: tid, payload }, tid)
        fetchThreadsRef.current()
        if (tid && tid === selectedThreadIdRef.current) {
          fetchMessagesRef.current(selectedThreadIdRef.current, { background: true })
        }
      })
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public', table: 'inbox_messages',
      }, (payload) => {
        const tid = (payload.old as { thread_id?: string }).thread_id
        debugLogRef.current('realtime', { event: 'inbox_messages_DELETE', threadId: tid, payload }, tid)
        fetchThreadsRef.current()
        if (tid && tid === selectedThreadIdRef.current) {
          fetchMessagesRef.current(selectedThreadIdRef.current, { background: true })
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
    invoiceInboxDraftProcessedRef.current = null
    invoiceInboxDraftExpandIdRef.current = null
  }, [selectedThreadId])

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]); setComments([]); setThreadContacts([]); setThreadInvoiceLinks([]); setAttachments([]); setReplyMode(null); setDraftMessageId(null); setExpandedMsgs(new Set()); setBodyFetchStatus({}); draftReconcileDoneForThreadRef.current = null; phantomHealDoneForThreadRef.current = null; return
    }
    debugLog('selectThread', { selectedThreadId, filter }, selectedThreadId ?? undefined)
    setExpandedMsgs(new Set()) // Reset accordion on thread change
    setBodyFetchStatus({})
    draftReconcileDoneForThreadRef.current = null
    phantomHealDoneForThreadRef.current = null
    // Use ref so this effect does not re-run when fetchMessages identity changes (e.g. debugLog after auth/org hydrate) — avoids duplicate fetch-thread-bodies
    fetchMessagesRef.current(selectedThreadId)
    fetchComments(selectedThreadId)
    fetchThreadContacts(selectedThreadId)
    fetchThreadInvoiceLinks(selectedThreadId)
    fetchAttachments(selectedThreadId)
    supabase.rpc('match_thread_contacts', { p_thread_id: selectedThreadId }).then(() => fetchThreadContacts(selectedThreadId))
  }, [selectedThreadId, fetchComments, fetchThreadContacts, fetchThreadInvoiceLinks, fetchAttachments, debugLog])

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

  useEffect(() => {
    let draftKind: InvoiceInboxDraftKind | null = null
    let invoiceId: string | null = null
    for (const kind of Object.keys(INVOICE_INBOX_DRAFT_QUERY_PARAMS) as InvoiceInboxDraftKind[]) {
      const param = searchParams.get(INVOICE_INBOX_DRAFT_QUERY_PARAMS[kind])
      if (param) {
        draftKind = kind
        invoiceId = param
        break
      }
    }
    if (!draftKind || !invoiceId || !selectedThreadId || !currentOrg?.id || messagesLoading) return
    if (imapAccounts.length === 0) return

    const processKey = `${draftKind}:${selectedThreadId}:${invoiceId}`
    if (invoiceInboxDraftProcessedRef.current === processKey) return

    let cancelled = false

    void (async () => {
      const { payload, error } = await loadInvoiceInboxDraftPayload(invoiceId!, currentOrg.id, draftKind!)
      if (cancelled) return

      const clearDraftParam = () => {
        const next = new URLSearchParams(searchParams)
        next.delete(INVOICE_INBOX_DRAFT_QUERY_PARAMS[draftKind!])
        setSearchParams(next, { replace: true })
      }

      if (error || !payload) {
        invoiceInboxDraftProcessedRef.current = processKey
        toast(error ?? invoiceInboxDraftFailureMessage(draftKind!))
        clearDraftParam()
        return
      }

      const thread = threads.find((t) => t.id === selectedThreadId) ?? selectedThreadFallback
      let fromAddress: { accountId: string; email: string } | null = null
      const mailbox = thread?.mailbox_address?.trim().toLowerCase()
      if (mailbox) {
        for (const acc of imapAccounts) {
          if (acc.email.trim().toLowerCase() === mailbox) {
            fromAddress = { accountId: acc.id, email: acc.email.trim() }
            break
          }
          for (const alias of acc.addresses ?? []) {
            if (alias.trim().toLowerCase() === mailbox) {
              fromAddress = { accountId: acc.id, email: alias.trim() }
              break
            }
          }
          if (fromAddress) break
        }
      }
      if (!fromAddress && thread?.imap_account_id) {
        const acc = imapAccounts.find((a) => a.id === thread.imap_account_id)
        if (acc) fromAddress = { accountId: acc.id, email: acc.email.trim() }
      }
      if (!fromAddress && imapAccounts[0]) {
        fromAddress = { accountId: imapAccounts[0].id, email: imapAccounts[0].email.trim() }
      }
      if (!fromAddress) {
        invoiceInboxDraftProcessedRef.current = processKey
        toast('No active inbox email account is available for this invoice draft.')
        clearDraftParam()
        return
      }

      const now = new Date().toISOString()
      await supabase.from('inbox_threads').update({
        subject: payload.subject,
        last_message_at: now,
        updated_at: now,
      }).eq('id', selectedThreadId)

      const draftPayload = {
        thread_id: selectedThreadId,
        channel: 'email' as const,
        direction: 'outbound' as const,
        from_identifier: fromAddress.email,
        to_identifier: payload.to,
        cc: null,
        html_body: payload.html,
        body: stripHtmlToText(payload.html, 100_000),
        is_draft: true,
        imap_account_id: fromAddress.accountId,
        received_at: now,
      }

      const existingDraft = messages.find((m) => m.is_draft)
      let savedDraft: InboxMessage | null = null
      if (existingDraft) {
        const { data, error: updateErr } = await supabase
          .from('inbox_messages')
          .update(draftPayload)
          .eq('id', existingDraft.id)
          .select()
          .single()
        if (cancelled) return
        if (updateErr || !data) {
          invoiceInboxDraftProcessedRef.current = processKey
          toast(updateErr?.message ?? `Could not update invoice ${draftKind === 'overdue_followup' ? 'follow-up' : 'resend'} draft`)
          clearDraftParam()
          return
        }
        savedDraft = data as InboxMessage
        setMessages((prev) => prev.map((m) => (m.id === existingDraft.id ? savedDraft! : m)))
      } else {
        const { data, error: insertErr } = await supabase
          .from('inbox_messages')
          .insert(draftPayload)
          .select()
          .single()
        if (cancelled) return
        if (insertErr || !data) {
          invoiceInboxDraftProcessedRef.current = processKey
          toast(insertErr?.message ?? `Could not create invoice ${draftKind === 'overdue_followup' ? 'follow-up' : 'resend'} draft`)
          clearDraftParam()
          return
        }
        savedDraft = data as InboxMessage
        setMessages((prev) => [...prev, savedDraft!])
      }

      invoiceInboxDraftProcessedRef.current = processKey
      invoiceInboxDraftContextRef.current = { invoiceId: payload.invoiceId }
      invoiceInboxDraftExpandIdRef.current = savedDraft!.id
      setExpandedMsgs((prev) => new Set([...prev, savedDraft!.id]))

      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        void fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-save-draft`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ messageId: savedDraft!.id, action: 'save' }),
        }).catch(() => {})
      }

      toast(invoiceInboxDraftToastMessage(payload.kind, Boolean(existingDraft)))
      setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 150)
      clearDraftParam()
    })()

    return () => { cancelled = true }
  }, [
    selectedThreadId,
    currentOrg?.id,
    messagesLoading,
    searchParams,
    setSearchParams,
    threads,
    selectedThreadFallback,
    imapAccounts,
    messages,
  ])

  const isUnread = (t: InboxThread) => {
    const readStatus = readStatuses.find(r => r.thread_id === t.id)
    if (!readStatus) return true
    return new Date(t.last_message_at) > new Date(readStatus.last_read_at)
  }

  const selectedMailboxAccount = useMemo(
    () => (mailboxFilterId ? imapAccounts.find(a => a.id === mailboxFilterId) ?? null : null),
    [imapAccounts, mailboxFilterId],
  )

  // Filter by current tab so we never show trash in All or non-trash in Trash (handles stale threads during filter switch)
  const threadMatchesFilter = (t: InboxThread) => {
    if (mailboxFilterId && t.imap_account_id !== mailboxFilterId) return false
    if (filter === 'trash') return t.status === 'archived'
    if (filter === 'all') return t.status !== 'archived' || !!t.has_draft
    if (filter === 'closed') return t.status === 'closed'
    if (filter === 'inbox') return t.status === 'open'
    if (filter === 'assigned') return t.status === 'open'
    return true
  }

  // Display threads returned by the server-side search/page query; include selectedThreadFallback when not in list so it can be highlighted in sidebar
  const filteredThreads = (() => {
    let base = threads.filter(threadMatchesFilter)
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
      // Assignment transfers Jolo ownership/attention only. Do not archive Gmail here:
      // Jay's inbox-zero rule is that assign-to-user removes the thread from the
      // assigner's Jolo Inbox via assignment filtering, while the underlying Gmail
      // Inbox state remains unchanged until someone explicitly replies/closes/trashes it.
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

  const handleUpdateStatus = async (status: string, opts?: { restoreFromTrash?: boolean }) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    const previousStatus =
      threads.find((t) => t.id === selectedThreadId)?.status ??
      selectedThreadFallback?.status ??
      null
    const now = new Date().toISOString()
    const isRestoreFromTrash =
      status === 'open' && (opts?.restoreFromTrash === true || previousStatus === 'archived')
    const statusUpdate: { status: string; updated_at: string; user_restored_at?: string | null } = {
      status,
      updated_at: now,
    }
    if (status === 'archived') {
      statusUpdate.user_restored_at = null
    } else if (isRestoreFromTrash) {
      statusUpdate.user_restored_at = now
    }
    const { error: statusErr } = await supabase
      .from('inbox_threads')
      .update(statusUpdate)
      .eq('id', selectedThreadId)
    if (!statusErr && status === 'archived' && currentOrg?.id && user?.id) {
      void supabase
        .from('inbox_debug_log')
        .insert({
          user_id: user.id,
          org_id: currentOrg.id,
          thread_id: selectedThreadId,
          tag: 'thread_archived',
          payload: {
            source: 'inbox_ui',
            reason: 'single_thread_trash',
            previous_status: previousStatus,
          },
        })
        .then(({ error: logErr }) => {
          if (logErr) console.warn('[Inbox] thread_archived debug log failed', logErr)
        })
    }

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
      toast(opts?.restoreFromTrash ? 'Restored from trash' : 'Thread re-opened')
    }
  }

  const getMailboxLabel = (thread: InboxThread): string | null => {
    const account = imapAccounts.find(acc => acc.id === thread.imap_account_id)
    if (account?.label && account.email) return `${account.label} <${account.email}>`
    if (account?.email) return account.email
    if (thread.mailbox_address?.trim()) return thread.mailbox_address.trim()
    return null
  }

  const getSendableAddresses = (): { accountId: string; email: string; label: string }[] => {
    const addrs: { accountId: string; email: string; label: string }[] = []
    const seen = new Set<string>()
    for (const acc of imapAccounts) {
      const primary = acc.email.trim()
      if (primary && !seen.has(primary.toLowerCase())) {
        seen.add(primary.toLowerCase())
        addrs.push({ accountId: acc.id, email: primary, label: acc.label ? `${acc.label} <${primary}>` : primary })
      }
      for (const alias of acc.addresses ?? []) {
        const email = alias.trim()
        if (!email || seen.has(email.toLowerCase())) continue
        seen.add(email.toLowerCase())
        addrs.push({ accountId: acc.id, email, label: `${acc.label ?? 'Alias'} <${email}>` })
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

  // Find which sendable address to use based on our address in the last message.
  // Inbound: we're in to_identifier or cc. Outbound: we're in from_identifier.
  const findFromAddressForReply = (lastMsg: InboxMessage): { accountId: string; email: string } | null => {
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
        const accEmails = [acc.email, ...(acc.addresses ?? [])]
        const match = accEmails.find((email) => email.trim().toLowerCase() === addr)
        if (match) return { accountId: acc.id, email: match.trim() }
      }
    }
    const selected = getSendableAddresses().find((a) => a.email.toLowerCase() === selectedFromAddress.toLowerCase())
    return selected ?? null
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
    setDraftMessageId(null)
    if (mode === 'compose') {
      leadComposeContextRef.current = null
      setReplyTo(''); setReplyCc(''); setReplyBcc(''); setReplySubject(''); setReplyHtml(''); setShowCcBcc(false); setReplyAttachments([])
    } else if (selectedThread && messages.length > 0) {
      const last = messages[messages.length - 1]
      const fromAddress = findFromAddressForReply(last)
      if (fromAddress) {
        setSelectedAccountId(fromAddress.accountId)
        setSelectedFromAddress(fromAddress.email)
      }
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

  // Deep link from lead detail: /inbox?compose=1&to=...&leadId=...&contactId=...
  useEffect(() => {
    if (searchParams.get('compose') !== '1') return
    const to = searchParams.get('to')
    if (!to?.trim()) return
    const leadId = searchParams.get('leadId')
    const contactId = searchParams.get('contactId')
    const subject = searchParams.get('subject')

    leadComposeContextRef.current = leadId ? { leadId, contactId: contactId || null } : null
    setSelectedThreadId(null)
    setReplyAnchorMsgId(null)
    setDraftMessageId(null)
    setReplyTo(decodeURIComponent(to.trim()))
    setReplyCc('')
    setReplyBcc('')
    setShowCcBcc(false)
    setReplySubject(subject ? decodeURIComponent(subject) : '')
    setReplyHtml('')
    setReplyAttachments([])
    setReplyMode('compose')

    const next = new URLSearchParams(searchParams)
    ;['compose', 'to', 'leadId', 'contactId', 'subject'].forEach((k) => next.delete(k))
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

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
    const draftIdToRemove = draftMessageId
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
    const selectedSendable = getSendableAddresses().find((a) => a.email.toLowerCase() === selectedFromAddress.toLowerCase())
      ?? getSendableAddresses().find((a) => a.accountId === selectedAccountId)
    const payload: Record<string, unknown> = {
      body: bodyForApi, subject: replySubject, to: replyTo.trim(),
      cc: replyCc.trim() || undefined, bcc: replyBcc.trim() || undefined,
      isHtml: true, accountId: selectedSendable?.accountId || selectedAccountId || undefined,
      fromAddress: selectedSendable?.email || selectedFromAddress || undefined,
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

    const sentThreadId = selectedThreadId
    const draftMsg = draftIdToRemove ? messages.find((msg) => msg.id === draftIdToRemove) : undefined
    const draftExternalUid = draftMsg?.external_uid ?? null
    const draftImapAccountId = draftMsg?.imap_account_id ?? null

    if (draftIdToRemove) {
      const { error: delErr } = await supabase.from('inbox_messages').delete().eq('id', draftIdToRemove)
      if (delErr) console.warn('[Inbox] failed to delete draft after send:', delErr.message)
      else setMessages(prev => prev.filter(msg => msg.id !== draftIdToRemove))
      if (draftExternalUid != null && draftImapAccountId) {
        void syncDraftOnServer(draftIdToRemove, 'delete', {
          externalUid: draftExternalUid,
          imapAccountId: draftImapAccountId,
        })
      }
    }
    if (sentThreadId) {
      const { error: ghostErr } = await supabase.from('inbox_messages').delete().eq('thread_id', sentThreadId).eq('is_draft', true)
      if (ghostErr) console.warn('[Inbox] failed to clear ghost drafts after send:', ghostErr.message)
      else setMessages(prev => prev.filter(msg => !msg.is_draft))
    }

    const leadCtx = leadComposeContextRef.current
    if (leadCtx?.leadId && currentOrg?.id && replyMode === 'compose') {
      leadComposeContextRef.current = null
      const { data: userForAttempt } = await supabase.auth.getUser()
      const attemptUserId = userForAttempt?.user?.id ?? null
      const bodyText = stripHtmlToText(replyHtml, 6000)
      const summary = [replySubject.trim() && `Subject: ${replySubject.trim()}`, bodyText].filter(Boolean).join('\n\n')
      await supabase.from('lead_attempts').insert({
        lead_id: leadCtx.leadId,
        org_id: currentOrg.id,
        contact_id: leadCtx.contactId,
        attempt_type: 'email_outreach',
        channel: 'email',
        status: 'completed',
        subject: replySubject.trim() || null,
        content: summary || null,
        attempted_at: new Date().toISOString(),
        created_by: attemptUserId,
      })
      await supabase
        .from('leads')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('id', leadCtx.leadId)
        .eq('org_id', currentOrg.id)
    }

    const invoiceInboxDraftCtx = invoiceInboxDraftContextRef.current
    if (invoiceInboxDraftCtx?.invoiceId && sentThreadId) {
      invoiceInboxDraftContextRef.current = null
      const sentUpdate: Record<string, string> = {
        updated_at: new Date().toISOString(),
        email_sent_at: new Date().toISOString(),
        email_sent_thread_id: sentThreadId,
      }
      await supabase.from('invoices').update(sentUpdate).eq('id', invoiceInboxDraftCtx.invoiceId)
      if (userId) {
        await supabase
          .from('inbox_thread_invoices')
          .upsert(
            { thread_id: sentThreadId, invoice_id: invoiceInboxDraftCtx.invoiceId, created_by: userId },
            { onConflict: 'thread_id,invoice_id' },
          )
      }
    }

    const sentThreadIdForAdvance = sentThreadId
    const shouldAdvanceSelection = !!sentThreadIdForAdvance && replyMode !== 'compose' && (filter === 'inbox' || filter === 'assigned')
    if (sentThreadIdForAdvance && replyMode !== 'compose') {
      setThreads(prev => prev.map(t => t.id === sentThreadIdForAdvance ? { ...t, status: 'closed' } : t))
      // Replying is an inbox-zero action: close the Jolo thread and archive the
      // underlying Gmail/IMAP thread so it leaves the mail provider Inbox while
      // remaining available on the server.
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-flag-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ threadId: sentThreadIdForAdvance, action: 'archive' }),
      }).catch(() => {})
    }

    if (shouldAdvanceSelection && sentThreadIdForAdvance) {
      const visible = threads
      const idx = visible.findIndex(t => t.id === sentThreadIdForAdvance)
      const next = idx >= 0
        ? (visible[idx + 1] ?? visible[idx - 1] ?? null)
        : null
      setSelectedThreadId(next?.id ?? null)
    }

    setReplyMode(null); setReplyHtml(''); setReplyAttachments([]); setReplyAnchorMsgId(null); setDraftMessageId(null)
    console.log('[Inbox] handleSendReply:', sendId, 'success, refreshing thread list')
    toast('Sent')
    await fetchThreads()
    if (sentThreadIdForAdvance && !shouldAdvanceSelection) {
      fetchMessages(sentThreadIdForAdvance)
      fetchAttachments(sentThreadIdForAdvance)
    }
  }

  const syncDraftOnServer = async (
    messageId: string,
    action: 'save' | 'delete' = 'save',
    opts?: { externalUid?: number | null; imapAccountId?: string | null },
  ) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return null
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-save-draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          messageId,
          action,
          ...(opts?.externalUid != null ? { externalUid: opts.externalUid } : {}),
          ...(opts?.imapAccountId ? { imapAccountId: opts.imapAccountId } : {}),
        }),
      })
      return await res.json().catch(() => ({}))
    } catch (err) {
      console.warn('[Inbox] imap-save-draft failed:', err)
      return null
    }
  }

  const handleDeleteDraft = async (m: InboxMessage) => {
    if (!confirm('Delete this draft message?')) return
    const wasOnlyMessage = messages.length === 1 && messages[0].id === m.id
    const externalUid = m.external_uid ?? null
    const imapAccountId = m.imap_account_id ?? null
    const messageId = m.id

    const { error: delErr } = await supabase.from('inbox_messages').delete().eq('id', messageId)
    if (delErr) {
      alert('Failed to delete draft: ' + delErr.message)
      return
    }

    setMessages(prev => prev.filter(msg => msg.id !== messageId))
    if (draftMessageId === messageId) {
      setDraftMessageId(null)
      setReplyMode(null)
      setReplyAnchorMsgId(null)
      setReplyHtml('')
      setReplyAttachments([])
    }
    if (wasOnlyMessage) {
      setSelectedThreadId(null)
    }
    void fetchThreads()

    if (externalUid != null && imapAccountId) {
      void syncDraftOnServer(messageId, 'delete', { externalUid, imapAccountId })
    }
  }

  const handleSaveDraft = async () => {
    if (!currentOrg?.id) return
    if (savingDraft) return
    const selectedSendable = getSendableAddresses().find((a) => a.email.toLowerCase() === selectedFromAddress.toLowerCase())
      ?? getSendableAddresses().find((a) => a.accountId === selectedAccountId)
    const fromEmail = selectedSendable?.email || selectedFromAddress
    if (!fromEmail) { toast('Select a From address'); return }
    setSavingDraft(true)
    const now = new Date().toISOString()
    let threadId = selectedThreadId
    const isNewComposeDraft = !threadId && replyMode === 'compose'
    const subject = replySubject.trim() || '(No subject)'

    if (isNewComposeDraft) {
      const accountId = selectedSendable?.accountId || selectedAccountId || null
      const { data: newThread, error: threadErr } = await supabase.from('inbox_threads').insert({
        org_id: currentOrg.id,
        channel: 'email',
        status: 'open',
        subject,
        last_message_at: now,
        imap_account_id: accountId,
        from_address: fromEmail,
        mailbox_address: fromEmail.toLowerCase(),
      }).select(INBOX_THREAD_LIST_SELECT).single()
      if (threadErr || !newThread) {
        setSavingDraft(false)
        toast('Failed to save draft: ' + (threadErr?.message ?? 'Could not create thread'))
        return
      }
      threadId = (newThread as InboxThread).id
      setThreads(prev => [{ ...(newThread as InboxThread), inbox_messages: [{ count: 1 }] }, ...prev])
    }

    if (!threadId) {
      setSavingDraft(false)
      return
    }

    await supabase.from('inbox_threads').update({ subject, last_message_at: now, updated_at: now }).eq('id', threadId)

    const payload = {
      thread_id: threadId,
      channel: 'email' as const,
      direction: 'outbound' as const,
      from_identifier: fromEmail,
      to_identifier: replyTo.trim() || null,
      cc: replyCc.trim() || null,
      html_body: replyHtml,
      body: stripHtmlToText(replyHtml, 100_000),
      is_draft: true,
      imap_account_id: selectedSendable?.accountId || selectedAccountId || null,
      received_at: now,
    }
    let savedMessageId = draftMessageId
    if (draftMessageId) {
      const { data, error } = await supabase.from('inbox_messages').update(payload).eq('id', draftMessageId).select().single()
      if (error) {
        setSavingDraft(false)
        toast('Failed to save draft: ' + error.message)
        return
      }
      setMessages(prev => prev.map(m => m.id === draftMessageId ? { ...m, ...(data as InboxMessage) } : m))
    } else {
      const { data, error } = await supabase.from('inbox_messages').insert(payload).select().single()
      if (error) {
        setSavingDraft(false)
        toast('Failed to save draft: ' + error.message)
        return
      }
      const draftMsg = data as InboxMessage
      savedMessageId = draftMsg.id
      if (isNewComposeDraft) {
        setSelectedThreadId(threadId)
        setMessages([draftMsg])
        setExpandedMsgs(new Set([draftMsg.id]))
      } else {
        setMessages(prev => [...prev, draftMsg])
        setExpandedMsgs(prev => new Set([...prev, draftMsg.id]))
      }
    }

    setSavingDraft(false)
    setReplyMode(null)
    setReplyAnchorMsgId(null)
    setDraftMessageId(null)
    setReplyHtml('')
    setReplyAttachments([])
    toast('Draft saved')
    if (isNewComposeDraft) void fetchThreads()

    if (savedMessageId) {
      void syncDraftOnServer(savedMessageId, 'save').then((result) => {
        if (result?.external_uid != null) {
          setMessages(prev => prev.map(m => m.id === savedMessageId
            ? { ...m, external_uid: result.external_uid as number, is_draft: true }
            : m))
        }
        if (result?.imapError) console.warn('[Inbox] IMAP draft sync:', result.imapError)
      })
    }
  }

  const handleAddComment = async () => {
    if (!selectedThreadId || !commentText.trim() || !userId || !currentOrg?.id) return
    const mentionIds = parseMentionUserIds(commentText.trim(), inboxUsers).filter(id => id !== userId)
    const { data: insertedComment, error: insertErr } = await supabase.from('inbox_comments').insert({
      thread_id: selectedThreadId, user_id: userId, content: commentText.trim(),
      mentions: mentionIds.length > 0 ? mentionIds : null,
    }).select('id').single()
    if (insertErr || !insertedComment) return
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
      comment_id: insertedComment.id,
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

  const handleLinkInvoice = async (invoiceId: string) => {
    if (!selectedThreadId || !invoiceId) return
    const { error } = await supabase
      .from('inbox_thread_invoices')
      .upsert({ thread_id: selectedThreadId, invoice_id: invoiceId }, { onConflict: 'thread_id,invoice_id' })
    if (error) { toast(error.message); return }
    await fetchThreadInvoiceLinks(selectedThreadId)
    setShowLinkInvoicePicker(false)
    toast('Invoice linked')
  }

  const handleUnlinkInvoice = async (invoiceId: string) => {
    if (!selectedThreadId) return
    const { error } = await supabase
      .from('inbox_thread_invoices')
      .delete()
      .eq('thread_id', selectedThreadId)
      .eq('invoice_id', invoiceId)
    if (error) { toast(error.message); return }
    setThreadInvoiceLinks(prev => prev.filter(link => link.invoice_id !== invoiceId))
    toast('Invoice unlinked')
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
    const reloadId = crypto.randomUUID().slice(0, 8)
    console.log('[Inbox:imap-reload] click', {
      reloadId,
      messageId: m.id,
      threadId: m.thread_id,
      direction: m.direction,
      externalUid: m.external_uid,
      imapAccountId: m.imap_account_id,
      hadBody: !!(m.body?.trim()),
      hadHtmlBody: !!(m.html_body?.trim()),
    })
    debugLog('imapReload', {
      event: 'START',
      reloadId,
      messageId: m.id,
      externalUid: m.external_uid,
      imapAccountId: m.imap_account_id,
      direction: m.direction,
    }, m.thread_id)

    if (!m.imap_account_id || m.external_uid == null) {
      console.warn('[Inbox:imap-reload] skipped — no IMAP reference', { reloadId, messageId: m.id })
      debugLog('imapReload', { event: 'SKIP', reloadId, reason: 'no_imap_reference', messageId: m.id }, m.thread_id)
      return
    }

    setImapReloadingId(m.id)
    setBodyFetchStatus((prev) => ({ ...prev, [m.id]: 'loading' }))
    const t0 = performance.now()
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        console.warn('[Inbox:imap-reload] no session', { reloadId, messageId: m.id })
        debugLog('imapReload', { event: 'ERROR', reloadId, reason: 'no_session', messageId: m.id }, m.thread_id)
        setToastMsg('Sign in to reload from mail server')
        setTimeout(() => setToastMsg(null), 3000)
        return
      }

      const payload = { messageId: m.id, forceRefresh: true }
      console.log('[Inbox:imap-reload] calling imap-fetch-body', { reloadId, payload })
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-fetch-body`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({})) as {
        error?: string
        body?: string | null
        htmlBody?: string | null
        attachmentCount?: number
        fromCache?: boolean
        fromImap?: boolean
        forceRefresh?: boolean
        bodyUnavailable?: boolean
      }
      const elapsedMs = Math.round(performance.now() - t0)
      console.log('[Inbox:imap-reload] response', {
        reloadId,
        messageId: m.id,
        status: res.status,
        ok: res.ok,
        elapsedMs,
        error: data.error ?? null,
        attachmentCount: data.attachmentCount ?? null,
        fromCache: data.fromCache ?? null,
        fromImap: data.fromImap ?? null,
        forceRefresh: data.forceRefresh ?? null,
        bodyLen: data.body?.length ?? 0,
        htmlLen: data.htmlBody?.length ?? 0,
      })
      debugLog('imapReload', {
        event: 'RESPONSE',
        reloadId,
        messageId: m.id,
        status: res.status,
        ok: res.ok,
        elapsedMs,
        error: data.error ?? null,
        attachmentCount: data.attachmentCount ?? null,
        bodyLen: data.body?.length ?? 0,
        htmlLen: data.htmlBody?.length ?? 0,
      }, m.thread_id)

      if (!res.ok || (data.error && !data.bodyUnavailable && !isUnavailableBodyText(data.body))) {
        console.error('[Inbox:imap-reload] failed', { reloadId, messageId: m.id, status: res.status, error: data.error })
        setBodyFetchStatus((prev) => ({ ...prev, [m.id]: 'failed' }))
        setToastMsg(data.error || `Reload failed (${res.status})`)
        setTimeout(() => setToastMsg(null), 4000)
        return
      }

      const nextBody = data.body ?? null
      const nextHtml = data.htmlBody ?? null
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id ? { ...x, body: nextBody, html_body: nextHtml } : x
        )
      )
      setBodyFetchStatus((prev) => {
        const next = { ...prev }
        if (data.bodyUnavailable || isUnavailableBodyText(nextBody)) next[m.id] = 'unavailable'
        else if (isMessageBodyEmpty(nextBody, nextHtml)) next[m.id] = 'failed'
        else delete next[m.id]
        return next
      })
      await fetchAttachments(m.thread_id)

      const { data: attRows } = await supabase
        .from('inbox_attachments')
        .select('id, file_name, file_size, content_type')
        .eq('message_id', m.id)
      console.log('[Inbox:imap-reload] attachments in DB after refresh', {
        reloadId,
        messageId: m.id,
        threadId: m.thread_id,
        count: attRows?.length ?? 0,
        files: (attRows ?? []).map((a) => ({
          id: a.id,
          name: a.file_name,
          size: a.file_size,
          type: a.content_type,
        })),
      })
      debugLog('imapReload', {
        event: 'DONE',
        reloadId,
        messageId: m.id,
        attachmentCountFromFunction: data.attachmentCount ?? null,
        attachmentRowsInDb: attRows?.length ?? 0,
        files: (attRows ?? []).map((a) => a.file_name),
      }, m.thread_id)

      const ac = typeof data.attachmentCount === 'number' ? `${data.attachmentCount} file(s) from IMAP. ` : ''
      if (data.bodyUnavailable || isUnavailableBodyText(nextBody)) {
        setToastMsg('Message body could not be loaded from mail server.')
      } else {
        setToastMsg(`${ac}Reloaded from mail server.`)
      }
      setTimeout(() => setToastMsg(null), 3500)
    } catch (err) {
      console.error('[Inbox:imap-reload] exception', {
        reloadId,
        messageId: m.id,
        elapsedMs: Math.round(performance.now() - t0),
        error: err instanceof Error ? err.message : String(err),
      })
      debugLog('imapReload', {
        event: 'EXCEPTION',
        reloadId,
        messageId: m.id,
        error: err instanceof Error ? err.message : String(err),
      }, m.thread_id)
      setBodyFetchStatus((prev) => ({ ...prev, [m.id]: 'failed' }))
      setToastMsg('Could not reload from mail server')
      setTimeout(() => setToastMsg(null), 3000)
    } finally {
      setImapReloadingId(null)
    }
  }, [fetchAttachments, debugLog])

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
    <EmailComposeForm
      modeLabel={
        draftMessageId ? 'Edit draft'
          : replyMode === 'reply' ? 'Reply'
          : replyMode === 'reply_all' ? 'Reply All'
          : replyMode === 'forward' ? 'Forward'
          : 'New message'
      }
      sendableAddresses={sendableAddresses}
      selectedFromAddress={selectedFromAddress}
      onFromAddressChange={(email, accountId) => {
        setSelectedFromAddress(email)
        if (accountId) setSelectedAccountId(accountId)
      }}
      to={replyTo}
      onToChange={updateToSuggestions}
      toSuggestions={toSuggestions}
      showToSuggestions={showToSuggestions}
      onToBlur={() => setTimeout(() => setShowToSuggestions(false), 200)}
      onSelectToSuggestion={selectToSuggestion}
      cc={replyCc}
      onCcChange={setReplyCc}
      bcc={replyBcc}
      onBccChange={setReplyBcc}
      showCcBcc={showCcBcc}
      onShowCcBccChange={setShowCcBcc}
      subject={replySubject}
      onSubjectChange={setReplySubject}
      showSubject={isCompose}
      html={replyHtml}
      onHtmlChange={setReplyHtml}
      attachments={replyAttachments}
      onAttachmentsChange={setReplyAttachments}
      onSend={handleSendReply}
      sending={sendingReply}
      sendDisabled={!replyTo.trim()}
      saveDraftDisabled={!selectedFromAddress.trim() && sendableAddresses.length === 0}
      showSaveDraft={replyMode !== null && (replyMode === 'compose' || !!selectedThreadId)}
      onSaveDraft={handleSaveDraft}
      savingDraft={savingDraft}
      stickyActions={replyMode === 'compose' && !selectedThreadId}
      onCancel={() => {
        console.log('[Inbox:nav] Reply form Cancel click')
        setReplyMode(null)
        setReplyAnchorMsgId(null)
        setDraftMessageId(null)
      }}
    />
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
              setFilter(f.id); setSelectedThreadId(null); setThreads([]); setHasMoreThreads(false); initialLoadDone.current = false
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
          {/* Search + optional mailbox filter */}
          <div className="border-b border-border">
            <div className="p-2 flex gap-2 items-center">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Search email, subject, or body…"
                  className="w-full h-9 rounded border border-border bg-surface-muted pl-8 pr-3 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              {imapAccounts.length > 1 && (
                <button
                  type="button"
                  onClick={() => setMailboxFilterOpen(open => !open)}
                  title={selectedMailboxAccount
                    ? `Mailbox: ${selectedMailboxAccount.label ?? selectedMailboxAccount.email}`
                    : 'Filter by mailbox'}
                  className={`inline-flex items-center justify-center shrink-0 h-9 rounded border text-xs font-medium focus:outline-none focus:ring-1 focus:ring-accent ${
                    mailboxFilterId
                      ? 'gap-1 px-2 border-accent/60 bg-accent/15 text-accent'
                      : mailboxFilterOpen
                        ? 'w-9 border-border bg-surface-muted text-gray-200 ring-1 ring-accent/40'
                        : 'w-9 border-border bg-surface-muted text-gray-400 hover:text-gray-200 hover:bg-surface-muted/80'
                  }`}
                >
                  <Mailbox className="w-3.5 h-3.5 shrink-0" />
                  {mailboxFilterId && (
                    <span className="max-w-[4.5rem] truncate">
                      {selectedMailboxAccount?.label ?? selectedMailboxAccount?.email ?? 'Mailbox'}
                    </span>
                  )}
                </button>
              )}
            </div>
            {imapAccounts.length > 1 && mailboxFilterOpen && (
              <div className="px-2 pb-2">
                <select
                  value={mailboxFilterId ?? ''}
                  onChange={e => {
                    setMailboxFilterId(e.target.value || null)
                    setThreads([])
                    setHasMoreThreads(false)
                    initialLoadDone.current = false
                  }}
                  title="Filter by mailbox"
                  className="w-full h-9 rounded border border-border bg-surface-muted px-2 py-0 text-xs font-medium leading-none text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">All mailboxes</option>
                  {imapAccounts.map(acc => (
                    <option key={acc.id} value={acc.id}>
                      {acc.label ? `${acc.label} (${acc.email})` : acc.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="px-3 py-2 border-b border-border bg-surface-elevated flex items-center gap-2">
              <span className="text-xs text-gray-300">{selectedIds.size} selected</span>
              <button type="button" onClick={async () => {
                const ids = [...selectedIds]
                const bulkCount = ids.length
                const { data: { session } } = await supabase.auth.getSession()
                for (const tid of ids) {
                  const { error } = await supabase.from('inbox_threads').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', tid)
                  if (!error && currentOrg?.id && user?.id) {
                    void supabase
                      .from('inbox_debug_log')
                      .insert({
                        user_id: user.id,
                        org_id: currentOrg.id,
                        thread_id: tid,
                        tag: 'thread_archived',
                        payload: {
                          source: 'inbox_ui',
                          reason: 'bulk_thread_trash',
                          bulk_selection_count: bulkCount,
                        },
                      })
                      .then(({ error: logErr }) => {
                        if (logErr) console.warn('[Inbox] thread_archived debug log failed', logErr)
                      })
                  }
                  if (session?.access_token) {
                    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-flag-sync`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
                      body: JSON.stringify({ threadId: tid, action: 'trash' }),
                    }).catch(() => {})
                  }
                }
                setSelectedIds(new Set()); fetchThreads(); toast(`${bulkCount} thread(s) trashed`)
              }} className="px-2 py-1 rounded text-[11px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30">Trash</button>
              <button type="button" onClick={async () => {
                const ids = [...selectedIds]
                const bulkCount = ids.length
                const { data: { session } } = await supabase.auth.getSession()
                for (const tid of ids) {
                  await supabase.from('inbox_threads').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', tid)
                  if (session?.access_token) {
                    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-flag-sync`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
                      body: JSON.stringify({ threadId: tid, action: 'archive' }),
                    }).catch(() => {})
                  }
                }
                setSelectedIds(new Set()); fetchThreads(); toast(`${bulkCount} thread(s) closed`)
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
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            {t.from_address ?? '(unknown sender)'}
                            {getMailboxLabel(t) && (
                              <span className="text-gray-500"> · Mailbox {getMailboxLabel(t)}</span>
                            )}
                          </p>
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
              {hasMoreThreads && (
                <li className="p-3">
                  <button
                    type="button"
                    onClick={loadOlderThreads}
                    disabled={loadingMoreThreads}
                    className="w-full rounded border border-border bg-surface-muted px-3 py-2 text-xs font-medium text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"
                  >
                    {loadingMoreThreads ? 'Loading older emails…' : searchQuery.trim() ? 'Load more search results' : 'Load older emails'}
                  </button>
                </li>
              )}
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
              <div className="flex-1 min-h-0 p-4">{renderReplyForm(true)}</div>
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
                  {getMailboxLabel(selectedThread) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 bg-surface-muted text-gray-300" title="Mailbox/account">
                      Mailbox {getMailboxLabel(selectedThread)}
                    </span>
                  )}
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
                  {selectedThread.status === 'closed' && <button type="button" onClick={() => handleUpdateStatus('open')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"><RotateCcw className="w-3 h-3" /> Re-open</button>}
                  {selectedThread.status === 'archived' ? (
                    <button type="button" onClick={() => handleUpdateStatus('open', { restoreFromTrash: true })} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-50"><ArchiveRestore className="w-3 h-3" /> Restore</button>
                  ) : (
                    <button type="button" onClick={() => handleUpdateStatus('archived')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50"><Archive className="w-3 h-3" /> Trash</button>
                  )}
                  <div className="w-px h-4 bg-border mx-0.5" />
                  {threadInvoiceLinks.length === 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowLinkInvoicePicker(v => !v)}
                        disabled={actionLoading}
                        className={`${INBOX_THREAD_ACTION_BTN_CLASS} ${showLinkInvoicePicker ? 'ring-1 ring-accent/50' : ''}`}
                      >
                        Link invoice…
                      </button>
                      {showLinkInvoicePicker && (
                        <span className="relative inline-flex items-center">
                          <select
                            value=""
                            onChange={(e) => { if (e.target.value) void handleLinkInvoice(e.target.value) }}
                            className={`${INBOX_THREAD_ACTION_BTN_CLASS} ${INBOX_THREAD_ACTION_SELECT_CLASS}`}
                            autoFocus
                          >
                            <option value="">Select invoice…</option>
                            {invoiceOptions.map((inv) => (
                              <option key={inv.id} value={inv.id}>
                                {formatInvoiceNumber(inv)}{inv.companyName ? ` · ${inv.companyName}` : ''} · {inv.status}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 shrink-0 text-gray-400" aria-hidden />
                        </span>
                      )}
                      <div className="w-px h-4 bg-border mx-0.5" />
                    </>
                  )}
                  <div className="relative">
                    <button type="button" onClick={() => { setShowAssignPopover(v => !v); setSelectedAssignUserIds(new Set()) }} disabled={actionLoading}
                      className={INBOX_THREAD_ACTION_BTN_CLASS}>
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
                {threadInvoiceLinks.length > 0 && (
                  <div className="mt-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-gray-500">Linked invoices:</span>
                      {threadInvoiceLinks.map((link) => link.invoice ? (
                        <span key={link.invoice_id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-muted px-2 py-0.5 text-gray-200">
                          <Link to={`/invoices/${link.invoice_id}`} className="inline-flex items-center gap-1 hover:text-accent">
                            <FileText className="h-3 w-3" />
                            {formatInvoiceNumber(link.invoice)}
                            {link.invoice.companyName ? ` · ${link.invoice.companyName}` : ''}
                          </Link>
                          <button type="button" onClick={() => handleUnlinkInvoice(link.invoice_id)} className="text-gray-500 hover:text-red-400" title="Unlink invoice">&times;</button>
                        </span>
                      ) : null)}
                    </div>
                  </div>
                )}
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
                      const isDraftMsg = !!m.is_draft
                      const isExpanded = isDraftMsg || m.id === lastMsgId || expandedMsgs.has(m.id)
                      const messageFetchStatus = bodyFetchStatus[m.id] ?? (isUnavailableBodyText(m.body) ? 'unavailable' : null)
                      const bodyDisplay = isExpanded ? cleanMessageBody(m, messageFetchStatus) : { html: false, content: '', loading: false, failed: false, unavailable: false }
                      const { html, content, loading: bodyLoading, failed: bodyFailed, unavailable: bodyUnavailable } = bodyDisplay
                      const msgAttachments = attachmentsByMessageId.get(m.id) ?? []
                      const displayContent = isDraftMsg && html ? prepareDraftHtmlForDisplay(content) : content
                      const sanitized = html
                        ? sanitizeEmailHtml(resolveInlineEmailImages(displayContent, msgAttachments))
                        : displayContent
                      const preview = !isExpanded && m.body && !isUnavailableBodyText(m.body) ? m.body.replace(/<[^>]+>/g, '').slice(0, 80) : ''
                      const isEditingThisDraft = draftMessageId === m.id && replyMode !== null && replyMode !== 'compose'
                      if (isEditingThisDraft) {
                        return (
                          <React.Fragment key={`msg-${m.id}`}>
                            {renderReplyForm(false)}
                          </React.Fragment>
                        )
                      }
                      return (<React.Fragment key={`msg-${m.id}`}>
                        <article className={`rounded-lg border overflow-hidden group/msg ${isDraftMsg ? 'border-yellow-500/50 bg-yellow-500/5' : 'border-border'}`}>
                          <header onClick={() => setExpandedMsgs(prev => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n })}
                            className={`px-4 py-2 text-[11px] text-gray-400 flex flex-wrap items-center gap-x-3 gap-y-0.5 bg-surface-elevated/50 ${!isExpanded ? 'cursor-pointer hover:bg-surface-muted/50' : 'border-b border-border'}`}>
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 flex-1 min-w-0">
                              {isDraftMsg && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 shrink-0">DRAFT</span>}
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
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    console.log('[Inbox:imap-reload] button clicked', {
                                      messageId: m.id,
                                      threadId: m.thread_id,
                                      externalUid: m.external_uid,
                                      direction: m.direction,
                                    })
                                    void handleReloadFromImap(m)
                                  }}
                                  className="p-1 rounded text-gray-500 hover:text-accent hover:bg-surface-muted disabled:opacity-40 shrink-0"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${imapReloadingId === m.id ? 'animate-spin' : ''}`} />
                                </button>
                              )}
                              {isDraftMsg && (<>
                                <button type="button" title="Edit draft" onClick={(e) => { e.stopPropagation()
                                  const fromAddress = findFromAddressForReply(m)
                                  if (fromAddress) { setSelectedAccountId(fromAddress.accountId); setSelectedFromAddress(fromAddress.email) }
                                  setReplyTo(m.to_identifier ?? ''); setReplyCc(m.cc ?? ''); setReplyBcc(''); setShowCcBcc(!!(m.cc?.trim()))
                                  setReplySubject(selectedThread?.subject ?? '')
                                  const { content: draftContent, html: draftIsHtml } = cleanMessageBody(m)
                                  const normalizedDraft = draftIsHtml ? prepareDraftHtmlForDisplay(draftContent) : draftContent
                                  setReplyHtml(draftIsHtml ? normalizedDraft : normalizedDraft.replace(/\n/g, '<br/>'))
                                  setReplyAttachments([]); setReplyAnchorMsgId(m.id); setDraftMessageId(m.id); setReplyMode('reply')
                                }} className="p-1 rounded text-yellow-500/70 hover:text-yellow-400 hover:bg-surface-muted">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button type="button" title="Delete draft" onClick={(e) => { e.stopPropagation(); void handleDeleteDraft(m) }} className="p-1 rounded text-red-500/70 hover:text-red-400 hover:bg-surface-muted">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>)}
                              <button type="button" title="Reply" onClick={(e) => { e.stopPropagation()
                                const fromAddress = findFromAddressForReply(m)
                                if (fromAddress) { setSelectedAccountId(fromAddress.accountId); setSelectedFromAddress(fromAddress.email) }
                                setDraftMessageId(null)
                                setReplyTo(m.from_identifier); setReplyCc(''); setReplyBcc('')
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Re: ') ? selectedThread!.subject! : 'Re: ' + (selectedThread?.subject ?? ''))
                                setReplyHtml(''); setShowCcBcc(false); setReplyAttachments([]); setReplyAnchorMsgId(m.id); setReplyMode('reply')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><Reply className="w-3.5 h-3.5" /></button>
                              <button type="button" title="Reply All" onClick={(e) => { e.stopPropagation()
                                const fromAddress = findFromAddressForReply(m)
                                if (fromAddress) { setSelectedAccountId(fromAddress.accountId); setSelectedFromAddress(fromAddress.email) }
                                setDraftMessageId(null)
                                const { to, cc } = getThreadRecipientsForReplyAll(m)
                                setReplyTo(to)
                                setReplyCc(cc)
                                setReplyBcc('')
                                setShowCcBcc(!!cc.trim())
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Re: ') ? selectedThread!.subject! : 'Re: ' + (selectedThread?.subject ?? ''))
                                setReplyHtml(''); setReplyAttachments([]); setReplyAnchorMsgId(m.id); setReplyMode('reply_all')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><ReplyAll className="w-3.5 h-3.5" /></button>
                              <button type="button" title="Forward" onClick={(e) => { e.stopPropagation()
                                const fromAddress = findFromAddressForReply(m)
                                if (fromAddress) { setSelectedAccountId(fromAddress.accountId); setSelectedFromAddress(fromAddress.email) }
                                setDraftMessageId(null)
                                setReplyTo(''); setReplyCc(''); setReplyBcc(''); setShowCcBcc(false)
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Fwd: ') ? selectedThread!.subject! : 'Fwd: ' + (selectedThread?.subject ?? ''))
                                const { content: fwdContent } = cleanMessageBody(m)
                                setReplyHtml(`<br/><br/>---------- Forwarded message ----------<br/><b>From:</b> ${m.from_identifier}<br/><b>Date:</b> ${new Date(m.received_at).toLocaleString()}<br/><b>Subject:</b> ${selectedThread?.subject ?? ''}<br/><br/>${fwdContent}`)
                                setReplyAttachments([]); setReplyAnchorMsgId(m.id); setReplyMode('forward')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><Forward className="w-3.5 h-3.5" /></button>
                            </div>}
                          </header>
                          {isExpanded && (html ? (() => {
                            const { srcDoc, isDark } = buildEmailSrcDoc(sanitized, isDraftMsg ? { forceDark: true } : undefined)
                            return (
                              <div style={{ background: isDark ? '#0f0f0f' : '#fff' }}>
                                <iframe title="Email" srcDoc={srcDoc}
                                  className="w-full border-0 rounded-b" sandbox="allow-same-origin allow-popups allow-top-navigation-by-user-activation"
                                  onLoad={e => { const f = e.target as HTMLIFrameElement; if (f.contentDocument?.body) { f.style.height = Math.max(80, f.contentDocument.body.scrollHeight + 20) + 'px' } }}
                                  style={{ minHeight: '80px', background: isDark ? '#0f0f0f' : '#fff' }} />
                              </div>
                            )
                          })() : (
                            <div className="text-sm whitespace-pre-wrap break-words p-4 text-gray-200">
                              {bodyLoading ? (
                                <span className="inline-flex items-center gap-2 text-gray-400">
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                                  Downloading message...
                                </span>
                              ) : (bodyFailed || bodyUnavailable) ? (
                                <div className="rounded-lg border border-border/70 bg-surface-muted/40 px-3 py-2.5 text-gray-300">
                                  <p>{bodyUnavailable ? 'This message could not be loaded from the mail server.' : 'Could not load message body.'}</p>
                                  {m.imap_account_id && m.external_uid != null ? (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); void handleReloadFromImap(m) }}
                                      disabled={imapReloadingId === m.id}
                                      className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-surface-muted text-gray-200 hover:text-accent hover:bg-surface-muted/80 disabled:opacity-50"
                                    >
                                      <RotateCcw className={`w-3.5 h-3.5 ${imapReloadingId === m.id ? 'animate-spin' : ''}`} />
                                      Retry from mail server
                                    </button>
                                  ) : (
                                    <p className="mt-1 text-xs text-gray-500">No IMAP reference is stored for this message.</p>
                                  )}
                                </div>
                              ) : (
                                content
                              )}
                            </div>
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
                        {/* Render reply form directly below the anchored message (not when editing a draft inline) */}
                        {replyMode && replyMode !== 'compose' && replyAnchorMsgId === m.id && draftMessageId !== m.id && (
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
