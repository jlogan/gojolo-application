export type GeneratedCoverLetter = {
  generated_at: string
  candidate: {
    name: string
    email: string | null
    phone: string | null
    website: string | null
    location: string | null
  }
  target: {
    company_name: string | null
    role_title: string | null
  }
  job_description: string
  /** User-supplied prompt / requirements for the cover letter */
  prompt: string
  /** Plain-text cover letter body */
  content_text: string
  /** Rich HTML from TipTap editor; used for PDF export when present */
  content_html?: string | null
}
