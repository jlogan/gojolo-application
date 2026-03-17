import { useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Link as LinkIcon, Undo, Redo,
} from 'lucide-react'

type Props = {
  content?: string
  placeholder?: string
  onChange?: (html: string) => void
  autofocus?: boolean
}

export default function RichTextEditor({ content = '', placeholder = 'Write your message…', onChange, autofocus = false }: Props) {
  const [showLinkInput, setShowLinkInput] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

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
      onChange?.(e.getHTML())
    },
    editorProps: {
      attributes: {
        class: 'inbox-editor-content prose prose-sm prose-invert max-w-none focus:outline-none min-h-[240px] px-3 py-2 text-gray-200',
      },
    },
  })

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
  )
}
