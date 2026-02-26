import { useState } from 'react'
import { MessageSquare } from 'lucide-react'

export default function ChatView() {
  const [input, setInput] = useState('')

  return (
    <div className="flex flex-col h-full" data-testid="chat-view">
      <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center text-center">
        <MessageSquare className="w-12 h-12 text-surface-muted mb-4" />
        <h2 className="text-lg font-medium text-white mb-2">Chat with jolo</h2>
        <p className="text-surface-muted text-sm max-w-sm">
          AI chat and voice mode will be wired up in Phase 2. You can type below when ready.
        </p>
      </div>
      <div className="p-4 border-t border-border">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Ask jolo anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-surface-muted px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
            data-testid="chat-input"
          />
          <button
            type="button"
            className="px-4 py-3 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
            data-testid="chat-send"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
