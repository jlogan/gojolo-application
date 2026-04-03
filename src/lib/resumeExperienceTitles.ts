import type { GeneratedExperience } from '@/types/resume'
import { sanitizeResumeRoleTitle } from '@/lib/resumeFormat'

/** Credible web/engineering titles for rotation when the model repeats or mirrors the posting. */
export const WEB_EXPERIENCE_ROLE_TITLES = [
  'Web Developer',
  'Senior Web Developer',
  'Software Engineer',
  'Senior Software Engineer',
  'Full-Stack Developer',
  'Full-Stack Engineer',
  'Web Engineer',
  'Front-End Developer',
  'Senior Front-End Developer',
  'Lead Web Developer',
  'Technical Lead',
  'Engineering Lead',
  'Staff Software Engineer',
  'Principal Engineer',
  'Director of Web Development',
] as const

function normalizeRoleKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function pickWebTitle(startIdx: number, used: Set<string>): string {
  const pool = WEB_EXPERIENCE_ROLE_TITLES
  for (let offset = 0; offset < pool.length * 3; offset++) {
    const candidate = pool[(startIdx * 5 + offset) % pool.length]
    const k = normalizeRoleKey(candidate)
    if (!used.has(k)) return candidate
  }
  return pool[startIdx % pool.length]
}

/**
 * Keeps AI titles when they’re distinct and not the lead/posting title; otherwise assigns varied web titles.
 */
export function finalizeExperienceRoleTitles(
  experiences: GeneratedExperience[],
  leadRoleTitle: string,
): GeneratedExperience[] {
  const postingKey = normalizeRoleKey(leadRoleTitle)
  const used = new Set<string>()

  return experiences.map((exp, idx) => {
    let t = sanitizeResumeRoleTitle(String(exp.role_title ?? ''))
    const key = normalizeRoleKey(t)

    const isEmpty = !t
    const matchesPosting = postingKey.length > 0 && key === postingKey
    const duplicateAmongKept = t.length > 0 && used.has(key)

    if (!isEmpty && !matchesPosting && !duplicateAmongKept) {
      used.add(key)
      return { ...exp, role_title: t }
    }

    const picked = pickWebTitle(idx, used)
    used.add(normalizeRoleKey(picked))
    return { ...exp, role_title: picked }
  })
}
