/** Normalize provider email bodies before rendering them in the Inbox. */

const HTML_MARKUP_RE = /<\s*\/?\s*(?:!doctype|html|head|body|div|p|br|table|tbody|tr|td|th|span|a|img|ul|ol|li|blockquote|pre|strong|em|h[1-6])\b[^>]*>/i
const ESCAPED_HTML_MARKUP_RE = /&lt;\s*\/?\s*(?:!doctype|html|head|body|div|p|br|table|tbody|tr|td|th|span|a|img|ul|ol|li|blockquote|pre|strong|em|h[1-6])\b/i

/** True when a body contains HTML elements rather than plain-text angle brackets. */
export function looksLikeHtmlBody(value: string | null | undefined): boolean {
  return !!value && HTML_MARKUP_RE.test(value)
}

/**
 * Decode markup that was HTML-escaped by a provider/import path.
 * Plain text is returned unchanged so ordinary entities in email prose are preserved.
 */
export function decodeEscapedHtmlMarkup(value: string): string {
  if (!ESCAPED_HTML_MARKUP_RE.test(value)) return value

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = value
    return textarea.value
  }

  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** Normalize one provider body and detect whether it should use the HTML renderer. */
export function normalizeInboxBody(value: string): { content: string; html: boolean } {
  const decoded = decodeEscapedHtmlMarkup(value)
  return { content: decoded, html: looksLikeHtmlBody(decoded) }
}
