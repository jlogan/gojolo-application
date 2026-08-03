/**
 * Email HTML sanitizer for safe iframe rendering.
 *
 * - Removes tracking pixels (1x1 images, known tracker domains)
 * - Removes link click trackers (unwraps redirect URLs)
 * - Strips scripts, event handlers, meta refresh, forms
 * - Preserves the email's original CSS/styling (does NOT inject overrides)
 * - Only adds minimal safety CSS that doesn't conflict with email styles
 */

const TRACKER_DOMAINS = [
  'mailtrack.io', 'track.', 'pixel.', 'open.', 'beacon.',
  'cl.exct.net', 'links.mkt.', 't.co/', 'bit.ly/',
  'email.mg.', 'mandrillapp.com', 'sendgrid.net/wf/',
  'list-manage.com/track/', 'ct.sendgrid.net',
  'emltrk.com', 'yesware.com', 'getnotify.com',
  'mailspring.com', 'readnotify.com', 'bananatag.com',
  'cirrusinsight.com', 'boomeranggmail.com', 'streak.com',
  'mixmax.com', 'nethunt.com', 'snov.io',
]

function isTrackingPixel(img: string): boolean {
  if (/width\s*[:=]\s*["']?1(?:px)?["']?/i.test(img) && /height\s*[:=]\s*["']?1(?:px)?["']?/i.test(img)) return true
  if (/width\s*[:=]\s*["']?0/i.test(img) || /height\s*[:=]\s*["']?0/i.test(img)) return true
  if (/display\s*:\s*none/i.test(img)) return true
  if (/visibility\s*:\s*hidden/i.test(img)) return true
  const srcMatch = img.match(/src\s*=\s*["']([^"']+)["']/i)
  if (srcMatch) {
    const src = srcMatch[1].toLowerCase()
    if (TRACKER_DOMAINS.some(d => src.includes(d))) return true
    if (/\/track(ing)?[\/.]|\/pixel[\/.]|\/beacon[\/.]|\/open[\/.]|\/wf\/open/i.test(src)) return true
    if (/\.gif\?.*[&?](u|e|id|uid|email)=/i.test(src) && !/width|height/i.test(img.replace(srcMatch[0], ''))) return true
  }
  return false
}

function removeTrackingLinks(html: string): string {
  return html.replace(/<a\b([^>]*href\s*=\s*["'])([^"']+)(["'][^>]*)>/gi, (match, prefix, url, suffix) => {
    try {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('url') || parsed.searchParams.get('redirect') || parsed.searchParams.get('r') || parsed.searchParams.get('u')
      if (redirect && redirect.startsWith('http')) {
        return `<a${prefix}${redirect}${suffix}>`
      }
    } catch {}
    return match
  })
}

/** Remove script tags including malformed / nested; repeat until stable. */
function stripAllScripts(html: string): string {
  let out = html
  for (let i = 0; i < 12; i++) {
    const next = out
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/<script\b[^>]*>/gi, '')
      .replace(/<\/script>/gi, '')
    if (next === out) break
    out = next
  }
  return out
}

/** Block javascript: / vbscript: / data:html in navigable URLs inside HTML. */
function neutralizeDangerousUrls(html: string): string {
  return html
    .replace(
      /\b(href|src|xlink:href)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html)\s*:([^"']*)\2/gi,
      '$1=$2about:blank$2',
    )
    .replace(
      /\b(href|src|xlink:href)\s*=\s*(?!["'])(?:javascript|vbscript|data:text\/html)\s*:[^\s>]+/gi,
      '$1="about:blank"',
    )
}

export function sanitizeEmailHtml(rawHtml: string): string {
  let html = rawHtml

  html = stripAllScripts(html)

  // Remove event handlers
  html = html.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')

  html = neutralizeDangerousUrls(html)

  // Remove meta refresh
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '')

  // Remove forms
  html = html.replace(/<\/?form\b[^>]*>/gi, '')
  html = html.replace(/<input\b[^>]*type\s*=\s*["']?hidden["']?[^>]*>/gi, '')

  // Remove tracking pixels
  html = html.replace(/<img\b[^>]*\/?>/gi, (match) => {
    if (isTrackingPixel(match)) return ''
    return match
  })

  // Remove tracking link wrappers
  html = removeTrackingLinks(html)

  // Remove data URIs in images that could be used for tracking (except small inline icons)
  // Keep base64 images that are likely content (> 200 chars)

  // Remove link prefetch/preload that could leak data
  html = html.replace(/<link\b[^>]*rel\s*=\s*["']?(prefetch|preload|dns-prefetch)["']?[^>]*>/gi, '')

  return html
}

export type InlineEmailAttachment = {
  file_name: string
  file_path: string
  signedUrl?: string | null
  content_type?: string | null
}

const INBOX_STORAGE_OBJECT_PATH_RE = /\/inbox-attachments\/([^?"']+)/i

function normalizeContentId(cid: string): string {
  return cid.replace(/^<|>$/g, '').trim()
}

function isImageAttachment(att: InlineEmailAttachment): boolean {
  if (att.content_type?.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|bmp|svg|ico)$/i.test(att.file_name)
}

function attachmentSignedUrl(att: InlineEmailAttachment): string | null {
  const url = att.signedUrl?.trim()
  return url || null
}

function extractInboxStoragePath(url: string): string | null {
  const match = url.match(INBOX_STORAGE_OBJECT_PATH_RE)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function findAttachmentForCid(cid: string, attachments: InlineEmailAttachment[]): InlineEmailAttachment | undefined {
  const norm = normalizeContentId(cid)
  if (!norm) return undefined

  const candidates = [norm]
  const atIdx = norm.indexOf('@')
  if (atIdx > 0) candidates.push(norm.slice(0, atIdx))

  for (const key of candidates) {
    const exact = attachments.find((a) => a.file_name === `inline-${key}`)
    if (exact) return exact

    const contains = attachments.find((a) => a.file_name.includes(key))
    if (contains) return contains
  }

  return undefined
}

function buildCidUrlMap(html: string, attachments: InlineEmailAttachment[]): Map<string, string> {
  const cidMatches = [...html.matchAll(/cid:([^"'\s>)]+)/gi)]
  const cids = [...new Set(cidMatches.map((m) => normalizeContentId(m[1])))].filter(Boolean)
  if (cids.length === 0) return new Map()

  const map = new Map<string, string>()
  const usedAttachmentPaths = new Set<string>()

  for (const cid of cids) {
    const att = findAttachmentForCid(cid, attachments)
    const url = att ? attachmentSignedUrl(att) : null
    if (att && url) {
      map.set(cid, url)
      usedAttachmentPaths.add(att.file_path)
    }
  }

  const unmatchedCids = cids.filter((cid) => !map.has(cid))
  const spareImages = attachments.filter(
    (a) => isImageAttachment(a) && attachmentSignedUrl(a) && !usedAttachmentPaths.has(a.file_path),
  )

  if (unmatchedCids.length > 0 && unmatchedCids.length === spareImages.length) {
    for (let i = 0; i < unmatchedCids.length; i++) {
      const url = attachmentSignedUrl(spareImages[i])
      if (url) map.set(unmatchedCids[i], url)
    }
  }

  return map
}

function replaceCidToken(value: string, cidToUrl: Map<string, string>): string {
  return value.replace(/^cid:(.+)$/i, (full, cidPart) => {
    const norm = normalizeContentId(cidPart)
    return cidToUrl.get(norm) ?? full
  })
}

/**
 * Rewrite cid: references and inbox-attachments storage URLs to signed URLs so inline
 * images render inside the sandboxed email iframe (bucket is private; public URLs 403).
 */
export function resolveInlineEmailImages(html: string, attachments: InlineEmailAttachment[]): string {
  if (!html?.trim() || attachments.length === 0) return html

  const cidToUrl = buildCidUrlMap(html, attachments)
  const pathToUrl = new Map<string, string>()
  for (const att of attachments) {
    const url = attachmentSignedUrl(att)
    if (url) pathToUrl.set(att.file_path, url)
  }

  let out = html

  if (cidToUrl.size > 0) {
    out = out.replace(
      /(\s(?:src|background|background-image)\s*=\s*["'])cid:([^"']+)(["'])/gi,
      (match, prefix, cidPart, suffix) => {
        const norm = normalizeContentId(cidPart)
        const url = cidToUrl.get(norm)
        return url ? `${prefix}${url}${suffix}` : match
      },
    )
    out = out.replace(/url\s*\(\s*["']?(cid:[^"')]+)["']?\s*\)/gi, (match, cidExpr) => {
      const url = replaceCidToken(cidExpr, cidToUrl)
      return url === cidExpr ? match : `url("${url}")`
    })
  }

  for (const att of attachments) {
    const url = attachmentSignedUrl(att)
    if (!url) continue
    const escapedPath = att.file_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(
      new RegExp(`((?:src|background|background-image)\\s*=\\s*["'])[^"']*${escapedPath}[^"']*(["'])`, 'gi'),
      `$1${url}$2`,
    )
    out = out.replace(
      new RegExp(`url\\s*\\(\\s*["']?[^"')]*${escapedPath}[^"')]*["']?\\s*\\)`, 'gi'),
      `url("${url}")`,
    )
  }

  // Fallback: swap any remaining inbox-attachments URL by extracted object path.
  out = out.replace(
    /(\s(?:src|background|background-image)\s*=\s*["'])([^"']+)(["'])/gi,
    (match, prefix, src, suffix) => {
      const path = extractInboxStoragePath(src)
      if (!path) return match
      const url = pathToUrl.get(path)
      return url ? `${prefix}${url}${suffix}` : match
    },
  )

  return out
}

/**
 * Detect if HTML email has its own background/color styling.
 * If it does, we render on white (preserve original design).
 * If not (plain/simple), we render with dark theme colors.
 */
function hasOwnStyling(html: string): boolean {
  if (/background(-color)?\s*:/i.test(html)) return true
  if (/bgcolor\s*=/i.test(html)) return true
  if (/<style[\s>]/i.test(html) && /(?:color|background|font-family)\s*:/i.test(html)) return true
  if (/<table\b[^>]*(?:bgcolor|background|style\s*=\s*"[^"]*(?:background|color))/i.test(html)) return true
  if (/<div\b[^>]*style\s*=\s*"[^"]*(?:background|color)/i.test(html)) return true
  return false
}

const DOC_LEVEL_STYLE_PROPS = new Set([
  'background',
  'background-color',
  'background-image',
  'color',
  'font',
  'font-family',
  'font-size',
])

const DRAFT_WRAPPER_TAGS = new Set(['HTML', 'BODY', 'DIV', 'SPAN', 'CENTER'])

function cleanDocumentLevelStyles(style: string): string {
  return style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((decl) => {
      const prop = decl.split(':')[0]?.trim().toLowerCase()
      return prop && !DOC_LEVEL_STYLE_PROPS.has(prop)
    })
    .join('; ')
}

function stripDocumentChromeFromElement(el: Element): void {
  el.removeAttribute('bgcolor')
  el.removeAttribute('background')
  el.removeAttribute('text')
  if (el.hasAttribute('style')) {
    const cleaned = cleanDocumentLevelStyles(el.getAttribute('style') ?? '')
    if (cleaned) el.setAttribute('style', cleaned)
    else el.removeAttribute('style')
  }
}

function canUnwrapDraftWrapper(el: Element): boolean {
  if (!DRAFT_WRAPPER_TAGS.has(el.tagName)) return false
  stripDocumentChromeFromElement(el)
  const keepAttrs = new Set(['dir', 'lang', 'align', 'class', 'id'])
  for (const attr of el.attributes) {
    if (!keepAttrs.has(attr.name.toLowerCase())) return false
  }
  return true
}

/**
 * Strip full email document chrome from provider-synced draft HTML so display
 * and TipTap editing use content fragments instead of Gmail/Outlook wrappers.
 */
export function prepareDraftHtmlForDisplay(rawHtml: string): string {
  const trimmed = rawHtml?.trim()
  if (!trimmed) return rawHtml ?? ''

  const doc = new DOMParser().parseFromString(trimmed, 'text/html')

  doc.querySelectorAll('style').forEach((el) => el.remove())
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((el) => el.remove())
  doc.querySelectorAll('meta').forEach((el) => el.remove())

  const node = doc.body
  stripDocumentChromeFromElement(node)

  while (node.children.length === 1 && canUnwrapDraftWrapper(node.children[0])) {
    const wrapper = node.children[0]
    const parent = wrapper.parentElement!
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper)
    parent.removeChild(wrapper)
  }

  for (const child of [...node.children]) {
    if (DRAFT_WRAPPER_TAGS.has(child.tagName)) {
      stripDocumentChromeFromElement(child)
    }
  }

  const result = node.innerHTML.trim()
  return result || trimmed
}

/**
 * Build the full srcDoc for the email iframe.
 * - Rich HTML with own styling → white background, preserve email's CSS
 * - Plain/simple HTML → dark background with light text (matches app theme)
 * - forceDark → always use dark app theme (draft bubbles)
 */
export function buildEmailSrcDoc(
  sanitizedHtml: string,
  options?: { forceDark?: boolean },
): { srcDoc: string; isDark: boolean } {
  const rich = !options?.forceDark && hasOwnStyling(sanitizedHtml)

  if (rich) {
    return {
      isDark: false,
      srcDoc: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><base target="_blank">
<style>img{max-width:100%;height:auto;}body{margin:0;padding:0;}</style>
</head><body>${sanitizedHtml}</body></html>`,
    }
  }

  return {
    isDark: true,
    srcDoc: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><base target="_blank">
<style>
body{margin:0;padding:12px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#e4e4e7;background:#0f0f0f;}
a{color:#14b8a6;}
img{max-width:100%;height:auto;}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid #2a2a2a;color:#a1a1aa;}
</style>
</head><body>${sanitizedHtml}</body></html>`,
  }
}
