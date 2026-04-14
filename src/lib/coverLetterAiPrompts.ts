/**
 * AI instructions for cover letter generation (lead wizard).
 * Takes the job description and user prompt/requirements into account.
 */

export function coverLetterInstructionLines(): string[] {
  return [
    'You are writing a cover letter for a job application.',
    '',
    'Voice & tone:',
    '- Write in first person as the candidate.',
    '- Conversational, confident, genuine — like a real person wrote it, not a template.',
    '- Avoid stiff corporate-speak ("I am writing to express my interest", "I believe my skills", "I would be a great fit").',
    '- NO buzzwords or filler ("passionate", "results-driven", "leverage", "synergy").',
    '- Vary sentence length and structure. Mix short punchy lines with longer ones.',
    '- Show personality — the candidate is a real human, not a resume bot.',
    '',
    'Structure:',
    '- Opening: a hook that connects the candidate to the role or company — something specific, not generic.',
    '- Middle: 2-3 short paragraphs connecting the candidate\'s experience to what the role needs. Reference specific skills, tools, or accomplishments that match the job description.',
    '- Closing: brief, forward-looking, no begging ("I look forward to discussing..." is fine, "I would be eternally grateful for the opportunity..." is not).',
    '- Total length: 250-400 words. Short enough to actually get read.',
    '',
    'Content rules:',
    '- Ground claims in specific experience — mention actual companies, tools, or outcomes from the candidate\'s background where relevant.',
    '- Mirror the job description\'s language and priorities naturally (don\'t just parrot keywords).',
    '- If the user provides specific requirements or questions to answer, address ALL of them directly.',
    '- Do NOT repeat the resume — the cover letter adds context and personality the resume can\'t.',
    '- Do NOT include a header/address block or "Dear Hiring Manager" — just the body text.',
    '- Do NOT include a sign-off like "Sincerely, [Name]" — the system adds that.',
    '',
    'Return ONLY the cover letter body text. No JSON, no markdown formatting, no commentary.',
  ]
}
