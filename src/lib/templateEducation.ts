/**
 * Build default education copy from resume template settings (university, subject, years).
 * Used for AI context and fallback when the model does not return education_text.
 */
export function formatTemplateEducationText(settings: Record<string, unknown> | null | undefined): string {
  const uni = String(settings?.candidate_university ?? '').trim()
  const years = String(settings?.candidate_university_years ?? '').trim()
  const subject = String(settings?.candidate_university_subject ?? '').trim()

  const lines: string[] = []
  if (uni) lines.push(uni)
  const detail = [subject, years].filter(Boolean).join(subject && years ? ' · ' : '')
  if (detail) lines.push(detail)

  return lines.join('\n').trim()
}
