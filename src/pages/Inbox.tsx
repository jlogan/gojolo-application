import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  Inbox as InboxIcon, User, Mail, MessageSquare, Check, Archive,
  List, ChevronRight, ChevronDown, Plus, Reply, ReplyAll, Forward,
  RotateCcw, Send, RefreshCw, UserPlus, Paperclip, Download, AtSign,
} from 'lucide-react'
import RichTextEditor from '@/components/inbox/RichTextEditor'

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
  from_identifier: string; to_identifier: string | null; cc: string | null
  body: string | null; html_body: string | null; received_at: string
}
type InboxComment = {
  id: string; thread_id: string; user_id: string; content: string
  mentions: string[] | null; created_at: string; display_name?: string | null
}
type Attachment = {
  id: string; message_id: string | null; thread_id: string
  file_name: string; file_path: string; file_size: number | null; created_at: string
}
type TimelineItem =
  | { kind: 'message'; data: InboxMessage; ts: string }
  | { kind: 'comment'; data: InboxComment; ts: string }
type InboxUser = { user_id: string; display_name: string | null; email: string | null }
type ImapAccount = { id: string; email: string; label: string | null; addresses: string[] | null }
type ContactMatch = { contact_id: string; name: string; email: string | null }

const FILTERS: { id: InboxFilter; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'assigned', label: 'Assigned to me', icon: User },
  { id: 'closed', label: 'Closed', icon: Check },
  { id: 'trash', label: 'Trash', icon: Archive },
  { id: 'all', label: 'All', icon: List },
]

export default function Inbox() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [comments, setComments] = useState<InboxComment[]>([])
  const [inboxUsers, setInboxUsers] = useState<InboxUser[]>([])
  const [imapAccounts, setImapAccounts] = useState<ImapAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // Reply
  const [replyMode, setReplyMode] = useState<'reply' | 'reply_all' | 'forward' | 'compose' | null>(null)
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

  // Contacts & attachments
  const [threadContacts, setThreadContacts] = useState<ContactMatch[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])

  const userId = user?.id ?? null
  const timelineEndRef = useRef<HTMLDivElement>(null)
  const replyFileRef = useRef<HTMLInputElement>(null)

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

  const fetchThreads = useCallback(async () => {
    if (!currentOrg?.id || !userId) return
    setLoading(true)
    try {
      let query = supabase.from('inbox_threads')
        .select('id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, inbox_thread_assignments(user_id)')
        .eq('org_id', currentOrg.id).order('last_message_at', { ascending: false })
      if (filter === 'inbox') query = query.eq('status', 'open')
      else if (filter === 'closed') query = query.eq('status', 'closed')
      else if (filter === 'trash') query = query.eq('status', 'archived')
      else if (filter === 'assigned') {
        const { data: assigned } = await supabase.from('inbox_thread_assignments').select('thread_id').eq('user_id', userId)
        const tids = (assigned ?? []).map((a: { thread_id: string }) => a.thread_id)
        if (!tids.length) { setThreads([]); setLoading(false); return }
        query = query.in('id', tids)
      }
      const { data } = await query
      setThreads((data as InboxThread[]) ?? [])
    } catch { setThreads([]) }
    setLoading(false)
  }, [currentOrg?.id, filter, userId])

  const fetchMessages = useCallback(async (tid: string) => {
    setMessagesLoading(true)
    const { data } = await supabase.from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, cc, body, html_body, received_at')
      .eq('thread_id', tid).order('received_at', { ascending: true })
    setMessages((data as InboxMessage[]) ?? [])
    setMessagesLoading(false)
    setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [])

  const fetchComments = useCallback(async (tid: string) => {
    const { data } = await supabase.from('inbox_comments').select('id, thread_id, user_id, content, mentions, created_at')
      .eq('thread_id', tid).order('created_at', { ascending: true })
    const rows = (data ?? []) as InboxComment[]
    if (rows.length > 0) {
      const uids = [...new Set(rows.map(c => c.user_id))]
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', uids)
      const nm = new Map((profiles ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]))
      rows.forEach(c => { c.display_name = nm.get(c.user_id) ?? null })
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
    setAttachments((data as Attachment[]) ?? [])
  }, [])

  // Load inbox users (anyone with inbox.view permission)
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.rpc('org_users_with_permission', { p_org_id: currentOrg.id, p_permission: 'inbox.view' })
      .then(({ data }) => {
        setInboxUsers((data ?? []) as InboxUser[])
      })
  }, [currentOrg?.id])

  // Load IMAP accounts
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.from('imap_accounts').select('id, email, label, addresses').eq('org_id', currentOrg.id).eq('is_active', true)
      .then(({ data }) => {
        const accs = (data as ImapAccount[]) ?? []
        setImapAccounts(accs)
        if (accs.length > 0 && !selectedAccountId) setSelectedAccountId(accs[0].id)
      })
  }, [currentOrg?.id])

  useEffect(() => { fetchThreads() }, [fetchThreads])

  // Realtime
  useEffect(() => {
    if (!currentOrg?.id) return
    const ch = supabase.channel('inbox-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_threads', filter: `org_id=eq.${currentOrg.id}` }, () => fetchThreads())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inbox_messages' }, (p) => {
        if ((p.new as { thread_id: string }).thread_id === selectedThreadId) fetchMessages(selectedThreadId!)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inbox_comments' }, (p) => {
        if ((p.new as { thread_id: string }).thread_id === selectedThreadId) fetchComments(selectedThreadId!)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [currentOrg?.id, selectedThreadId, fetchThreads, fetchMessages, fetchComments])

  useEffect(() => {
    if (!selectedThreadId) { setMessages([]); setComments([]); setThreadContacts([]); setAttachments([]); setReplyMode(null); return }
    fetchMessages(selectedThreadId); fetchComments(selectedThreadId); fetchThreadContacts(selectedThreadId); fetchAttachments(selectedThreadId)
    supabase.rpc('match_thread_contacts', { p_thread_id: selectedThreadId }).then(() => fetchThreadContacts(selectedThreadId))
  }, [selectedThreadId, fetchMessages, fetchComments, fetchThreadContacts, fetchAttachments])

  const selectedThread = threads.find(t => t.id === selectedThreadId)
  const getUserName = (uid: string) => inboxUsers.find(u => u.user_id === uid)?.display_name ?? uid.slice(0, 8)
  const currentAssigneeId = (selectedThread?.inbox_thread_assignments?.[0] as { user_id?: string } | undefined)?.user_id ?? ''
  const toast = (msg: string) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3000) }

  // Sync
  const handleSync = async () => {
    if (!currentOrg?.id || syncing) return
    setSyncing(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { toast('Please sign in again'); setSyncing(false); return }
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/imap-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ orgId: currentOrg.id }),
      })
      const data = await res.json().catch(() => ({}))
      const inserted = data?.messagesInserted ?? 0
      toast(inserted > 0 ? `Synced ${inserted} new message(s)` : 'No new messages')
    } catch (e) { toast((e as Error).message) }
    setSyncing(false)
    fetchThreads()
  }

  const handleAssignTo = async (uid: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_thread_assignments').upsert({ thread_id: selectedThreadId, user_id: uid }, { onConflict: 'thread_id' })
    await fetchThreads(); setActionLoading(false)
    toast(`Assigned to ${getUserName(uid)}`)
  }

  const handleUpdateStatus = async (status: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_threads').update({ status, updated_at: new Date().toISOString() }).eq('id', selectedThreadId)
    await fetchThreads(); setActionLoading(false)
    if (status === 'archived') { setSelectedThreadId(null); toast('Moved to trash') }
    else if (status === 'closed') toast('Thread closed')
    else toast('Thread re-opened')
  }

  // Get all sendable addresses from IMAP accounts
  const getSendableAddresses = (): { accountId: string; email: string; label: string }[] => {
    const addrs: { accountId: string; email: string; label: string }[] = []
    for (const acc of imapAccounts) {
      addrs.push({ accountId: acc.id, email: acc.email, label: acc.label ? `${acc.label} <${acc.email}>` : acc.email })
      for (const alias of acc.addresses ?? []) {
        if (alias.toLowerCase() !== acc.email.toLowerCase()) {
          addrs.push({ accountId: acc.id, email: alias, label: `${acc.label ?? 'Alias'} <${alias}>` })
        }
      }
    }
    return addrs
  }

  const openReply = (mode: 'reply' | 'reply_all' | 'forward' | 'compose') => {
    if (mode === 'compose') {
      setReplyTo(''); setReplyCc(''); setReplyBcc(''); setReplySubject(''); setReplyHtml(''); setShowCcBcc(false); setReplyAttachments([])
    } else if (selectedThread && messages.length > 0) {
      const last = messages.filter(m => m.direction === 'inbound').pop() ?? messages[messages.length - 1]
      setReplyTo(mode === 'forward' ? '' : last.from_identifier)
      const ccVal = mode === 'reply_all' ? [last.to_identifier, last.cc].filter(Boolean).join(', ') : ''
      setReplyCc(ccVal); setReplyBcc('')
      setShowCcBcc(!!ccVal)
      const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
      const subj = selectedThread.subject ?? ''
      setReplySubject(subj.startsWith(prefix) ? subj : prefix + subj)
      if (mode === 'forward') {
        const { content } = cleanMessageBody(last)
        setReplyHtml(`<br/><br/>---------- Forwarded message ----------<br/>${content}`)
      } else { setReplyHtml('') }
      setReplyAttachments([])
    }
    setReplyMode(mode)
    setTimeout(() => timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 200)
  }

  const handleSendReply = async () => {
    if (!replyTo.trim() && replyMode !== 'compose') { toast('Recipient required'); return }
    if (!replyHtml.trim()) { toast('Message body is empty'); return }
    setSendingReply(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { toast('Please sign in again'); setSendingReply(false); return }

    // Upload attachments first
    let attachmentRefs: { fileName: string; filePath: string; contentType: string }[] = []
    if (replyAttachments.length > 0 && currentOrg?.id) {
      for (const file of replyAttachments) {
        const path = `${currentOrg.id}/${selectedThreadId ?? 'compose'}/${Date.now()}-${file.name}`
        const { error } = await supabase.storage.from('inbox-attachments').upload(path, file)
        if (!error) attachmentRefs.push({ fileName: file.name, filePath: path, contentType: file.type })
      }
    }

    const payload: Record<string, unknown> = {
      body: replyHtml, subject: replySubject, to: replyTo.trim(),
      cc: replyCc.trim() || undefined, bcc: replyBcc.trim() || undefined,
      isHtml: true, accountId: selectedAccountId || undefined,
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
    if (data?.error) { toast(data.error); return }
    setReplyMode(null); setReplyHtml(''); setReplyAttachments([])
    toast('Sent')
    fetchThreads()
    if (selectedThreadId) fetchMessages(selectedThreadId)
  }

  // Comment
  const handleAddComment = async () => {
    if (!selectedThreadId || !commentText.trim() || !userId) return
    const mentionRegex = /@(\w+)/g
    const mentionNames = [...commentText.matchAll(mentionRegex)].map(m => m[1].toLowerCase())
    const mentionIds = inboxUsers.filter(u => mentionNames.some(n => u.display_name?.toLowerCase().includes(n))).map(u => u.user_id)
    await supabase.from('inbox_comments').insert({
      thread_id: selectedThreadId, user_id: userId, content: commentText.trim(),
      mentions: mentionIds.length > 0 ? mentionIds : null,
    })
    setCommentText('')
    fetchComments(selectedThreadId)
  }

  const insertMention = (u: InboxUser) => {
    setCommentText(prev => prev + `@${u.display_name ?? u.email ?? 'user'} `)
    setShowMentionPicker(false)
  }

  const handleCreateContact = async () => {
    if (!selectedThread || !currentOrg?.id) return
    const email = selectedThread.from_address || messages.find(m => m.direction === 'inbound')?.from_identifier
    if (!email) { toast('No email found'); return }
    const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const { data, error } = await supabase.from('contacts').insert({ org_id: currentOrg.id, name, email, type: 'primary' }).select('id').single()
    if (error) { toast(error.message); return }
    if (data) {
      await supabase.from('inbox_thread_contacts').insert({ thread_id: selectedThread.id, contact_id: (data as { id: string }).id })
      fetchThreadContacts(selectedThread.id); toast(`Contact "${name}" created`)
    }
  }

  const getDownloadUrl = (path: string) => supabase.storage.from('inbox-attachments').getPublicUrl(path).data.publicUrl

  if (!currentOrg) return <div className="p-4 md:p-6"><p className="text-gray-400">Select a workspace.</p></div>

  const sendableAddresses = getSendableAddresses()

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="inbox-page">
      {toastMsg && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-accent text-white text-sm shadow-lg">{toastMsg}</div>}

      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {FILTERS.map(f => (
            <button key={f.id} type="button" onClick={() => { setFilter(f.id); setSelectedThreadId(null) }}
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
          {loading ? <div className="p-4 text-gray-400 text-sm">Loading…</div>
          : threads.length === 0 ? (
            <div className="p-4 text-gray-400 text-sm text-center mt-8"><InboxIcon className="w-8 h-8 mx-auto mb-2 opacity-40" /><p>No threads</p></div>
          ) : (
            <ul className="overflow-y-auto divide-y divide-border flex-1">
              {threads.map(t => {
                const assignee = Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments[0] : null
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => { setSelectedThreadId(t.id); setReplyMode(null) }}
                      className={`w-full text-left px-4 py-3 transition-colors ${selectedThreadId === t.id ? 'bg-surface-muted' : 'hover:bg-surface-muted/50'}`}>
                      <div className="flex items-start gap-2">
                        <span className="mt-1 shrink-0 text-gray-500">{t.channel === 'email' ? <Mail className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-sm font-medium text-white truncate">{t.subject || '(No subject)'}</p>
                            <span className="text-[10px] text-gray-500 shrink-0">{new Date(t.last_message_at).toLocaleDateString()}</span>
                          </div>
                          <p className="text-xs text-gray-400 truncate mt-0.5">{t.from_address ?? ''}</p>
                          <div className="flex items-center gap-2 mt-1">
                            {t.status === 'closed' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">closed</span>}
                            {t.status === 'archived' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">trash</span>}
                            {assignee && <span className="text-[10px] text-gray-500">{getUserName(assignee.user_id)}</span>}
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
              <div className="flex-1 overflow-y-auto p-4">
                <div className="space-y-2 mb-4 max-w-2xl">
                  {sendableAddresses.length > 1 && (
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-14 shrink-0">From</label>
                      <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
                        className="flex-1 rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent">
                        {sendableAddresses.map((a, i) => <option key={i} value={a.accountId}>{a.label}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 w-14 shrink-0">To</label>
                    <input type="text" value={replyTo} onChange={e => setReplyTo(e.target.value)} placeholder="recipient@example.com"
                      className="flex-1 rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
                    {!showCcBcc && <button type="button" onClick={() => setShowCcBcc(true)} className="text-xs text-gray-400 hover:text-accent"><ChevronDown className="w-4 h-4" /></button>}
                  </div>
                  {showCcBcc && (
                    <>
                      <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-14 shrink-0">Cc</label>
                        <input type="text" value={replyCc} onChange={e => setReplyCc(e.target.value)} className="flex-1 rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" /></div>
                      <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-14 shrink-0">Bcc</label>
                        <input type="text" value={replyBcc} onChange={e => setReplyBcc(e.target.value)} className="flex-1 rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" /></div>
                    </>
                  )}
                  <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-14 shrink-0">Subject</label>
                    <input type="text" value={replySubject} onChange={e => setReplySubject(e.target.value)} placeholder="Subject"
                      className="flex-1 rounded border border-border bg-surface-muted px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" /></div>
                </div>
                <RichTextEditor content={replyHtml} onChange={setReplyHtml} placeholder="Write your message…" autofocus />
                {replyAttachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">{replyAttachments.map((f, i) => <span key={i} className="text-xs bg-surface-muted px-2 py-1 rounded text-gray-300">{f.name}</span>)}</div>
                )}
              </div>
              <div className="border-t border-border px-4 py-3 shrink-0 flex items-center gap-2">
                <button type="button" onClick={handleSendReply} disabled={sendingReply || !replyTo.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                  <Send className="w-4 h-4" /> {sendingReply ? 'Sending…' : 'Send'}
                </button>
                <button type="button" onClick={() => replyFileRef.current?.click()} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted" title="Attach file">
                  <Paperclip className="w-4 h-4" />
                </button>
                <input ref={replyFileRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files) setReplyAttachments(prev => [...prev, ...Array.from(e.target.files!)]); e.target.value = '' }} />
                <button type="button" onClick={() => setReplyMode(null)} className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted ml-auto">Cancel</button>
              </div>
            </div>
          ) : selectedThread && (
            <>
              {/* Thread header */}
              <div className="border-b border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2 mb-2">
                  <button type="button" onClick={() => { setSelectedThreadId(null); setReplyMode(null) }} className="md:hidden p-1 rounded text-gray-400 hover:text-white"><ChevronRight className="w-4 h-4 rotate-180" /></button>
                  <h2 className="text-white font-medium truncate flex-1 text-sm">{selectedThread.subject || '(No subject)'}</h2>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select value={currentAssigneeId} onChange={e => { if (e.target.value) handleAssignTo(e.target.value) }} disabled={actionLoading}
                    className="rounded border border-border bg-surface-muted px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="">Assign…</option>
                    {inboxUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name || u.email || u.user_id.slice(0, 8)}{u.user_id === userId ? ' (Me)' : ''}</option>)}
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
              <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    {threadContacts.length > 0 ? (
                      <><span className="text-gray-500">Contacts:</span>
                      {threadContacts.map(c => <Link key={c.contact_id} to={`/contacts/${c.contact_id}`} className="px-2 py-0.5 rounded bg-accent/10 text-accent hover:underline">{c.name}</Link>)}</>
                    ) : (
                      <button type="button" onClick={handleCreateContact} className="inline-flex items-center gap-1.5 text-gray-400 hover:text-accent"><UserPlus className="w-3.5 h-3.5" /> Create contact from this thread</button>
                    )}
                  </div>

                  {attachments.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="text-gray-500">Attachments:</span>
                      {attachments.map(a => <a key={a.id} href={getDownloadUrl(a.file_path)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-muted text-gray-300 hover:text-accent"><Download className="w-3 h-3" /> {a.file_name}</a>)}
                    </div>
                  )}

                  {messagesLoading ? <div className="text-gray-400 text-sm">Loading…</div> : (
                    timeline.map((item) => {
                      if (item.kind === 'comment') {
                        const c = item.data
                        return (
                          <div key={`cmt-${c.id}`} className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5"><MessageSquare className="w-4 h-4 text-amber-400" /></div>
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
                      const safe = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').replace(/on\w+="[^"]*"/gi, '')
                      return (
                        <article key={`msg-${m.id}`} className="rounded-lg border border-border overflow-hidden bg-surface-elevated/50">
                          <header className="px-4 py-2 border-b border-border text-[11px] text-gray-400 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className={m.direction === 'outbound' ? 'text-accent' : 'text-gray-300'}>
                              <span className="text-gray-500">From:</span> {m.from_identifier}
                            </span>
                            {m.to_identifier && <span><span className="text-gray-500">To:</span> {m.to_identifier}</span>}
                            {m.cc && <span><span className="text-gray-500">Cc:</span> {m.cc}</span>}
                            <span className="ml-auto">{new Date(m.received_at).toLocaleString()}</span>
                          </header>
                          <div className="p-4 text-gray-200">
                            {html ? (
                              <iframe title="Email" srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:0;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#e5e7eb;background:transparent;}a{color:#14b8a6;}img{max-width:100%;height:auto;}</style></head><body>${safe}</body></html>`}
                                className="w-full min-h-[80px] border-0 rounded bg-transparent" sandbox="allow-same-origin" style={{ height: 'min(400px, 50vh)' }} />
                            ) : (
                              <div className="text-sm whitespace-pre-wrap break-words">{content}</div>
                            )}
                          </div>
                        </article>
                      )
                    })
                  )}

                  {/* Inline reply */}
                  {replyMode && replyMode !== 'compose' && (
                    <div className="rounded-lg border border-accent/30 bg-surface-elevated p-4 space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-accent font-medium">{replyMode === 'reply' ? 'Reply' : replyMode === 'reply_all' ? 'Reply All' : 'Forward'}</span>
                      </div>
                      <div className="space-y-2">
                        {sendableAddresses.length > 1 && (
                          <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-10 shrink-0">From</label>
                            <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
                              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent">
                              {sendableAddresses.map((a, i) => <option key={i} value={a.accountId}>{a.label}</option>)}
                            </select>
                          </div>
                        )}
                        <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-10 shrink-0">To</label>
                          <input type="text" value={replyTo} onChange={e => setReplyTo(e.target.value)}
                            className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" />
                          {!showCcBcc && <button type="button" onClick={() => setShowCcBcc(true)} className="text-xs text-gray-400 hover:text-accent"><ChevronDown className="w-4 h-4" /></button>}
                        </div>
                        {showCcBcc && (
                          <>
                            <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-10 shrink-0">Cc</label>
                              <input type="text" value={replyCc} onChange={e => setReplyCc(e.target.value)} className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" /></div>
                            <div className="flex items-center gap-2"><label className="text-xs text-gray-500 w-10 shrink-0">Bcc</label>
                              <input type="text" value={replyBcc} onChange={e => setReplyBcc(e.target.value)} className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent" /></div>
                          </>
                        )}
                      </div>
                      <RichTextEditor content={replyHtml} onChange={setReplyHtml} placeholder="Write your reply…" autofocus />
                      {replyAttachments.length > 0 && (
                        <div className="flex flex-wrap gap-2">{replyAttachments.map((f, i) => <span key={i} className="text-xs bg-surface-muted px-2 py-1 rounded text-gray-300">{f.name}</span>)}</div>
                      )}
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={handleSendReply} disabled={sendingReply || !replyTo.trim()}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                          <Send className="w-4 h-4" /> {sendingReply ? 'Sending…' : 'Send'}
                        </button>
                        <button type="button" onClick={() => replyFileRef.current?.click()} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted" title="Attach file">
                          <Paperclip className="w-4 h-4" />
                        </button>
                        <input ref={replyFileRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files) setReplyAttachments(prev => [...prev, ...Array.from(e.target.files!)]); e.target.value = '' }} />
                        <button type="button" onClick={() => setReplyMode(null)} className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
                      </div>
                    </div>
                  )}
                  <div ref={timelineEndRef} />
                </div>
              </div>

              {/* Comment input */}
              <div className="border-t border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-amber-400 shrink-0" />
                  <div className="flex-1 relative">
                    <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && commentText.trim()) handleAddComment() }}
                      placeholder="Add an internal comment…"
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
                  <button type="button" onClick={() => setShowMentionPicker(!showMentionPicker)} className="p-1.5 rounded text-amber-400 hover:bg-surface-muted" title="Mention someone">
                    <AtSign className="w-4 h-4" />
                  </button>
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
