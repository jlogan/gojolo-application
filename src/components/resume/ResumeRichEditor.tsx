import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  Redo2,
  Undo2,
  Heading2,
  Heading3,
  Minus,
  ImageIcon,
} from 'lucide-react'
import './resume-editor.css'

export type ResumeRichEditorHandle = {
  getHtml: () => string | null
  getPrintRoot: () => HTMLDivElement | null
}

type Props = {
  initialHtml: string
  /** Change when a new AI draft is generated so the editor reloads content */
  remountKey: string
  onHtmlChange: (html: string) => void
  /** Rendered on the far right of the toolbar (e.g. Download PDF) */
  toolbarTrailing?: ReactNode
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-2 rounded-md border text-sm transition-colors disabled:opacity-40 ${
        active ? 'bg-accent text-accent-foreground border-accent' : 'border-border text-gray-200 hover:bg-surface-muted'
      }`}
    >
      {children}
    </button>
  )
}

export const ResumeRichEditor = forwardRef<ResumeRichEditorHandle, Props>(function ResumeRichEditor(
  { initialHtml, remountKey, onHtmlChange, toolbarTrailing },
  ref,
) {
  const printRootRef = useRef<HTMLDivElement>(null)

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          bulletList: { HTMLAttributes: { class: 'list-disc' } },
          orderedList: { HTMLAttributes: { class: 'list-decimal' } },
        }),
        Underline,
        Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
        Image.configure({
          inline: false,
          allowBase64: true,
          HTMLAttributes: { class: 'resume-inline-photo' },
        }),
      ],
      content: initialHtml,
      editorProps: {
        attributes: {
          class: 'resume-prose-root',
        },
      },
      onUpdate: ({ editor: ed }) => {
        onHtmlChange(ed.getHTML())
      },
    },
    [remountKey],
  )

  useImperativeHandle(
    ref,
    () => ({
      getHtml: () => editor?.getHTML() ?? null,
      getPrintRoot: () => printRootRef.current,
    }),
    [editor],
  )

  useEffect(() => {
    if (editor) {
      onHtmlChange(editor.getHTML())
    }
  }, [editor, remountKey, onHtmlChange])

  const addImageFromFile = () => {
    if (!editor) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result ?? '')
        if (src) editor.chain().focus().setImage({ src }).run()
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }

  return (
    <div className="resume-editor-sheet space-y-3">
      {editor && (
        <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg border border-border bg-surface-elevated sticky top-2 z-10 w-full">
          <ToolbarButton
            title="Bold"
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Italic"
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Underline"
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon className="w-4 h-4" />
          </ToolbarButton>
          <span className="w-px bg-border mx-1 self-stretch" aria-hidden />
          <ToolbarButton
            title="Section heading (large)"
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Subheading"
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 className="w-4 h-4" />
          </ToolbarButton>
          <span className="w-px bg-border mx-1 self-stretch" aria-hidden />
          <ToolbarButton
            title="Bullet list"
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Numbered list"
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus className="w-4 h-4" />
          </ToolbarButton>
          <span className="w-px bg-border mx-1 self-stretch" aria-hidden />
          <ToolbarButton title="Insert / replace photo" onClick={addImageFromFile}>
            <ImageIcon className="w-4 h-4" />
          </ToolbarButton>
          <span className="w-px bg-border mx-1 self-stretch" aria-hidden />
          <ToolbarButton title="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
            <Undo2 className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton title="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
            <Redo2 className="w-4 h-4" />
          </ToolbarButton>
          {toolbarTrailing ?
            <div className="ml-auto flex flex-shrink-0 items-center gap-2 pl-2">{toolbarTrailing}</div>
          : null}
        </div>
      )}

      <div ref={printRootRef} className="resume-a4-page rounded-sm border border-stone-200 overflow-hidden min-h-[120mm] w-full">
        {!editor ? (
          <div className="p-8 flex items-center justify-center text-gray-500 text-sm min-h-[200px]">Loading editor…</div>
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
    </div>
  )
})
