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
        class: 'prose prose-sm prose-invert max-w-none focus:outline-none min-h-[100px] px-3 py-2 text-gray-200',
      },
    },
  })

  if (!editor) return null

  const btnClass = (active: boolean) =>
    `p-1.5 rounded transition-colors ${active ? 'bg-surface-muted text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-muted'}`

  const addLink = () => {
    const url = window.prompt('URL')
    if (url) editor.chain().focus().setLink({ href: url }).run()
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
        <button type="button" onClick={addLink} className={btnClass(editor.isActive('link'))} title="Add link">
          <LinkIcon className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-border mx-1" />
        <button type="button" onClick={() => editor.chain().focus().undo().run()} className={btnClass(false)} title="Undo">
          <Undo className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => editor.chain().focus().redo().run()} className={btnClass(false)} title="Redo">
          <Redo className="w-4 h-4" />
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
