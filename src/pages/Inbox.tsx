import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  Inbox as InboxIcon, Mail, MessageSquare, Check, Archive,
  List, ChevronRight, ChevronDown, Plus, Reply, ReplyAll, Forward,
  RotateCcw, Send, RefreshCw, Paperclip, Download,
  Search, User, Circle, Link2,
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
}
type InboxMessage = {
  id: string; thread_id: string; channel: string; direction: string
  from_identifier: string; to_identifier: string | null; cc: string | null; bcc: string | null
  body: string | null; html_body: string | null; received_at: string
  external_id?: string | null
}
type InboxComment = {
  id: string; thread_id: string; user_id: string; content: string
  mentions: string[] | null; created_at: string; display_name?: string | null; avatar_url?: string | null
}
type Attachment = { id: string; message_id: string | null; thread_id: string; file_name: string; file_path: string; file_size: number | null; created_at: string }
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
  const [filter, setFilter] = useState<InboxFilter>('inbox')
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(urlThreadId ?? null)

  // If opened via direct URL, use "all" filter so the thread is always visible
  const [filter_init] = useState(() => urlThreadId ? 'all' as InboxFilter : 'inbox' as InboxFilter)
  useEffect(() => { if (urlThreadId) setFilter(filter_init) }, [])

  // Update browser URL when thread selection changes
  useEffect(() => {
    const currentPath = window.location.pathname
    const targetPath = selectedThreadId ? `/inbox/${selectedThreadId}` : '/inbox'
    if (currentPath !== targetPath) {
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
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // Read tracking
  const [readStatuses, setReadStatuses] = useState<ReadStatus[]>([])

  // Reply
  const [replyMode, setReplyMode] = useState<'reply' | 'reply_all' | 'forward' | 'compose' | null>(null)
  const [replyAnchorMsgId, setReplyAnchorMsgId] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState('')
  const [replyCc, setReplyCc] = useState('')
  // When opening reply from a message, hold To/Cc here so the form shows them before state commits
  const pendingReplyToRef = useRef<string | null>(null)
  const pendingReplyCcRef = useRef<string | null>(null)
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

  // Contacts, attachments, all contacts for autocomplete
  const [threadContacts, setThreadContacts] = useState<ContactMatch[]>([])
  const [allContacts, setAllContacts] = useState<{ id: string; name: string; email: string | null }[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})
  const [activeSuggestionsField, setActiveSuggestionsField] = useState<'to' | 'cc' | 'bcc' | null>(null)

  // Drag state
  const [isDragging, setIsDragging] = useState(false)

  const userId = user?.id ?? null
  const timelineEndRef = useRef<HTMLDivElement>(null)
  const replyFormContainerRef = useRef<HTMLDivElement>(null)
  const replyFileRef = useRef<HTMLInputElement>(null)
  const sendingReplyRef = useRef(false)

  // Emails from contacts + thread messages for To/Cc/Bcc autocomplete
  const emailSuggestionSource = React.useMemo(() => {
    const byEmail = new Map<string, { name: string; email: string }>()
    allContacts.forEach((c) => {
      if (c.email?.trim()) {
        const e = c.email.trim().toLowerCase()
        if (!byEmail.has(e)) byEmail.set(e, { name: c.name || c.email || e, email: c.email!.trim() })
      }
    })
    messages.forEach((m) => {
      for (const addr of [m.from_identifier, m.to_identifier].filter(Boolean) as string[]) {
        const e = addr.trim().toLowerCase()
        if (e && !byEmail.has(e)) byEmail.set(e, { name: e, email: addr.trim() })
      }
      if (m.cc) {
        m.cc.split(',').forEach((addr) => {
          const e = addr.trim().toLowerCase()
          if (e && !byEmail.has(e)) byEmail.set(e, { name: e, email: addr.trim() })
        })
      }
    })
    return Array.from(byEmail.values())
  }, [allContacts, messages])

  const looksLikeHtml = (t: string | null) => t != null && /<\s*(html|div|p|table|body|span)[\s>]/i.test(t)
  const decodeQP = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

  const cleanMessageBody = (msg: InboxMessage): { html: boolean; content: string } => {
    if (msg.html_body) return { html: true, content: msg.html_body }
    const body = msg.body
    if (!body?.trim()) return { html: false, content: '—' }
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

  // Data fetching — on re-fetch, merge new threads on top instead of clearing + "Loading"
  const fetchThreads = useCallback(async () => {
    if (!currentOrg?.id || !userId) return
    if (!initialLoadDone.current) setLoading(true)
    try {
      let query = supabase.from('inbox_threads')
        .select('id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, inbox_thread_assignments(user_id)')
        .eq('org_id', currentOrg.id).order('last_message_at', { ascending: false })
      if (filter === 'inbox') {
        // Inbox = open threads: assigned to me OR unassigned
        query = query.eq('status', 'open')
      } else if (filter === 'assigned') {
        // Mine = threads assigned to the current user (prefer RPC; fallback to client query if RPC missing/fails)
        let tids: string[] = []
        const { data: rpcTids, error: rpcErr } = await supabase.rpc('get_my_assigned_inbox_thread_ids', { p_org_id: currentOrg.id })
        if (!rpcErr && Array.isArray(rpcTids) && rpcTids.length > 0) {
          tids = rpcTids as string[]
        } else {
          const { data: assigned } = await supabase.from('inbox_thread_assignments').select('thread_id').eq('user_id', userId)
          tids = (assigned ?? []).map((a: { thread_id: string }) => a.thread_id)
        }
        if (!tids.length) {
          setThreads([]); setLoading(false); initialLoadDone.current = true; return
        }
        query = query.in('id', tids)
      } else if (filter === 'closed') query = query.eq('status', 'closed')
      else if (filter === 'trash') query = query.eq('status', 'archived')
      const { data } = await query
      setThreads((data as InboxThread[]) ?? [])
      initialLoadDone.current = true
    } catch { if (!initialLoadDone.current) setThreads([]) }
    setLoading(false)
  }, [currentOrg?.id, filter, userId])

  const fetchMessages = useCallback(async (tid: string) => {
    setMessagesLoading(true)
    const { data } = await supabase.from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, cc, bcc, body, html_body, received_at, external_id')
      .eq('thread_id', tid).order('received_at', { ascending: true })
    const raw = (data as InboxMessage[]) ?? []
    // Dedupe: same message can exist twice (e.g. send-reply insert + IMAP sync of sent mail). Keep one per (external_id or received_at+from+to).
    const seen = new Set<string>()
    const msgs = raw.filter((m) => {
      const key = (m.external_id && m.external_id.trim()) ? `${tid}:${m.external_id}` : `${tid}:${m.received_at}:${m.from_identifier}:${m.to_identifier ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    setMessages(msgs)
    setMessagesLoading(false)
    setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)

    // Mark as read
    if (userId) {
      await supabase.from('inbox_thread_reads').upsert({ thread_id: tid, user_id: userId, last_read_at: new Date().toISOString() }, { onConflict: 'thread_id,user_id' })
    }

    // Lazy-load bodies for messages that haven't been fetched yet
    const needBody = msgs.filter(m => m.body === null && m.html_body === null && m.direction === 'inbound')
    if (needBody.length > 0) {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      for (const m of needBody) {
        try {
          const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-fetch-body`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
            body: JSON.stringify({ messageId: m.id }),
          })
          const result = await res.json().catch(() => ({}))
          if (result.body || result.htmlBody) {
            setMessages(prev => prev.map(pm => pm.id === m.id ? { ...pm, body: result.body ?? pm.body, html_body: result.htmlBody ?? pm.html_body } : pm))
          }
        } catch (err) {
          console.error(`[Inbox] Failed to lazy-load body for ${m.id}:`, err)
        }
      }
    }
  }, [userId])

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

  const fetchAttachments = useCallback(async (tid: string) => {
    const { data } = await supabase.from('inbox_attachments').select('*').eq('thread_id', tid).order('created_at')
    const raw = (data as Attachment[]) ?? []
    const seen = new Set<string>()
    const list = raw.filter((a) => {
      const key = `${a.file_name}:${a.file_size ?? 0}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    setAttachments(list)
    if (list.length > 0) {
      const urls: Record<string, string> = {}
      await Promise.all(
        list.map(async (a) => {
          const { data: signed } = await supabase.storage.from('inbox-attachments').createSignedUrl(a.file_path, 3600)
          if (signed?.signedUrl) urls[a.file_path] = signed.signedUrl
        })
      )
      setAttachmentUrls((prev) => ({ ...prev, ...urls }))
    }
  }, [])

  // Load inbox users, accounts, all contacts, read statuses
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.rpc('org_users_with_permission', { p_org_id: currentOrg.id, p_permission: 'inbox.view' })
      .then(async ({ data }) => {
        const users = (data ?? []) as InboxUser[]
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

  // Refs for stable realtime callbacks (avoids channel teardown on every state change)
  const selectedThreadIdRef = useRef(selectedThreadId)
  const fetchThreadsRef = useRef(fetchThreads)
  const fetchMessagesRef = useRef(fetchMessages)
  const fetchCommentsRef = useRef(fetchComments)
  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])
  useEffect(() => { fetchThreadsRef.current = fetchThreads }, [fetchThreads])
  useEffect(() => { fetchMessagesRef.current = fetchMessages }, [fetchMessages])
  useEffect(() => { fetchCommentsRef.current = fetchComments }, [fetchComments])

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
      setMessages([])
      setComments([])
      setThreadContacts([])
      setAttachments([])
      if (replyMode !== 'compose') {
        setReplyMode(null)
        pendingReplyToRef.current = null
        pendingReplyCcRef.current = null
      }
      return
    }
    fetchMessages(selectedThreadId); fetchComments(selectedThreadId); fetchThreadContacts(selectedThreadId); fetchAttachments(selectedThreadId)
    supabase.rpc('match_thread_contacts', { p_thread_id: selectedThreadId }).then(() => fetchThreadContacts(selectedThreadId))
  }, [selectedThreadId, fetchMessages, fetchComments, fetchThreadContacts, fetchAttachments, replyMode])

  // When reply form opens from a message, sync pending To/Cc refs into state (do not clear refs here so the form shows the value immediately)
  useEffect(() => {
    if (!replyAnchorMsgId) return
    if (pendingReplyToRef.current != null) {
      setReplyTo(pendingReplyToRef.current)
      setReplyCc(pendingReplyCcRef.current ?? '')
    }
  }, [replyAnchorMsgId])

  // When reply/forward form opens or mode changes, scroll it into view (anchored form or bottom fallback)
  useEffect(() => {
    if (!replyMode || replyMode === 'compose') return
    const scrollTarget = replyAnchorMsgId ? replyFormContainerRef.current : timelineEndRef.current
    if (scrollTarget) {
      const t = setTimeout(() => scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100)
      return () => clearTimeout(t)
    }
  }, [replyMode, replyAnchorMsgId])

  const selectedThread = threads.find(t => t.id === selectedThreadId)
  const getUserName = (uid: string) => inboxUsers.find(u => u.user_id === uid)?.display_name ?? uid.slice(0, 8)
  const getUserAvatar = (uid: string) => inboxUsers.find(u => u.user_id === uid)?.avatar_url ?? null
  const currentAssignees = (selectedThread?.inbox_thread_assignments ?? []) as { user_id: string }[]
  const toast = (msg: string) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3000) }

  const isUnread = (t: InboxThread) => {
    const readStatus = readStatuses.find(r => r.thread_id === t.id)
    if (!readStatus) return true
    return new Date(t.last_message_at) > new Date(readStatus.last_read_at)
  }

  // Filtered threads by search
  const filteredThreads = searchQuery.trim()
    ? threads.filter(t => t.subject?.toLowerCase().includes(searchQuery.toLowerCase()) || t.from_address?.toLowerCase().includes(searchQuery.toLowerCase()))
    : threads

  // Sync — all accounts in parallel with timeout
  const handleSync = async () => {
    if (!currentOrg?.id || syncing) return
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

      if (accountList.length === 0) { toast('No email accounts configured'); setSyncing(false); return }

      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY }
      const syncUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-sync`

      const syncAccount = async (acc: { id: string; email: string }) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90_000)
        try {
          const res = await fetch(syncUrl, {
            method: 'POST', headers, signal: controller.signal,
            body: JSON.stringify({ orgId: currentOrg.id, accountId: acc.id }),
          })
          clearTimeout(timeout)
          const text = await res.text()
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

  const handleAssignTo = async (uid: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    // Add assignee (multi-assign). Upsert so duplicate assign is idempotent; conflict target must match unique (thread_id, user_id).
    const { error: assignErr } = await supabase.from('inbox_thread_assignments').upsert(
      { thread_id: selectedThreadId, user_id: uid },
      { onConflict: 'thread_id,user_id' }
    )
    if (assignErr) {
      console.warn('[Inbox] Assign error:', assignErr.message, { thread_id: selectedThreadId, user_id: uid })
    }

    // Remove Inbox label on Gmail (archive)
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-flag-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ threadId: selectedThreadId, action: 'archive' }),
      }).catch(() => {})
    }

    await fetchThreads(); setActionLoading(false); toast(`Assigned to ${getUserName(uid)}`)
  }

  const handleUnassign = async (uid: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_thread_assignments').delete().eq('thread_id', selectedThreadId).eq('user_id', uid)
    await fetchThreads(); setActionLoading(false); toast('Unassigned')
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
    if (status === 'archived') { setSelectedThreadId(null); toast('Moved to trash') }
    else if (status === 'closed') toast('Thread closed')
    else toast('Thread re-opened')
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

  // Find which IMAP account received this message (match to_identifier against accounts + aliases)
  const findFromAccount = (toAddr: string | null, ccAddr: string | null): string => {
    if (!toAddr && !ccAddr) return selectedAccountId
    const allRecipients = [toAddr, ...(ccAddr?.split(',') ?? [])].filter(Boolean).map(e => e!.trim().toLowerCase())
    for (const acc of imapAccounts) {
      const accEmails = [acc.email.toLowerCase(), ...(acc.addresses ?? []).map(a => a.toLowerCase())]
      for (const recipient of allRecipients) {
        if (accEmails.includes(recipient)) return acc.id
      }
    }
    return selectedAccountId
  }

  const openReply = (mode: 'reply' | 'reply_all' | 'forward' | 'compose') => {
    setReplyAnchorMsgId(null)
    pendingReplyToRef.current = null
    pendingReplyCcRef.current = null
    if (mode === 'compose') {
      setReplyTo(''); setReplyCc(''); setReplyBcc(''); setReplySubject(''); setReplyHtml(''); setShowCcBcc(false); setReplyAttachments([])
    } else if (selectedThread && messages.length > 0) {
      const last = messages.filter(m => m.direction === 'inbound').pop() ?? messages[messages.length - 1]
      setSelectedAccountId(findFromAccount(last.to_identifier, last.cc))
      setReplyTo(mode === 'forward' ? '' : last.from_identifier + (last.from_identifier ? ', ' : ''))
      setReplyCc(mode === 'reply_all' ? (last.cc ?? '') + ((last.cc ?? '').trim() ? ', ' : '') : '')
      setReplyBcc('')
      setShowCcBcc(mode === 'reply_all' && !!(last.cc))
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
    if (sendingReplyRef.current) return
    const toAddr = (pendingReplyToRef.current ?? replyTo).trim().replace(/,\s*$/, '')
    const ccAddr = (pendingReplyCcRef.current ?? replyCc).trim().replace(/,\s*$/, '')
    const bccAddr = (replyBcc ?? '').trim().replace(/,\s*$/, '')
    if (!toAddr && replyMode !== 'compose') { toast('Recipient required'); return }
    const toList = toAddr.split(',').map((s) => s.trim()).filter(Boolean)
    const invalidTo = toList.find((e) => !isValidEmail(e))
    if (invalidTo) { toast(`Invalid email in To: ${invalidTo}`); return }
    const ccList = (ccAddr || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (ccList.some((e) => !isValidEmail(e))) { toast('Invalid email in Cc'); return }
    const bccList = (bccAddr || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (bccList.some((e) => !isValidEmail(e))) { toast('Invalid email in Bcc'); return }
    if (!replyHtml.trim()) { toast('Message body is empty'); return }
    sendingReplyRef.current = true
    setSendingReply(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { toast('Please sign in again'); setSendingReply(false); sendingReplyRef.current = false; return }
    let attachmentRefs: { fileName: string; filePath: string; contentType: string }[] = []
    if (replyAttachments.length > 0 && currentOrg?.id) {
      console.log('[Inbox Attachments] Sending with', replyAttachments.length, 'file(s):', replyAttachments.map((f) => ({ name: f.name, size: f.size, type: f.type })))
      for (const file of replyAttachments) {
        const path = `${currentOrg.id}/${selectedThreadId ?? 'compose'}/${Date.now()}-${file.name}`
        const { error } = await supabase.storage.from('inbox-attachments').upload(path, file)
        if (error) {
          console.warn('[Inbox Attachments] Upload failed for', file.name, error.message)
        } else {
          attachmentRefs.push({ fileName: file.name, filePath: path, contentType: file.type })
          console.log('[Inbox Attachments] Uploaded', file.name, '->', path)
        }
      }
      console.log('[Inbox Attachments] Payload attachments:', attachmentRefs)
    }
    const payload: Record<string, unknown> = {
      body: replyHtml,
      subject: replySubject,
      to: toAddr,
      cc: ccAddr || undefined,
      bcc: bccAddr ? bccAddr : undefined,
      isHtml: true,
      accountId: selectedAccountId || undefined,
      attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
    }
    if (selectedThreadId && replyMode !== 'compose' && replyMode !== 'forward') payload.threadId = selectedThreadId
    else payload.compose = true
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    setSendingReply(false)
    sendingReplyRef.current = false
    if (data?.error) { toast(data.error); return }
    console.log('[Inbox Attachments] Send success, clearing', replyAttachments.length, 'attachment(s)')
    setReplyMode(null); setReplyHtml(''); setReplyAttachments([])
    toast('Sent'); fetchThreads()
    if (selectedThreadId) fetchMessages(selectedThreadId)
  }

  const handleAddComment = async () => {
    if (!selectedThreadId || !commentText.trim() || !userId) return
    const mentionRegex = /@(\w+)/g
    const mentionNames = [...commentText.matchAll(mentionRegex)].map(m => m[1].toLowerCase())
    const mentionIds = inboxUsers.filter(u => mentionNames.some(n => u.display_name?.toLowerCase().includes(n) || u.email?.toLowerCase().includes(n))).map(u => u.user_id)
    await supabase.from('inbox_comments').insert({
      thread_id: selectedThreadId, user_id: userId, content: commentText.trim(),
      mentions: mentionIds.length > 0 ? mentionIds : null,
    })
    setCommentText(''); fetchComments(selectedThreadId)
  }

  const insertMention = (u: InboxUser) => {
    const name = u.display_name ?? u.email ?? 'user'
    setCommentText(prev => {
      // Replace the @partial with the full @name (e.g. "@mu" → "@Muaz Ali ")
      const atIdx = prev.lastIndexOf('@')
      if (atIdx >= 0) return prev.slice(0, atIdx) + `@${name} `
      return prev + `@${name} `
    })
    setShowMentionPicker(false)
  }

  const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim())

  const parseEmailChips = (value: string): { chips: string[]; current: string } => {
    const parts = value.split(',').map((s) => s.trim())
    const current = parts[parts.length - 1] ?? ''
    const chips = parts.length > 1 ? parts.slice(0, -1).filter(Boolean) : []
    return { chips, current }
  }

  const getSuggestionsForCurrent = (current: string, chips: string[], limit = 8) => {
    const q = current.trim().toLowerCase()
    if (q.length < 2) return []
    const chipSet = new Set(chips.map((c) => c.toLowerCase()))
    return emailSuggestionSource
      .filter((s) => !chipSet.has(s.email.toLowerCase()) && (s.email.toLowerCase().includes(q) || (s.name && s.name.toLowerCase().includes(q))))
      .slice(0, limit)
  }

  const handleEmailChipsChange = (
    field: 'to' | 'cc' | 'bcc',
    effectiveValue: string,
    setValue: (v: string) => void,
    newInput: string
  ) => {
    const { chips } = parseEmailChips(effectiveValue)
    const parts = newInput.split(',').map((s) => s.trim())
    const committed = parts.slice(0, -1).filter(Boolean)
    const lastPart = parts[parts.length - 1] ?? ''
    const validCommitted = committed.filter(isValidEmail)
    const invalidCommitted = committed.filter((s) => !isValidEmail(s))
    const newChips = [...chips, ...validCommitted]
    const newCurrent = [...invalidCommitted, lastPart].filter(Boolean).join(', ')
    const next = newChips.length > 0 && !newCurrent
      ? newChips.join(', ') + ', '
      : [...newChips, newCurrent].filter(Boolean).join(', ')
    setValue(next.replace(/,\s*,/g, ',').replace(/^\s*,\s*/, ''))
    setActiveSuggestionsField(newCurrent.length >= 2 ? field : null)
  }

  const removeEmailChip = (_field: 'to' | 'cc' | 'bcc', effectiveValue: string, setValue: (v: string) => void, email: string) => {
    const { chips, current } = parseEmailChips(effectiveValue)
    const newChips = chips.filter((e) => e !== email)
    setValue([...newChips, current].filter(Boolean).join(', '))
  }

  const selectEmailSuggestion = (_field: 'to' | 'cc' | 'bcc', effectiveValue: string, setValue: (v: string) => void, email: string) => {
    const { chips } = parseEmailChips(effectiveValue)
    setValue([...chips, email].join(', ') + ', ')
    setActiveSuggestionsField(null)
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

  // File drop handling
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files)
      console.log('[Inbox Attachments] Drop added', files.length, 'file(s):', files.map((f) => ({ name: f.name, size: f.size })))
      setReplyAttachments((prev) => [...prev, ...files])
    }
  }
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }
  const handleDragLeave = () => setIsDragging(false)

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const removeReplyAttachment = (index: number) => {
    const file = replyAttachments[index]
    console.log('[Inbox Attachments] Removed', file?.name, '(index', index, '), remaining:', replyAttachments.length - 1)
    setReplyAttachments((prev) => prev.filter((_, j) => j !== index))
  }

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
            {(() => {
              const toVal = pendingReplyToRef.current != null ? pendingReplyToRef.current : replyTo
              const { chips, current } = parseEmailChips(toVal)
              const setTo = (v: string) => { pendingReplyToRef.current = null; setReplyTo(v) }
              const toSuggestionsList = activeSuggestionsField === 'to' ? getSuggestionsForCurrent(current, chips) : []
              return (
                <>
                  <div className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface-muted px-2 py-1.5 min-h-[34px] focus-within:ring-1 focus-within:ring-accent">
                    {chips.map((email) => (
                      <span key={email} className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded bg-surface-elevated text-sm text-gray-200">
                        {email}
                        <button type="button" onClick={() => removeEmailChip('to', toVal, setTo, email)} className="text-gray-500 hover:text-red-400 p-0.5" aria-label="Remove">&times;</button>
                      </span>
                    ))}
                    <input type="text" value={current} onChange={e => handleEmailChipsChange('to', toVal, setTo, e.target.value)} onFocus={() => current.length >= 2 && setActiveSuggestionsField('to')} onBlur={() => setTimeout(() => setActiveSuggestionsField(null), 200)} placeholder={chips.length ? '' : 'recipient@example.com'}
                      className="flex-1 min-w-[120px] bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none py-0.5" />
                  </div>
                  {toSuggestionsList.length > 0 && (
                    <div className="absolute top-full left-0 mt-1 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto w-full z-20">
                      {toSuggestionsList.map((s) => (
                        <button key={s.email} type="button" onMouseDown={() => selectEmailSuggestion('to', toVal, setTo, s.email)}
                          className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-muted flex items-center justify-between">
                          <span>{s.name}</span>
                          <span className="text-xs text-gray-500">{s.email}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
          {!showCcBcc && <button type="button" onClick={() => setShowCcBcc(true)} className="text-xs text-gray-400 hover:text-accent"><ChevronDown className="w-4 h-4" /></button>}
        </div>
        {showCcBcc && (
          <>
            <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-12 shrink-0">Cc</label>
              <div className="flex-1 relative">
                {(() => {
                  const ccVal = pendingReplyCcRef.current != null ? pendingReplyCcRef.current : replyCc
                  const { chips, current } = parseEmailChips(ccVal)
                  const setCc = (v: string) => { pendingReplyCcRef.current = null; setReplyCc(v) }
                  const ccSuggestionsList = activeSuggestionsField === 'cc' ? getSuggestionsForCurrent(current, chips) : []
                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface-muted px-2 py-1.5 min-h-[34px] focus-within:ring-1 focus-within:ring-accent">
                        {chips.map((email) => (
                          <span key={email} className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded bg-surface-elevated text-sm text-gray-200">
                            {email}
                            <button type="button" onClick={() => removeEmailChip('cc', ccVal, setCc, email)} className="text-gray-500 hover:text-red-400 p-0.5" aria-label="Remove">&times;</button>
                          </span>
                        ))}
                        <input type="text" value={current} onChange={e => handleEmailChipsChange('cc', ccVal, setCc, e.target.value)} onFocus={() => current.length >= 2 && setActiveSuggestionsField('cc')} onBlur={() => setTimeout(() => setActiveSuggestionsField(null), 200)} placeholder={chips.length ? '' : 'Cc'}
                          className="flex-1 min-w-[100px] bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none py-0.5" />
                      </div>
                      {ccSuggestionsList.length > 0 && (
                        <div className="absolute top-full left-0 mt-1 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto w-full z-20">
                          {ccSuggestionsList.map((s) => (
                            <button key={s.email} type="button" onMouseDown={() => selectEmailSuggestion('cc', ccVal, setCc, s.email)}
                              className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-muted flex items-center justify-between">
                              <span>{s.name}</span>
                              <span className="text-xs text-gray-500">{s.email}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            </div>
            <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-12 shrink-0">Bcc</label>
              <div className="flex-1 relative">
                {(() => {
                  const { chips, current } = parseEmailChips(replyBcc)
                  const bccSuggestionsList = activeSuggestionsField === 'bcc' ? getSuggestionsForCurrent(current, chips) : []
                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface-muted px-2 py-1.5 min-h-[34px] focus-within:ring-1 focus-within:ring-accent">
                        {chips.map((email) => (
                          <span key={email} className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded bg-surface-elevated text-sm text-gray-200">
                            {email}
                            <button type="button" onClick={() => removeEmailChip('bcc', replyBcc, setReplyBcc, email)} className="text-gray-500 hover:text-red-400 p-0.5" aria-label="Remove">&times;</button>
                          </span>
                        ))}
                        <input type="text" value={current} onChange={e => handleEmailChipsChange('bcc', replyBcc, setReplyBcc, e.target.value)} onFocus={() => current.length >= 2 && setActiveSuggestionsField('bcc')} onBlur={() => setTimeout(() => setActiveSuggestionsField(null), 200)} placeholder={chips.length ? '' : 'Bcc'}
                          className="flex-1 min-w-[100px] bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none py-0.5" />
                      </div>
                      {bccSuggestionsList.length > 0 && (
                        <div className="absolute top-full left-0 mt-1 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto w-full z-20">
                          {bccSuggestionsList.map((s) => (
                            <button key={s.email} type="button" onMouseDown={() => selectEmailSuggestion('bcc', replyBcc, setReplyBcc, s.email)}
                              className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-muted flex items-center justify-between">
                              <span>{s.name}</span>
                              <span className="text-xs text-gray-500">{s.email}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            </div>
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 shrink-0">Attachments:</span>
          {replyAttachments.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1.5 rounded-md bg-surface-muted border border-border text-xs text-gray-200"
            >
              <Paperclip className="w-3.5 h-3.5 shrink-0 text-gray-500" />
              <span className="max-w-[160px] truncate" title={f.name}>{f.name}</span>
              <span className="text-gray-500 shrink-0">({formatFileSize(f.size)})</span>
              <button
                type="button"
                onClick={() => removeReplyAttachment(i)}
                className="shrink-0 p-0.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Remove attachment"
                aria-label={`Remove ${f.name}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={handleSendReply} disabled={sendingReply || !(pendingReplyToRef.current ?? replyTo).trim()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
          <Send className="w-4 h-4" /> {sendingReply ? 'Sending…' : 'Send'}
        </button>
        <label className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted cursor-pointer inline-flex items-center justify-center" title="Attach file" htmlFor="inbox-reply-file-input">
          <Paperclip className="w-4 h-4" />
        </label>
        <input
          id="inbox-reply-file-input"
          ref={replyFileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              const files = Array.from(e.target.files)
              console.log('[Inbox Attachments] Picker added', files.length, 'file(s):', files.map((f) => ({ name: f.name, size: f.size, type: f.type })))
              setReplyAttachments((prev) => [...prev, ...files])
            }
            e.target.value = ''
          }}
        />
        <button type="button" onClick={() => { pendingReplyToRef.current = null; pendingReplyCcRef.current = null; setReplyMode(null) }} className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted ml-auto">Cancel</button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="inbox-page">
      {toastMsg && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-accent text-white text-sm shadow-lg">{toastMsg}</div>}

      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {FILTERS.map(f => (
            <button key={f.id} type="button" onClick={() => { setFilter(f.id); setSelectedThreadId(null); initialLoadDone.current = false }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                filter === f.id ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300 hover:bg-surface-muted/80'}`}>
              <f.icon className="w-3.5 h-3.5" /> {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={handleSync} disabled={syncing} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted disabled:opacity-50" title="Sync emails">
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={() => { setSelectedThreadId(null); openReply('compose') }}
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

          {loading ? <div className="p-4 text-gray-400 text-sm">Loading…</div>
          : filteredThreads.length === 0 ? (
            <div className="p-4 text-gray-400 text-sm text-center mt-8"><InboxIcon className="w-8 h-8 mx-auto mb-2 opacity-40" /><p>No threads</p></div>
          ) : (
            <ul className="overflow-y-auto divide-y divide-border flex-1">
              {filteredThreads.map(t => {
                const assignees = (Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments : []) as { user_id: string }[]
                const unread = isUnread(t)
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => { setSelectedThreadId(t.id); setReplyMode(null) }}
                      className={`w-full text-left px-4 py-3 transition-colors ${selectedThreadId === t.id ? 'bg-surface-muted' : 'hover:bg-surface-muted/50'}`}>
                      <div className="flex items-start gap-2">
                        {/* Unread indicator */}
                        <div className="mt-2 shrink-0">
                          {unread ? <Circle className="w-2 h-2 fill-accent text-accent" /> : <div className="w-2 h-2" />}
                        </div>
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
                          <div className="flex items-center gap-2 mt-1">
                            {t.status === 'closed' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">closed</span>}
                            {t.status === 'archived' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">trash</span>}
                            {assignees.length > 0 && (
                              <span className="inline-flex items-center gap-0.5">
                                {assignees.slice(0, 3).map(a => {
                                  const av = getUserAvatar(a.user_id)
                                  return av ? (
                                    <img key={a.user_id} src={av} alt="" className="w-4 h-4 rounded-full" title={getUserName(a.user_id)} />
                                  ) : (
                                    <span key={a.user_id} className="w-4 h-4 rounded-full bg-accent/20 flex items-center justify-center text-[8px] font-medium text-accent" title={getUserName(a.user_id)}>
                                      {(getUserName(a.user_id))[0]?.toUpperCase()}
                                    </span>
                                  )
                                })}
                                {assignees.length > 3 && <span className="text-[9px] text-gray-500 ml-0.5">+{assignees.length - 3}</span>}
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
                <button type="button" onClick={() => setReplyMode(null)} className="md:hidden p-1 rounded text-gray-400 hover:text-white"><ChevronRight className="w-4 h-4 rotate-180" /></button>
                <h2 className="text-white font-medium text-sm">New message</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-4">{renderReplyForm(true)}</div>
            </div>
          ) : selectedThread && (
            <>
              {/* Thread header */}
              <div className="border-b border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2 mb-2">
                  <button type="button" onClick={() => { setSelectedThreadId(null); setReplyMode(null) }} className="md:hidden p-1 rounded text-gray-400 hover:text-white"><ChevronRight className="w-4 h-4 rotate-180" /></button>
                  <h2 className="text-white font-medium truncate flex-1 text-sm">{selectedThread.subject || '(No subject)'}</h2>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${selectedThread.status === 'open' ? 'bg-accent/20 text-accent' : selectedThread.status === 'closed' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{selectedThread.status}</span>
                  <button type="button" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/inbox/${selectedThread.id}`); toast('Thread link copied') }}
                    className="p-1 rounded text-gray-400 hover:text-white hover:bg-surface-muted" title="Copy thread link">
                    <Link2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Assigned people pills */}
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
                  {/* Add assignee dropdown */}
                  <select value="" onChange={e => { if (e.target.value) handleAssignTo(e.target.value) }} disabled={actionLoading}
                    className="rounded border border-border bg-surface-muted px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="">Assign</option>
                    {inboxUsers.filter(u => !currentAssignees.some(a => a.user_id === u.user_id)).map(u => (
                      <option key={u.user_id} value={u.user_id}>{u.display_name || u.email || u.user_id.slice(0, 8)}{u.user_id === userId ? ' (Me)' : ''}</option>
                    ))}
                  </select>
                  {selectedThread.status === 'open' && <button type="button" onClick={() => handleUpdateStatus('closed')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"><Check className="w-3 h-3" /> Close</button>}
                  {(selectedThread.status === 'closed' || selectedThread.status === 'archived') && <button type="button" onClick={() => handleUpdateStatus('open')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"><RotateCcw className="w-3 h-3" /> Re-open</button>}
                  {selectedThread.status !== 'archived' && <button type="button" onClick={() => handleUpdateStatus('archived')} disabled={actionLoading} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50"><Archive className="w-3 h-3" /> Trash</button>}
                  <div className="w-px h-4 bg-border mx-0.5" />
                  <button type="button" onClick={() => openReply('reply')} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"><Reply className="w-3 h-3" /> Reply</button>
                  <button type="button" onClick={() => openReply('reply_all')} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"><ReplyAll className="w-3 h-3" /> All</button>
                  <button type="button" onClick={() => openReply('forward')} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"><Forward className="w-3 h-3" /> Fwd</button>
                </div>
              </div>

              {/* Timeline */}
              <div className="flex-1 overflow-y-auto" onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
                {isDragging && <div className="mx-4 mt-4 p-4 rounded-lg border-2 border-dashed border-accent bg-accent/5 text-center text-accent text-sm">Drop files to attach</div>}
                <div className="p-4 space-y-4">
                  {attachments.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="text-gray-500">Attachments:</span>
                      {attachments.map((a) => {
                        const url = attachmentUrls[a.file_path]
                        const label = (
                          <>
                            <Download className="w-3 h-3" /> {a.file_name}
                          </>
                        )
                        return url ? (
                          <a key={a.id} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-muted text-gray-300 hover:text-accent">
                            {label}
                          </a>
                        ) : (
                          <span key={a.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-muted text-gray-500">
                            {label}
                          </span>
                        )
                      })}
                    </div>
                  )}

                  {messagesLoading ? <div className="text-gray-400 text-sm">Loading…</div> : (
                    timeline.map((item) => {
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
                              <p className="text-sm text-gray-200">{c.content}</p>
                            </div>
                          </div>
                        )
                      }
                      const m = item.data
                      const { html, content } = cleanMessageBody(m)
                      const sanitized = html ? sanitizeEmailHtml(content) : content
                      return (<React.Fragment key={`msg-${m.id}`}>
                        <article className="rounded-lg border border-border overflow-hidden group/msg">
                          <header className="px-4 py-2 border-b border-border text-[11px] text-gray-400 flex flex-wrap items-center gap-x-3 gap-y-0.5 bg-surface-elevated/50">
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 flex-1 min-w-0">
                              <span><span className="text-gray-500">From:</span> {renderEmail(m.from_identifier)}</span>
                              {m.to_identifier && <span><span className="text-gray-500">To:</span> {renderEmail(m.to_identifier)}</span>}
                              {m.cc && <span><span className="text-gray-500">Cc:</span> {m.cc}</span>}
                              {m.bcc && <span><span className="text-gray-500">Bcc:</span> {m.bcc}</span>}
                              <span className="ml-auto">{new Date(m.received_at).toLocaleString()}</span>
                            </div>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity shrink-0">
                              <button type="button" title="Reply" onClick={() => {
                                const toAddr = (m.from_identifier && m.from_identifier.trim()) ? m.from_identifier : (messages.filter(msg => msg.direction === 'inbound').pop() ?? messages[messages.length - 1])?.from_identifier ?? ''
                                const toPrefill = toAddr ? toAddr + ', ' : ''
                                pendingReplyToRef.current = toPrefill
                                pendingReplyCcRef.current = ''
                                setSelectedAccountId(findFromAccount(m.to_identifier, m.cc))
                                setReplyTo(toPrefill)
                                setReplyCc('')
                                setReplyBcc('')
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Re: ') ? selectedThread!.subject! : 'Re: ' + (selectedThread?.subject ?? ''))
                                setReplyHtml('')
                                setShowCcBcc(false)
                                setReplyAttachments([])
                                setReplyAnchorMsgId(m.id)
                                setReplyMode('reply')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><Reply className="w-3.5 h-3.5" /></button>
                              <button type="button" title="Reply All" onClick={() => {
                                const toAddr = (m.from_identifier && m.from_identifier.trim()) ? m.from_identifier : (messages.filter(msg => msg.direction === 'inbound').pop() ?? messages[messages.length - 1])?.from_identifier ?? ''
                                const ccRaw = m.cc ?? ''
                                const toPrefill = toAddr ? toAddr + ', ' : ''
                                const ccPrefill = ccRaw.trim() ? ccRaw.trim() + ', ' : ''
                                pendingReplyToRef.current = toPrefill
                                pendingReplyCcRef.current = ccPrefill
                                setSelectedAccountId(findFromAccount(m.to_identifier, m.cc))
                                setReplyTo(toPrefill)
                                setReplyCc(ccPrefill)
                                setReplyBcc('')
                                setShowCcBcc(!!(m.cc))
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Re: ') ? selectedThread!.subject! : 'Re: ' + (selectedThread?.subject ?? ''))
                                setReplyHtml('')
                                setReplyAttachments([])
                                setReplyAnchorMsgId(m.id)
                                setReplyMode('reply_all')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><ReplyAll className="w-3.5 h-3.5" /></button>
                              <button type="button" title="Forward" onClick={() => {
                                pendingReplyToRef.current = null
                                pendingReplyCcRef.current = null
                                setSelectedAccountId(findFromAccount(m.to_identifier, m.cc))
                                setReplyTo('')
                                setReplyCc('')
                                setReplyBcc('')
                                setShowCcBcc(false)
                                setReplySubject((selectedThread?.subject ?? '').startsWith('Fwd: ') ? selectedThread!.subject! : 'Fwd: ' + (selectedThread?.subject ?? ''))
                                const { content: fwdContent } = cleanMessageBody(m)
                                setReplyHtml(`<br/><br/>---------- Forwarded message ----------<br/><b>From:</b> ${m.from_identifier}<br/><b>Date:</b> ${new Date(m.received_at).toLocaleString()}<br/><b>Subject:</b> ${selectedThread?.subject ?? ''}<br/><br/>${fwdContent}`)
                                setReplyAttachments([])
                                setReplyAnchorMsgId(m.id)
                                setReplyMode('forward')
                              }} className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-muted"><Forward className="w-3.5 h-3.5" /></button>
                            </div>
                          </header>
                          {html ? (() => {
                            const { srcDoc, isDark } = buildEmailSrcDoc(sanitized)
                            return (
                              <div style={{ background: isDark ? '#0f0f0f' : '#fff' }}>
                                <iframe title="Email" srcDoc={srcDoc}
                                  className="w-full border-0 rounded-b" sandbox="allow-same-origin"
                                  onLoad={e => { const f = e.target as HTMLIFrameElement; if (f.contentDocument?.body) { f.style.height = Math.max(80, f.contentDocument.body.scrollHeight + 20) + 'px' } }}
                                  style={{ minHeight: '80px', background: isDark ? '#0f0f0f' : '#fff' }} />
                              </div>
                            )
                          })() : (
                            <div className="text-sm whitespace-pre-wrap break-words p-4 text-gray-200">{content}</div>
                          )}
                        </article>
                        {/* Render reply form directly below the anchored message; key forces remount when mode/anchor changes */}
                        {replyMode && replyMode !== 'compose' && replyAnchorMsgId === m.id && (
                          <div key={`reply-form-${replyMode}-${m.id}`} ref={replyFormContainerRef} className="mt-2">{renderReplyForm(replyMode === 'forward')}</div>
                        )}
                      </React.Fragment>)
                    })
                  )}

                  {/* Fallback: render at bottom if triggered from header buttons (no anchor); key forces remount when mode changes */}
                  {replyMode && replyMode !== 'compose' && !replyAnchorMsgId && (
                    <div key={`reply-form-${replyMode}-bottom`}>{renderReplyForm(replyMode === 'forward')}</div>
                  )}
                  <div ref={timelineEndRef} />
                </div>
              </div>

              {/* Comment input */}
              <div className="border-t border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-amber-400 shrink-0" />
                  <div className="flex-1 relative">
                    <input type="text" value={commentText} onChange={e => {
                      setCommentText(e.target.value)
                      if (e.target.value.endsWith('@')) setShowMentionPicker(true)
                      else if (!e.target.value.includes('@')) setShowMentionPicker(false)
                    }}
                      onKeyDown={e => { if (e.key === 'Enter' && commentText.trim()) handleAddComment() }}
                      placeholder="Add an internal comment… (type @ to mention)"
                      className="w-full rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
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
