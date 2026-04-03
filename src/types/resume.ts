export type GeneratedExperience = {
  company_name: string
  start_year: number
  end_year: number | null
  role_title: string
  responsibilities: string[]
  /** Job location (from template); optional for older drafts */
  job_location?: string | null
}

export type GeneratedResume = {
  generated_at: string
  candidate: {
    name: string
    headline: string | null
    summary: string | null
    email: string | null
    phone: string | null
    website: string | null
    location: string | null
    profile_photo_url: string | null
  }
  target: {
    company_name: string | null
    role_title: string | null
  }
  job_description: string
  custom_prompt: string
  sections: {
    core_skills_text: string
    education_text: string
  }
  experience: GeneratedExperience[]
  /** Rich HTML from TipTap; used for PDF export when present */
  document_html?: string | null
}
