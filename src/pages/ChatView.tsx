import { useState, useRef, useEffect } from 'react'
import { MessageSquare, Send, Bot, User, Loader2 } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export default function ChatView() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading || !currentOrg?.id) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Please sign in again.' }])
        setLoading(false)
        return
      }

      const history = messages.map(m => ({ role: m.role, content: m.content }))

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ message: text, orgId: currentOrg.id, history }),
      })

      const data = await res.json()

      if (data.error) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error}` }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Network error: ${(err as Error).message}` }])
    }

    setLoading(false)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full" data-testid="chat-view">
      {messages.length === 0 ? (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center text-center">
          <Bot className="w-12 h-12 text-accent/50 mb-4" />
          <h2 className="text-lg font-medium text-white mb-2">Chat with jolo</h2>
          <p className="text-gray-400 text-sm max-w-md">
            Ask me to create projects, add tasks, manage contacts, link companies — anything you can do in the UI, you can do here.
          </p>
          <div className="mt-6 grid gap-2 text-sm max-w-sm w-full">
            {[
              'Create a new project called "Website Redesign"',
              'Show me all my projects',
              'Add a task to my latest project',
              'List all contacts',
            ].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => { setInput(suggestion); inputRef.current?.focus() }}
                className="text-left px-4 py-2.5 rounded-lg border border-border text-gray-300 hover:bg-surface-muted hover:border-accent/50 transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-accent" />
                </div>
              )}
              <div className={`max-w-[80%] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-accent text-white'
                  : 'bg-surface-elevated text-gray-200 border border-border'
              }`}>
                {msg.content}
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-4 h-4 text-gray-400" />
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
              </div>
              <div className="bg-surface-elevated border border-border rounded-lg px-4 py-3 text-sm text-gray-400">
                Thinking…
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className="p-4 border-t border-border">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Ask jolo anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            className="flex-1 rounded-lg border border-border bg-surface-muted px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            data-testid="chat-input"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-4 py-3 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            data-testid="chat-send"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  )
}
