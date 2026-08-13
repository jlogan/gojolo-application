import { createElement, type ReactNode } from 'react'

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi

export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/** Strip HTML tags; decode entities via DOM when available. */
export function stripHtmlToPlainText(html: string): string {
  const trimmed = html.trim()
  if (!trimmed) return ''
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(trimmed, 'text/html')
    return (doc.body.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  }
  return trimmed
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim()
}

function trimTrailingUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?)]+$/g, '')
}

type TextSegment = { kind: 'text'; value: string }
type LinkSegment = { kind: 'link'; value: string; href: string }
type Segment = TextSegment | LinkSegment

function splitLineIntoSegments(line: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0
  URL_PATTERN.lastIndex = 0

  for (const match of line.matchAll(URL_PATTERN)) {
    const rawUrl = match[0]
    const start = match.index ?? 0
    if (start > lastIndex) {
      segments.push({ kind: 'text', value: line.slice(lastIndex, start) })
    }
    const href = trimTrailingUrlPunctuation(rawUrl)
    if (isSafeExternalUrl(href)) {
      segments.push({ kind: 'link', value: rawUrl, href })
    } else {
      segments.push({ kind: 'text', value: rawUrl })
    }
    lastIndex = start + rawUrl.length
  }

  if (lastIndex < line.length) {
    segments.push({ kind: 'text', value: line.slice(lastIndex) })
  }

  return segments
}

/** Render plain text / HTML description as sanitized text with http(s) links only. */
export function renderSanitizedDescription(
  raw: string | null | undefined,
  linkClassName = 'text-accent hover:underline break-all',
): ReactNode {
  if (!raw?.trim()) return null

  const plain = stripHtmlToPlainText(raw)
  if (!plain) return null

  const lines = plain.split('\n')
  return lines.map((line, lineIndex) => {
    const segments = splitLineIntoSegments(line)
    const nodes = segments.map((segment, segmentIndex) => {
      if (segment.kind === 'link') {
        return createElement(
          'a',
          {
            key: `${lineIndex}-${segmentIndex}`,
            href: segment.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: linkClassName,
          },
          segment.value,
        )
      }
      return createElement('span', { key: `${lineIndex}-${segmentIndex}` }, segment.value)
    })

    return createElement(
      'span',
      { key: lineIndex },
      ...nodes,
      lineIndex < lines.length - 1 ? createElement('br') : null,
    )
  })
}

export function formatReminderLabel(reminder: { method?: string; minutes?: number }): string {
  const minutes = reminder.minutes
  if (minutes == null || Number.isNaN(minutes)) return 'Reminder'
  if (minutes === 0) return 'At time of event'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} before`
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return `${days} day${days === 1 ? '' : 's'} before`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'} before`
  }
  return `${minutes} minutes before`
}

export function formatAttendeeLabel(attendee: {
  displayName?: string
  email?: string
  responseStatus?: string
  optional?: boolean
}): string {
  const name = attendee.displayName?.trim() || attendee.email?.trim() || 'Guest'
  const parts = [name]
  if (attendee.optional) parts.push('optional')
  if (attendee.responseStatus && attendee.responseStatus !== 'needsAction') {
    parts.push(attendee.responseStatus.replace(/_/g, ' '))
  }
  return parts.join(' · ')
}

export function formatPersonLabel(person: { displayName?: string; email?: string } | null | undefined): string | null {
  if (!person) return null
  return person.displayName?.trim() || person.email?.trim() || null
}

export function conferenceEntryPointLabel(entryPoint: {
  entryPointType?: string
  label?: string
  uri?: string
}): string {
  if (entryPoint.label?.trim()) return entryPoint.label.trim()
  switch (entryPoint.entryPointType) {
    case 'video':
      return 'Video call'
    case 'phone':
      return 'Phone'
    case 'sip':
      return 'SIP'
    case 'more':
      return 'More options'
    default:
      return entryPoint.entryPointType?.trim() || 'Join'
  }
}
