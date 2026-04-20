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

/**
 * Build the full srcDoc for the email iframe.
 * - Rich HTML with own styling → white background, preserve email's CSS
 * - Plain/simple HTML → dark background with light text (matches app theme)
 */
export function buildEmailSrcDoc(sanitizedHtml: string): { srcDoc: string; isDark: boolean } {
  const rich = hasOwnStyling(sanitizedHtml)

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
