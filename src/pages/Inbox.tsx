import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  Inbox as InboxIcon, User, Mail, MessageSquare, Check, Archive,
  List, ChevronRight, Plus, Reply, ReplyAll, Forward, StickyNote,
  RotateCcw, Send, RefreshCw, UserPlus,
} from 'lucide-react'
import ComposeModal from '@/components/inbox/ComposeModal'
import RichTextEditor from '@/components/inbox/RichTextEditor'

type InboxFilter = 'inbox' | 'assigned' | 'closed' | 'trash' | 'all'
type ThreadAssignment = { user_id: string }

type InboxThread = {
  id: string; org_id: string; channel: string; status: string;
  subject: string | null; last_message_at: string; created_at: string;
  from_address: string | null; imap_account_id: string | null;
  inbox_thread_assignments?: ThreadAssignment[] | null
}

type InboxMessage = {
  id: string; thread_id: string; channel: string; direction: string;
  from_identifier: string; to_identifier: string | null; cc: string | null;
  body: string | null; html_body: string | null; received_at: string
}

type InboxNote = {
  id: string; thread_id: string; user_id: string; content: string;
  created_at: string; display_name?: string | null
}

type OrgMemberOption = { user_id: string; display_name: string | null }
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
  const [filter, setFilter] = useState<InboxFilter>('inbox')
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [notes, setNotes] = useState<InboxNote[]>([])
  const [members, setMembers] = useState<OrgMemberOption[]>([])
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // Compose
  const [composeOpen, setComposeOpen] = useState(false)
  const [replyMode, setReplyMode] = useState<'reply' | 'reply_all' | 'forward' | null>(null)

  // Reply inline
  const [replyHtml, setReplyHtml] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [showReplyBox, setShowReplyBox] = useState(false)

  // Notes
  const [noteText, setNoteText] = useState('')
  const [showNotes, setShowNotes] = useState(false)

  // Contacts
  const [threadContacts, setThreadContacts] = useState<ContactMatch[]>([])

  const userId = user?.id ?? null
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const looksLikeHtml = (text: string | null) =>
    text != null && /<\s*(html|div|p|table|body|span)[\s>]/i.test(text)

  const decodeQuotedPrintable = (s: string): string =>
    s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

  const cleanMessageBody = (msg: InboxMessage): { html: boolean; content: string } => {
    if (msg.html_body) return { html: true, content: msg.html_body }
    const body = msg.body
    if (!body || !body.trim()) return { html: false, content: '—' }
    const raw = body.trim()
    const boundaryMatch = raw.match(/boundary="?([^"\s;]+)"?/i)
    const boundary = boundaryMatch?.[1]
    const decodePart = (part: string, content: string): string =>
      /Content-Transfer-Encoding:\s*quoted-printable/i.test(part) ? decodeQuotedPrintable(content) : content
    if (boundary) {
      const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`, 'g'))
      let htmlPart = '', textPart = ''
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
    if (looksLikeHtml(raw)) return { html: true, content: raw }
    return { html: false, content: raw }
  }

  // Fetch threads
  const fetchThreads = useCallback(async () => {
    if (!currentOrg?.id || !userId) return
    setLoading(true)
    try {
      let query = supabase.from('inbox_threads')
        .select('id, org_id, channel, status, subject, last_message_at, created_at, from_address, imap_account_id, inbox_thread_assignments(user_id)')
        .eq('org_id', currentOrg.id)
        .order('last_message_at', { ascending: false })

      if (filter === 'inbox') query = query.eq('status', 'open')
      else if (filter === 'closed') query = query.eq('status', 'closed')
      else if (filter === 'trash') query = query.eq('status', 'archived')
      else if (filter === 'assigned') {
        const { data: assigned } = await supabase.from('inbox_thread_assignments').select('thread_id').eq('user_id', userId)
        const tids = (assigned ?? []).map((a: { thread_id: string }) => a.thread_id)
        if (tids.length === 0) { setThreads([]); setLoading(false); return }
        query = query.in('id', tids)
      }

      const { data, error } = await query
      if (error) throw error
      setThreads((data as InboxThread[]) ?? [])
    } catch (e) {
      console.error(e)
      setThreads([])
    }
    setLoading(false)
  }, [currentOrg?.id, filter, userId])

  // Fetch messages
  const fetchMessages = useCallback(async (threadId: string) => {
    setMessagesLoading(true)
    const { data } = await supabase.from('inbox_messages')
      .select('id, thread_id, channel, direction, from_identifier, to_identifier, cc, body, html_body, received_at')
      .eq('thread_id', threadId)
      .order('received_at', { ascending: true })
    setMessages((data as InboxMessage[]) ?? [])
    setMessagesLoading(false)
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [])

  // Fetch notes
  const fetchNotes = useCallback(async (threadId: string) => {
    const { data } = await supabase.from('inbox_notes')
      .select('id, thread_id, user_id, content, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
    const noteRows = (data ?? []) as InboxNote[]
    if (noteRows.length > 0) {
      const uids = [...new Set(noteRows.map(n => n.user_id))]
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', uids)
      const nameMap = new Map((profiles ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]))
      noteRows.forEach(n => { n.display_name = nameMap.get(n.user_id) ?? null })
    }
    setNotes(noteRows)
  }, [])

  // Fetch thread contacts
  const fetchThreadContacts = useCallback(async (threadId: string) => {
    const { data } = await supabase.from('inbox_thread_contacts')
      .select('contact_id, contacts(name, email)')
      .eq('thread_id', threadId)
    setThreadContacts((data ?? []).map((r: { contact_id: string; contacts: { name: string; email: string | null } | { name: string; email: string | null }[] | null }) => {
      const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
      return { contact_id: r.contact_id, name: c?.name ?? '', email: c?.email ?? null }
    }))
  }, [])

  // Load members
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase.from('organization_users').select('user_id, profiles(display_name)')
      .eq('org_id', currentOrg.id)
      .then(({ data }) => {
        setMembers((data ?? []).map((r: { user_id: string; profiles: { display_name: string | null } | { display_name: string | null }[] | null }) => {
          const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
          return { user_id: r.user_id, display_name: p?.display_name ?? null }
        }))
      })
  }, [currentOrg?.id])

  useEffect(() => { fetchThreads() }, [fetchThreads])

  // Realtime subscription
  useEffect(() => {
    if (!currentOrg?.id) return
    const channel = supabase.channel('inbox-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_threads', filter: `org_id=eq.${currentOrg.id}` }, () => { fetchThreads() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inbox_messages' }, (payload) => {
        const msg = payload.new as { thread_id: string }
        if (msg.thread_id === selectedThreadId) fetchMessages(selectedThreadId)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [currentOrg?.id, selectedThreadId, fetchThreads, fetchMessages])

  // Load thread detail
  useEffect(() => {
    if (!selectedThreadId) { setMessages([]); setNotes([]); setThreadContacts([]); setShowReplyBox(false); setShowNotes(false); return }
    fetchMessages(selectedThreadId)
    fetchNotes(selectedThreadId)
    fetchThreadContacts(selectedThreadId)
    supabase.rpc('match_thread_contacts', { p_thread_id: selectedThreadId }).then(() => fetchThreadContacts(selectedThreadId))
  }, [selectedThreadId, fetchMessages, fetchNotes, fetchThreadContacts])

  const selectedThread = threads.find(t => t.id === selectedThreadId)
  const getMemberName = (uid: string) => members.find(m => m.user_id === uid)?.display_name ?? uid.slice(0, 8)
  const currentAssigneeId = (selectedThread?.inbox_thread_assignments?.[0] as { user_id?: string } | undefined)?.user_id ?? ''

  const toast = (msg: string) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3000) }

  const handleAssignTo = async (uid: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_thread_assignments').upsert({ thread_id: selectedThreadId, user_id: uid }, { onConflict: 'thread_id' })
    await fetchThreads(); setActionLoading(false)
    toast(`Assigned to ${getMemberName(uid)}`)
  }

  const handleUpdateStatus = async (status: string) => {
    if (!selectedThreadId) return
    setActionLoading(true)
    await supabase.from('inbox_threads').update({ status, updated_at: new Date().toISOString() }).eq('id', selectedThreadId)
    await fetchThreads(); setActionLoading(false)
    if (status === 'archived') { setSelectedThreadId(null); toast('Moved to trash') }
    else if (status === 'closed') toast('Thread closed')
    else if (status === 'open') toast('Thread re-opened')
  }

  // Reply
  const handleSendReply = async () => {
    if (!selectedThreadId || !replyHtml.trim() || selectedThread?.channel !== 'email') return
    const lastInbound = messages.filter(m => m.direction === 'inbound').pop()
    const toAddress = lastInbound?.from_identifier ?? messages[messages.length - 1]?.from_identifier ?? ''
    if (!toAddress?.includes('@')) { toast('Cannot determine recipient'); return }
    setSendingReply(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { toast('Please sign in again'); setSendingReply(false); return }
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
      body: JSON.stringify({ threadId: selectedThreadId, body: replyHtml, subject: selectedThread?.subject, to: toAddress, isHtml: true }),
    })
    const data = await res.json().catch(() => ({}))
    setSendingReply(false)
    if (data?.error) { toast(data.error); return }
    setReplyHtml(''); setShowReplyBox(false)
    toast('Reply sent')
    fetchMessages(selectedThreadId)
    fetchThreads()
  }

  // Reply All / Forward via compose modal
  const openReplyMode = (mode: 'reply' | 'reply_all' | 'forward') => {
    if (!selectedThread || messages.length === 0) return
    setReplyMode(mode)
    setComposeOpen(true)
  }

  const getReplyTo = () => {
    if (!replyMode || !selectedThread || messages.length === 0) return undefined
    const lastInbound = messages.filter(m => m.direction === 'inbound').pop() ?? messages[messages.length - 1]
    const { content } = cleanMessageBody(lastInbound)
    return {
      threadId: replyMode === 'forward' ? '' : selectedThread.id,
      to: replyMode === 'forward' ? '' : lastInbound.from_identifier,
      cc: replyMode === 'reply_all' ? [lastInbound.to_identifier, lastInbound.cc].filter(Boolean).join(', ') : undefined,
      subject: selectedThread.subject ?? '',
      mode: replyMode,
      originalBody: content,
    }
  }

  // Add note
  const handleAddNote = async () => {
    if (!selectedThreadId || !noteText.trim() || !userId) return
    await supabase.from('inbox_notes').insert({ thread_id: selectedThreadId, user_id: userId, content: noteText.trim() })
    setNoteText('')
    fetchNotes(selectedThreadId)
    toast('Note added')
  }

  // Create contact from thread
  const handleCreateContact = async () => {
    if (!selectedThread || !currentOrg?.id) return
    const email = selectedThread.from_address || messages.find(m => m.direction === 'inbound')?.from_identifier
    if (!email) { toast('No email address to create contact from'); return }
    const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const { data, error } = await supabase.from('contacts').insert({ org_id: currentOrg.id, name, email, type: 'primary' }).select('id').single()
    if (error) { toast(error.message); return }
    if (data) {
      await supabase.from('inbox_thread_contacts').insert({ thread_id: selectedThread.id, contact_id: (data as { id: string }).id })
      fetchThreadContacts(selectedThread.id)
      toast(`Contact "${name}" created`)
    }
  }

  if (!currentOrg) return <div className="p-4 md:p-6"><p className="text-gray-400">Select a workspace.</p></div>

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="inbox-page">
      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-accent text-white text-sm shadow-lg">
          {toastMsg}
        </div>
      )}

      {/* Compose Modal */}
      <ComposeModal open={composeOpen} onClose={() => { setComposeOpen(false); setReplyMode(null) }}
        onSent={() => { fetchThreads(); if (selectedThreadId) fetchMessages(selectedThreadId) }}
        replyTo={getReplyTo()} />

      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {FILTERS.map(f => (
            <button key={f.id} type="button" onClick={() => { setFilter(f.id); setSelectedThreadId(null) }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                filter === f.id ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300 hover:bg-surface-muted/80'
              }`}>
              <f.icon className="w-3.5 h-3.5" /> {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={() => fetchThreads()} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => { setReplyMode(null); setComposeOpen(true) }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90">
            <Plus className="w-3.5 h-3.5" /> Compose
          </button>
        </div>
      </div>

      {/* Main: Thread List + Detail */}
      <div className="flex flex-1 min-h-0">
        {/* Thread list */}
        <div className={`${selectedThreadId ? 'hidden md:flex' : 'flex'} w-full md:w-80 lg:w-96 flex-col border-r border-border bg-surface-muted/20 shrink-0`}>
          {loading ? (
            <div className="p-4 text-gray-400 text-sm">Loading…</div>
          ) : threads.length === 0 ? (
            <div className="p-4 text-gray-400 text-sm text-center mt-8">
              <InboxIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>No threads</p>
            </div>
          ) : (
            <ul className="overflow-y-auto divide-y divide-border flex-1">
              {threads.map(t => {
                const assignee = Array.isArray(t.inbox_thread_assignments) ? t.inbox_thread_assignments[0] : null
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => setSelectedThreadId(t.id)}
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
                            {assignee && <span className="text-[10px] text-gray-500">{getMemberName(assignee.user_id)}</span>}
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

        {/* Thread detail */}
        <div className={`${selectedThreadId ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0 min-h-0`}>
          {!selectedThread ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Select a thread</div>
          ) : (
            <>
              {/* Thread header */}
              <div className="border-b border-border px-4 py-2.5 shrink-0">
                <div className="flex items-center gap-2 mb-2">
                  <button type="button" onClick={() => setSelectedThreadId(null)} className="md:hidden p-1 rounded text-gray-400 hover:text-white">
                    <ChevronRight className="w-4 h-4 rotate-180" />
                  </button>
                  <h2 className="text-white font-medium truncate flex-1 text-sm">{selectedThread.subject || '(No subject)'}</h2>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Assign */}
                  <select value={currentAssigneeId} onChange={e => { if (e.target.value) handleAssignTo(e.target.value) }} disabled={actionLoading}
                    className="rounded border border-border bg-surface-muted px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="">Assign…</option>
                    {members.map(m => <option key={m.user_id} value={m.user_id}>{m.display_name || m.user_id.slice(0, 8)}{m.user_id === userId ? ' (Me)' : ''}</option>)}
                  </select>
                  {/* Status actions */}
                  {selectedThread.status === 'open' && (
                    <button type="button" onClick={() => handleUpdateStatus('closed')} disabled={actionLoading}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50">
                      <Check className="w-3 h-3" /> Close
                    </button>
                  )}
                  {(selectedThread.status === 'closed' || selectedThread.status === 'archived') && (
                    <button type="button" onClick={() => handleUpdateStatus('open')} disabled={actionLoading}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50">
                      <RotateCcw className="w-3 h-3" /> Re-open
                    </button>
                  )}
                  {selectedThread.status !== 'archived' && (
                    <button type="button" onClick={() => handleUpdateStatus('archived')} disabled={actionLoading}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80 disabled:opacity-50">
                      <Archive className="w-3 h-3" /> Trash
                    </button>
                  )}
                  <div className="w-px h-4 bg-border mx-0.5" />
                  {/* Reply actions */}
                  <button type="button" onClick={() => setShowReplyBox(!showReplyBox)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80">
                    <Reply className="w-3 h-3" /> Reply
                  </button>
                  <button type="button" onClick={() => openReplyMode('reply_all')}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80">
                    <ReplyAll className="w-3 h-3" /> All
                  </button>
                  <button type="button" onClick={() => openReplyMode('forward')}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80">
                    <Forward className="w-3 h-3" /> Fwd
                  </button>
                  <div className="w-px h-4 bg-border mx-0.5" />
                  <button type="button" onClick={() => setShowNotes(!showNotes)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${showNotes ? 'bg-yellow-500/20 text-yellow-400' : 'bg-surface-muted text-gray-200 hover:bg-surface-muted/80'}`}>
                    <StickyNote className="w-3 h-3" /> Notes {notes.length > 0 && `(${notes.length})`}
                  </button>
                </div>
              </div>

              {/* Messages + notes */}
              <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                  {/* Contact matches */}
                  {threadContacts.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="text-gray-500">Contacts:</span>
                      {threadContacts.map(c => (
                        <Link key={c.contact_id} to={`/contacts/${c.contact_id}`}
                          className="px-2 py-0.5 rounded bg-accent/10 text-accent hover:underline">{c.name}</Link>
                      ))}
                    </div>
                  )}
                  {threadContacts.length === 0 && (
                    <button type="button" onClick={handleCreateContact}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-accent">
                      <UserPlus className="w-3.5 h-3.5" /> Create contact from this thread
                    </button>
                  )}

                  {messagesLoading ? (
                    <div className="text-gray-400 text-sm">Loading messages…</div>
                  ) : (
                    messages.map(m => {
                      const { html, content } = cleanMessageBody(m)
                      const safeHtml = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').replace(/on\w+="[^"]*"/gi, '')
                      return (
                        <article key={m.id} className="rounded-lg border border-border overflow-hidden bg-surface-elevated/50">
                          <header className="px-4 py-2 border-b border-border text-[11px] text-gray-400 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className={m.direction === 'outbound' ? 'text-accent' : 'text-gray-300'}>
                              <span className="text-gray-500">{m.direction === 'outbound' ? 'Sent by' : 'From'}:</span> {m.from_identifier}
                            </span>
                            {m.to_identifier && <span><span className="text-gray-500">To:</span> {m.to_identifier}</span>}
                            {m.cc && <span><span className="text-gray-500">Cc:</span> {m.cc}</span>}
                            <span className="ml-auto">{new Date(m.received_at).toLocaleString()}</span>
                          </header>
                          <div className="p-4 text-gray-200">
                            {html ? (
                              <iframe title="Message body"
                                srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:0;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#e5e7eb;background:transparent;}a{color:#14b8a6;}img{max-width:100%;height:auto;}</style></head><body>${safeHtml}</body></html>`}
                                className="w-full min-h-[80px] border-0 rounded bg-transparent"
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

                  {/* Internal notes */}
                  {showNotes && (
                    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
                      <h3 className="text-xs font-medium text-yellow-400 flex items-center gap-1.5"><StickyNote className="w-3.5 h-3.5" /> Internal notes</h3>
                      {notes.map(n => (
                        <div key={n.id} className="text-sm">
                          <div className="flex items-baseline gap-2 text-[11px] text-gray-500">
                            <span className="text-yellow-400/80">{n.display_name ?? n.user_id.slice(0, 8)}</span>
                            <span>{new Date(n.created_at).toLocaleString()}</span>
                          </div>
                          <p className="text-gray-200 mt-0.5">{n.content}</p>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <input type="text" value={noteText} onChange={e => setNoteText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleAddNote() }}
                          placeholder="Add a note…"
                          className="flex-1 rounded border border-yellow-500/30 bg-surface-muted px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-yellow-500/50" />
                        <button type="button" onClick={handleAddNote} disabled={!noteText.trim()}
                          className="px-3 py-1.5 rounded bg-yellow-500/20 text-yellow-400 text-sm font-medium hover:bg-yellow-500/30 disabled:opacity-50">
                          Add
                        </button>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </div>

              {/* Reply box */}
              {showReplyBox && selectedThread.channel === 'email' && (
                <div className="border-t border-border p-4 shrink-0 space-y-2">
                  <RichTextEditor content={replyHtml} onChange={setReplyHtml} placeholder="Write your reply…" autofocus />
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={handleSendReply} disabled={sendingReply || !replyHtml.trim()}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                      <Send className="w-4 h-4" /> {sendingReply ? 'Sending…' : 'Send reply'}
                    </button>
                    <button type="button" onClick={() => { setShowReplyBox(false); setReplyHtml('') }}
                      className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted">Cancel</button>
                  </div>
                </div>
              )}

              {/* SMS quick reply */}
              {selectedThread.channel === 'sms' && (
                <div className="border-t border-border p-4 shrink-0">
                  <p className="text-gray-500 text-xs">SMS reply coming soon (Twilio integration).</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
