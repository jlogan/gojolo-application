export type MentionUser = {
  user_id: string
  display_name: string | null
  email?: string | null
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim()
}

/** Match @mentions by longest display name / email label first; require word boundary after label. */
export function parseMentionUserIds(text: string, users: MentionUser[]): string[] {
  const plain = htmlToPlainText(text)
  const labels = users
    .map(u => ({ user_id: u.user_id, label: u.display_name ?? u.email ?? '' }))
    .filter(u => u.label)
    .sort((a, b) => b.label.length - a.label.length)

  const found = new Set<string>()
  let i = 0
  while (i < plain.length) {
    if (plain[i] !== '@') {
      i++
      continue
    }
    const rest = plain.slice(i + 1)
    let matched = false
    for (const { user_id, label } of labels) {
      if (rest.toLowerCase().startsWith(label.toLowerCase())) {
        const after = rest[label.length]
        if (!after || after === ' ' || after === '\n') {
          found.add(user_id)
          i += 1 + label.length
          matched = true
          break
        }
      }
    }
    if (!matched) i++
  }
  return [...found]
}
