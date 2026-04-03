/** Single year if start and end are the same; otherwise "Start – End" or "Start – Present". */
export function formatResumeYearRange(startYear: number, endYear: number | null | undefined): string {
  if (endYear == null) return `${startYear} – Present`
  if (endYear === startYear) return String(startYear)
  return `${startYear} – ${endYear}`
}

/** Strip boilerplate the model sometimes adds (e.g. "(Relevant Experience)"). */
export function sanitizeResumeRoleTitle(roleTitle: string): string {
  return roleTitle
    .replace(/\s*\(\s*Relevant Experience\s*\)\s*/gi, ' ')
    .replace(/\s*\[\s*Relevant Experience\s*\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
