import type { GeneratedResume } from '@/types/resume'
import { formatResumeYearRange, sanitizeResumeRoleTitle } from '@/lib/resumeFormat'

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function linesToParagraphHtml(text: string): string {
  const t = text.trim()
  if (!t) return '<p></p>'
  return `<p>${escapeHtml(t).replace(/\n/g, '<br />')}</p>`
}

function contactBlock(candidate: GeneratedResume['candidate']): string {
  const c = candidate
  const line1 = [c.location, c.website].filter(Boolean).join(' · ')
  const line2 = [c.phone, c.email].filter(Boolean).join(' · ')
  const parts: string[] = []
  if (line1) parts.push(`<p class="resume-contact-line">${escapeHtml(line1)}</p>`)
  if (line2) parts.push(`<p class="resume-contact-line">${escapeHtml(line2)}</p>`)
  return parts.join('')
}

/**
 * Semantic HTML for the TipTap resume editor — structured like a classic one-column résumé
 * (name, headline, contact, summary, grouped skills, experience with title line + dates | location, education).
 * Profile photos are omitted so the layout stays text-only (matches PDF and editor).
 */
export function resumeToHtml(resume: GeneratedResume): string {
  const c = resume.candidate

  const experienceBlocks = resume.experience
    .map((exp) => {
      const years = formatResumeYearRange(exp.start_year, exp.end_year)
      const loc = exp.job_location?.trim()
      const meta = loc ? `${escapeHtml(years)} | ${escapeHtml(loc)}` : escapeHtml(years)
      const bullets =
        exp.responsibilities.length ?
          `<ul>${exp.responsibilities.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : ''
      const cleanTitle = sanitizeResumeRoleTitle(exp.role_title?.trim() ?? '')
      const titleLine = cleanTitle
        ? `${escapeHtml(cleanTitle)} – ${escapeHtml(exp.company_name)}`
        : escapeHtml(exp.company_name)
      return `<p class="resume-job-title"><strong>${titleLine}</strong></p><p class="resume-job-meta">${meta}</p>${bullets}`
    })
    .join('')

  return [
    `<h1 class="resume-name">${escapeHtml(c.name || 'Candidate')}</h1>`,
    c.headline?.trim() ? `<p class="resume-headline">${escapeHtml(c.headline.trim())}</p>` : '',
    contactBlock(c),
    '<h2>Professional summary</h2>',
    linesToParagraphHtml(c.summary ?? ''),
    '<h2>Core skills</h2>',
    linesToParagraphHtml(resume.sections.core_skills_text),
    '<h2>Professional experience</h2>',
    experienceBlocks || '<p></p>',
    '<h2>Education</h2>',
    linesToParagraphHtml(resume.sections.education_text),
  ]
    .filter(Boolean)
    .join('')
}
