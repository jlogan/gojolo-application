import type { GeneratedCoverLetter } from '@/types/coverLetter'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Convert a GeneratedCoverLetter to semantic HTML for the TipTap editor.
 * Simple structure: paragraphs from the text body, plus a sign-off.
 */
export function coverLetterToHtml(cl: GeneratedCoverLetter): string {
  const paragraphs = (cl.content_text || '')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('')

  const signOff = cl.candidate.name
    ? `<p><br /></p><p>Best,<br />${escapeHtml(cl.candidate.name)}</p>`
    : ''

  return paragraphs + signOff
}
