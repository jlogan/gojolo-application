/**
 * AI instructions for resume generation (lead wizard + resume generator).
 * No user-visible “custom prompt”; these are merged into the model message only.
 */

/** Full JSON resume draft: summary, skills, education, experience (bullets + titles). */
export function resumeFullDraftInstructionLines(bulletPointsPerJob: number): string[] {
  return [
    'Employment rows (strict):',
    '- The resume may only include the jobs listed in EMPLOYMENT INPUTS, in that exact order.',
    '- Use each row’s company_name, start_year, end_year (null means present), and job_location exactly as given. Do not add, remove, merge, or rename jobs.',
    `- Produce exactly ${bulletPointsPerJob} bullet points in the responsibilities array for every job.`,
    '- You may write role_title, responsibilities, summary, core_skills_text, and education_text. Ground wording in plausible web/digital work (development, design, maintenance, UX/UI, marketing technology, CMS, analytics, performance, accessibility, APIs, databases, CI/CD, etc.) when it fits the employer and timeline.',
    '',
    'Professional summary (summary field):',
    '- Do not name the target job title, the hiring company, or "this role" / "your posting"—the summary must stay reusable if the candidate applies elsewhere.',
    '- Tailor vocabulary and themes to the job description (tools, domains, seniority, type of work) without referencing that specific employer or title.',
    '- Style: 3–5 sentences in a classic executive-summary voice (like a strong technical résumé). Mix sentence openings—e.g. open with a role/scope line ("…engineer with X years…"), then "Deep expertise in…", "Known for…", "Strong collaborator who…". Do not start every sentence with "I".',
    '- Never use the candidate’s full name in the summary. Avoid generic fluff ("Results-focused professional…").',
    '',
    'Role titles (role_title per job):',
    '- Choose a credible past-tense job title that fits web/digital/engineering work at that employer (e.g. Web Developer, Senior Web Developer, Full-Stack Engineer, Front-End Developer, Software Engineer, Technical Lead, Web Engineer).',
    '- Do NOT reuse the lead’s "Target role" from this prompt—that is the role you are applying for, not the historical title on the résumé.',
    '- Use a different role_title string for every job row—no duplicate titles across the experience array.',
    '- Never include phrases like "(Relevant Experience)", "[Relevant Experience]", or similar meta labels.',
    '',
    'Experience bullets (responsibilities):',
    '- The job block already shows company name and dates—do not repeat the employer name inside bullets.',
    '- Each bullet: one clear sentence, usually past tense, leading with a strong verb and concrete scope (e.g. "Maintained and improved…", "Designed and launched…", "Modernized…").',
    '- Remix emphasis toward the job posting (tools, outcomes, collaboration) without repeating the same opening word or structure on every line.',
    '- Avoid "At [Company], I…", "For [Company]…", or "My work at [Company]…". Write as responsibility statements only.',
    '- Avoid stuffing keywords; read like credible delivery notes from someone with real web/digital experience.',
    '- Spelling and brands: use correct product capitalization and punctuation (e.g. WordPress, WooCommerce, JavaScript, TypeScript, GitHub, Google Analytics, SEO, REST API, Node.js, PHP, MySQL, AWS). End bullets with a period when they are full sentences.',
    '',
    'Job description (required):',
    '- Read the entire posting. Pull must-have and nice-to-have skills, tools, domains, certifications, seniority, and themes (e.g. leadership, mentoring, stakeholder communication).',
    '- When the posting states years of experience for a skill, reflect that level in wording only if it fits the timeline implied by the employment inputs—do not extend history beyond those roles.',
    '- Use the posting’s vocabulary in summary, core_skills_text, and bullets where it matches the candidate’s real stack; use close synonyms only when they describe the same work.',
    '- If leadership, collaboration, or ownership is emphasized, show that with grounded, non-fluffy wording tied to the listed employers.',
    '',
    'Layout goal (matches a strong technical resume):',
    '- core_skills_text: plain text with short category labels and line breaks (e.g. "Languages & Frameworks" then a comma-separated line, then "Architecture & DevOps", etc.).',
    '- experience: role_title should read like a clean title line before the company (e.g. "Web Developer – Company Name" when appropriate).',
  ]
}

/** Experience-only JSON generation (resume generator page). */
export function resumeExperienceOnlyInstructionLines(): string[] {
  return [
    'Use only the experience rows provided below; keep each company_name, start_year, end_year, and job_location exactly as given.',
    'Read the full job description and align bullets with what they need (skills, years-level expectations where stated, leadership or collaboration themes).',
    'role_title: credible web/engineering title for that past role—not the lead’s target role from the posting. A different title per job row (e.g. Web Developer vs Senior Web Developer vs Full-Stack Engineer). Never "(Relevant Experience)".',
    'responsibilities: past tense, strong verb first; do not repeat the company name in bullets. No "At Company, I…" patterns. Vary openings; align themes with the job description. Use correct brand casing (WordPress, WooCommerce, JavaScript, GitHub, SEO, etc.) and end sentences with a period.',
    'If the posting stresses leadership or cross-functional work, reflect that with credible bullets without inventing specific metrics or team sizes.',
  ]
}
