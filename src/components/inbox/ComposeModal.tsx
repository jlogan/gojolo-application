import { useState, useEffect } from 'react'
import { X, Send, ChevronDown } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useOrg } from '@/contexts/OrgContext'
import RichTextEditor from './RichTextEditor'

type ImapAccount = { id: string; email: string; label: string | null; addresses: string[] | null }

type Props = {
  open: boolean
  onClose: () => void
  onSent?: () => void
  replyTo?: { threadId: string; to: string; cc?: string; subject: string; mode: 'reply' | 'reply_all' | 'forward'; originalBody?: string }
}

export default function ComposeModal({ open, onClose, onSent, replyTo }: Props) {
  const { currentOrg } = useOrg()
  const [accounts, setAccounts] = useState<ImapAccount[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState('')
  const [htmlBody, setHtmlBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCcBcc, setShowCcBcc] = useState(false)

  useEffect(() => {
    if (!currentOrg?.id || !open) return
    supabase.from('imap_accounts').select('id, email, label, addresses').eq('org_id', currentOrg.id).eq('is_active', true)
      .then(({ data }) => {
        const accs = (data as ImapAccount[]) ?? []
        setAccounts(accs)
        if (accs.length > 0 && !selectedAccountId) setSelectedAccountId(accs[0].id)
      })
  }, [currentOrg?.id, open])

  useEffect(() => {
    if (!replyTo) return
    setTo(replyTo.to)
    setCc(replyTo.cc ?? '')
    if (replyTo.cc) setShowCcBcc(true)
    const prefix = replyTo.mode === 'forward' ? 'Fwd: ' : 'Re: '
    const subj = replyTo.subject || ''
    setSubject(subj.startsWith(prefix) ? subj : prefix + subj)
    if (replyTo.mode === 'forward' && replyTo.originalBody) {
      setHtmlBody(`<br/><br/>---------- Forwarded message ----------<br/>${replyTo.originalBody}`)
    }
  }, [replyTo])

  const handleSend = async () => {
    if (!to.trim()) { setError('Recipient is required'); return }
    if (!htmlBody.trim() && !confirm('Send with empty body?')) return
    setSending(true)
    setError(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setError('Please sign in again'); setSending(false); return }

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send-reply`
      const payload: Record<string, unknown> = {
        body: htmlBody,
        subject: subject.trim(),
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        accountId: selectedAccountId || undefined,
        isHtml: true,
      }
      if (replyTo?.threadId) {
        payload.threadId = replyTo.threadId
      } else {
        payload.compose = true
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.error) { setError(data.error); setSending(false); return }

      onSent?.()
      resetForm()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
    setSending(false)
  }

  const resetForm = () => {
    setTo(''); setCc(''); setBcc(''); setSubject(''); setHtmlBody('')
    setError(null); setShowCcBcc(false)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl bg-surface-elevated border border-border rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-white">
            {replyTo ? (replyTo.mode === 'forward' ? 'Forward' : replyTo.mode === 'reply_all' ? 'Reply All' : 'Reply') : 'New message'}
          </h2>
          <button type="button" onClick={() => { resetForm(); onClose() }} className="p-1 rounded hover:bg-surface-muted text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Fields */}
        <div className="px-4 py-2 space-y-2 border-b border-border shrink-0">
          {accounts.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-12 shrink-0">From</label>
              <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
                className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent">
                {accounts.map(a => <option key={a.id} value={a.id}>{a.label ? `${a.label} <${a.email}>` : a.email}</option>)}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 w-12 shrink-0">To</label>
            <input type="text" value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com"
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
            {!showCcBcc && (
              <button type="button" onClick={() => setShowCcBcc(true)} className="text-xs text-gray-400 hover:text-accent shrink-0">
                <ChevronDown className="w-4 h-4" />
              </button>
            )}
          </div>
          {showCcBcc && (
            <>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 w-12 shrink-0">Cc</label>
                <input type="text" value={cc} onChange={e => setCc(e.target.value)} placeholder="cc@example.com"
                  className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 w-12 shrink-0">Bcc</label>
                <input type="text" value={bcc} onChange={e => setBcc(e.target.value)} placeholder="bcc@example.com"
                  className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 w-12 shrink-0">Subject</label>
            <input type="text" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject"
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          <RichTextEditor content={htmlBody} onChange={setHtmlBody} placeholder="Write your message…" autofocus />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          {error && <p className="text-sm text-red-400 truncate mr-2">{error}</p>}
          <div className="flex items-center gap-2 ml-auto">
            <button type="button" onClick={() => { resetForm(); onClose() }}
              className="px-3 py-1.5 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted">
              Discard
            </button>
            <button type="button" onClick={handleSend} disabled={sending || !to.trim()}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50">
              <Send className="w-4 h-4" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
