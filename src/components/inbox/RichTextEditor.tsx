import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Link as LinkIcon, Undo, Redo,
} from 'lucide-react'

export type MentionableUser = {
  user_id: string
  display_name: string | null
  email?: string | null
  avatar_url?: string | null
}

type Props = {
  content?: string
  placeholder?: string
  onChange?: (html: string) => void
  autofocus?: boolean
  minHeight?: string
  mentionableUsers?: MentionableUser[]
}

const MENTION_QUERY_RE = /@([^\s@]*)$/

function getMentionLabel(user: MentionableUser): string {
  return user.display_name ?? user.email ?? 'user'
}

export default function RichTextEditor({
  content = '',
  placeholder = 'Write your message…',
  onChange,
  autofocus = false,
  minHeight = 'min-h-[240px]',
  mentionableUsers,
}: Props) {
  const [showLinkInput, setShowLinkInput] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [highlightIndex, setHighlightIndex] = useState(0)

  const mentionRangeRef = useRef<{ from: number; to: number } | null>(null)
  const mentionOpenRef = useRef(false)
  const highlightIndexRef = useRef(0)
  const filteredUsersRef = useRef<MentionableUser[]>([])
  const mentionableUsersRef = useRef(mentionableUsers)
  const editorRef = useRef<Editor | null>(null)

  useEffect(() => { mentionableUsersRef.current = mentionableUsers }, [mentionableUsers])
  useEffect(() => { mentionOpenRef.current = mentionOpen }, [mentionOpen])
  useEffect(() => { highlightIndexRef.current = highlightIndex }, [highlightIndex])

  const filteredUsers = useMemo(() => {
    if (!mentionableUsers?.length) return []
    const q = mentionQuery.toLowerCase()
    return mentionableUsers.filter(u => {
      if (!q) return true
      const name = (u.display_name ?? '').toLowerCase()
      const email = (u.email ?? '').toLowerCase()
      return name.includes(q) || email.includes(q)
    }).slice(0, 8)
  }, [mentionableUsers, mentionQuery])

  useEffect(() => {
    filteredUsersRef.current = filteredUsers
    if (mentionOpen && filteredUsers.length === 0) {
      setMentionOpen(false)
      mentionRangeRef.current = null
    }
  }, [filteredUsers, mentionOpen])

  const closeMention = useCallback(() => {
    setMentionOpen(false)
    mentionRangeRef.current = null
  }, [])

  const syncMentionState = useCallback((editorInstance: Editor) => {
    if (!mentionableUsersRef.current?.length) {
      closeMention()
      return
    }
    const { from } = editorInstance.state.selection
    const textBefore = editorInstance.state.doc.textBetween(0, from, '\n', '\n')
    const match = textBefore.match(MENTION_QUERY_RE)
    if (!match) {
      closeMention()
      return
    }
    mentionRangeRef.current = { from: from - match[0].length, to: from }
    setMentionQuery(match[1])
    setMentionOpen(true)
    setHighlightIndex(0)
    highlightIndexRef.current = 0
  }, [closeMention])

  const insertMention = useCallback((user: MentionableUser) => {
    const editorInstance = editorRef.current
    const range = mentionRangeRef.current
    if (!editorInstance || !range) return
    const name = getMentionLabel(user)
    editorInstance.chain()
      .focus()
      .deleteRange({ from: range.from, to: range.to })
      .insertContent(`@${name} `)
      .run()
    closeMention()
  }, [closeMention])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder }),
    ],
    content,
    autofocus,
    onUpdate: ({ editor: e }) => {
      editorRef.current = e
      onChange?.(e.getHTML())
      syncMentionState(e)
    },
    onSelectionUpdate: ({ editor: e }) => {
      editorRef.current = e
      syncMentionState(e)
    },
    editorProps: {
      attributes: {
        class: `inbox-editor-content prose prose-sm prose-invert max-w-none focus:outline-none ${minHeight} px-3 py-2 text-gray-200`,
      },
      handleKeyDown: (_view, event) => {
        if (!mentionOpenRef.current || filteredUsersRef.current.length === 0) return false
        if (event.key === 'Escape') {
          event.preventDefault()
          closeMention()
          return true
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setHighlightIndex(i => {
            const next = Math.min(i + 1, filteredUsersRef.current.length - 1)
            highlightIndexRef.current = next
            return next
          })
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHighlightIndex(i => {
            const next = Math.max(i - 1, 0)
            highlightIndexRef.current = next
            return next
          })
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          const user = filteredUsersRef.current[highlightIndexRef.current]
          if (user) insertMention(user)
          return true
        }
        return false
      },
    },
  })

  useEffect(() => {
    if (editor) editorRef.current = editor
  }, [editor])

  if (!editor) return null

  const btnClass = (active: boolean) =>
    `p-1.5 rounded transition-colors ${active ? 'bg-surface-muted text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-muted'}`

  const normalizeUrl = (url: string) => {
    const trimmed = url.trim()
    if (!trimmed) return ''
    if (/^(https?:\/\/|mailto:|tel:)/i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }

  const openLinkInput = () => {
    const current = editor.getAttributes('link').href as string | undefined
    setLinkUrl(current ?? '')
    setShowLinkInput(true)
  }

  const applyLink = () => {
    const normalized = normalizeUrl(linkUrl)
    if (!normalized) return
    editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run()
    setShowLinkInput(false)
  }

  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setShowLinkInput(false)
    setLinkUrl('')
  }

  return (
    <div className="relative">
      <div className="rounded-lg border border-border bg-surface-muted overflow-hidden">
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border bg-surface-elevated/50 flex-wrap">
          <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btnClass(editor.isActive('bold'))} title="Bold">
            <Bold className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={btnClass(editor.isActive('italic'))} title="Italic">
            <Italic className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()} className={btnClass(editor.isActive('underline'))} title="Underline">
            <UnderlineIcon className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => editor.chain().focus().toggleStrike().run()} className={btnClass(editor.isActive('strike'))} title="Strikethrough">
            <Strikethrough className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btnClass(editor.isActive('bulletList'))} title="Bullet list">
            <List className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btnClass(editor.isActive('orderedList'))} title="Ordered list">
            <ListOrdered className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button type="button" onClick={openLinkInput} className={btnClass(editor.isActive('link'))} title="Add link">
            <LinkIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={removeLink}
            disabled={!editor.isActive('link')}
            className={`px-2 py-1.5 rounded text-xs transition-colors ${
              editor.isActive('link')
                ? 'text-gray-200 hover:text-white hover:bg-surface-muted'
                : 'text-gray-600 cursor-not-allowed'
            }`}
            title="Remove link"
          >
            Unlink
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button type="button" onClick={() => editor.chain().focus().undo().run()} className={btnClass(false)} title="Undo">
            <Undo className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => editor.chain().focus().redo().run()} className={btnClass(false)} title="Redo">
            <Redo className="w-4 h-4" />
          </button>
        </div>
        {showLinkInput && (
          <div className="px-2 py-2 border-b border-border bg-surface-elevated/40 flex items-center gap-2">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyLink()
                if (e.key === 'Escape') setShowLinkInput(false)
              }}
              placeholder="https://example.com"
              className="flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
              autoFocus
            />
            <button
              type="button"
              onClick={applyLink}
              className="px-2.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={removeLink}
              className="px-2.5 py-1.5 rounded text-xs font-medium bg-surface-muted text-gray-200 hover:bg-surface-muted/80"
            >
              Remove
            </button>
          </div>
        )}
        <EditorContent editor={editor} />
      </div>
      {mentionOpen && filteredUsers.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto">
          {filteredUsers.map((u, i) => (
            <button
              key={u.user_id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(u)}
              className={`w-full text-left px-3 py-1.5 text-sm ${
                i === highlightIndex ? 'bg-surface-muted text-white' : 'text-gray-200 hover:bg-surface-muted'
              }`}
            >
              <span className="font-medium">{u.display_name ?? u.email ?? 'User'}</span>
              {u.display_name && u.email && (
                <span className="text-gray-500 ml-2 text-xs">{u.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
