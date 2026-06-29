import { useRef, useState } from 'react'
import { ChevronDown, Paperclip, Send } from 'lucide-react'
import RichTextEditor from '@/components/inbox/RichTextEditor'

export type SendableAddress = { accountId: string; email: string; label: string }
export type ContactSuggestion = { name: string; email: string }

type Props = {
  modeLabel?: string
  sendableAddresses: SendableAddress[]
  selectedFromAddress: string
  onFromAddressChange: (email: string, accountId: string) => void
  to: string
  onToChange: (value: string) => void
  toSuggestions?: ContactSuggestion[]
  showToSuggestions?: boolean
  onToBlur?: () => void
  onSelectToSuggestion?: (email: string) => void
  cc?: string
  onCcChange?: (value: string) => void
  bcc?: string
  onBccChange?: (value: string) => void
  showCcBcc?: boolean
  onShowCcBccChange?: (show: boolean) => void
  subject?: string
  onSubjectChange?: (value: string) => void
  showSubject?: boolean
  html: string
  onHtmlChange: (html: string) => void
  attachments?: File[]
  onAttachmentsChange?: (files: File[]) => void
  onSend: () => void
  sending?: boolean
  sendDisabled?: boolean
  sendLabel?: string
  sendingLabel?: string
  sentLabel?: string
  onCancel?: () => void
  cancelLabel?: string
  autofocus?: boolean
  minHeight?: string
}

export default function EmailComposeForm({
  modeLabel = 'New message',
  sendableAddresses,
  selectedFromAddress,
  onFromAddressChange,
  to,
  onToChange,
  toSuggestions = [],
  showToSuggestions = false,
  onToBlur,
  onSelectToSuggestion,
  cc = '',
  onCcChange,
  bcc = '',
  onBccChange,
  showCcBcc = false,
  onShowCcBccChange,
  subject = '',
  onSubjectChange,
  showSubject = true,
  html,
  onHtmlChange,
  attachments = [],
  onAttachmentsChange,
  onSend,
  sending = false,
  sendDisabled = false,
  sendLabel = 'Send',
  sendingLabel = 'Sending…',
  sentLabel,
  onCancel,
  cancelLabel = 'Cancel',
  autofocus = true,
  minHeight = 'min-h-[240px]',
}: Props) {
  const [isDragging, setIsDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const appendFiles = (files: File[]) => {
    if (files.length === 0 || !onAttachmentsChange) return
    onAttachmentsChange([...attachments, ...files])
  }

  const removeFileAt = (idx: number) => {
    if (!onAttachmentsChange) return
    onAttachmentsChange(attachments.filter((_, i) => i !== idx))
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) appendFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <div
      className={`rounded-lg border ${isDragging ? 'border-accent bg-accent/5' : 'border-accent/30 bg-surface-elevated'} p-4 space-y-3`}
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={() => setIsDragging(false)}
    >
      {isDragging && <div className="text-center py-4 text-accent text-sm font-medium">Drop files to attach</div>}

      <div className="flex items-center justify-between text-xs">
        <span className="text-accent font-medium">{modeLabel}</span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 w-12 shrink-0">From</label>
          <select
            value={selectedFromAddress}
            onChange={(e) => {
              const email = e.target.value
              const addr = sendableAddresses.find((a) => a.email === email)
              onFromAddressChange(email, addr?.accountId ?? '')
            }}
            className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {sendableAddresses.length === 0 ? (
              <option value="">No active inbox accounts</option>
            ) : sendableAddresses.map((a) => (
              <option key={`${a.accountId}:${a.email}`} value={a.email}>{a.label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 relative">
          <label className="text-xs text-gray-500 w-12 shrink-0">To</label>
          <div className="flex-1 relative">
            <input
              type="text"
              value={to}
              onChange={(e) => onToChange(e.target.value)}
              onBlur={onToBlur}
              placeholder="recipient@example.com"
              className="w-full rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {showToSuggestions && toSuggestions.length > 0 && (
              <div className="absolute top-full left-0 mt-1 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto w-full z-20">
                {toSuggestions.map((s) => (
                  <button
                    key={s.email}
                    type="button"
                    onMouseDown={() => onSelectToSuggestion?.(s.email)}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-surface-muted flex items-center justify-between"
                  >
                    <span>{s.name}</span>
                    <span className="text-xs text-gray-500">{s.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!showCcBcc && onShowCcBccChange && (
            <button type="button" onClick={() => onShowCcBccChange(true)} className="text-xs text-gray-400 hover:text-accent">
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>

        {showCcBcc && (
          <>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-12 shrink-0">Cc</label>
              <input
                type="text"
                value={cc}
                onChange={(e) => onCcChange?.(e.target.value)}
                className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-12 shrink-0">Bcc</label>
              <input
                type="text"
                value={bcc}
                onChange={(e) => onBccChange?.(e.target.value)}
                className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </>
        )}

        {showSubject && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 w-12 shrink-0">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => onSubjectChange?.(e.target.value)}
              placeholder="Subject"
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        )}
      </div>

      <RichTextEditor content={html} onChange={onHtmlChange} placeholder="Write your message…" autofocus={autofocus} minHeight={minHeight} />

      {attachments.length > 0 && (
        <div className="px-1 py-2 space-y-1.5">
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Attached to this send</div>
          <div className="flex flex-wrap gap-2">
            {attachments.map((f, i) => (
              <span
                key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                className="text-xs bg-surface-muted px-2 py-1 rounded text-gray-300 inline-flex items-center gap-1 max-w-full"
              >
                <Paperclip className="w-3 h-3 shrink-0" />
                <span className="truncate" title={f.name}>{f.name}</span>
                <button type="button" onClick={() => removeFileAt(i)} className="text-gray-500 hover:text-red-400 ml-1 shrink-0">&times;</button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSend}
          disabled={sending || sendDisabled}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Send className="w-4 h-4" /> {sending ? sendingLabel : (sentLabel ?? sendLabel)}
        </button>
        {onAttachmentsChange && (
          <>
            <button type="button" onClick={() => fileRef.current?.click()} className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted" title="Attach file">
              <Paperclip className="w-4 h-4" />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) appendFiles(Array.from(e.target.files))
                e.target.value = ''
              }}
            />
          </>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-muted ml-auto">
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  )
}
