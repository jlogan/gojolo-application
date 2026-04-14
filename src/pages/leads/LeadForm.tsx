import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { jsPDF } from 'jspdf'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { resumeToHtml } from '@/lib/resumeHtml'
import { formatTemplateEducationText } from '@/lib/templateEducation'
import { resumeFullDraftInstructionLines } from '@/lib/resumeAiPrompts'
import { formatResumeYearRange, sanitizeResumeRoleTitle } from '@/lib/resumeFormat'
import { finalizeExperienceRoleTitles } from '@/lib/resumeExperienceTitles'
import { normalizeGeneratedResume } from '@/lib/resumeCopyNormalize'
import { buildResumePdfFromElement } from '@/lib/resumePdf'
import { coverLetterInstructionLines } from '@/lib/coverLetterAiPrompts'
import { coverLetterToHtml } from '@/lib/coverLetterHtml'
import { buildCoverLetterPdfFromElement } from '@/lib/coverLetterPdf'
import type { GeneratedExperience, GeneratedResume } from '@/types/resume'
import type { GeneratedCoverLetter } from '@/types/coverLetter'
import { ResumeRichEditor, type ResumeRichEditorHandle } from '@/components/resume/ResumeRichEditor'
import { ArrowLeft, Download, FileText } from 'lucide-react'

type CompanyOption = { id: string; name: string }
type ContactOption = { id: string; name: string; email: string | null; company_id: string | null }
type ResumeTemplateOption = {
  id: string
  name: string
  candidate_name: string
  headline: string | null
  summary: string | null
  email: string | null
  phone: string | null
  website: string | null
  location: string | null
  profile_photo_url: string | null
  settings: Record<string, unknown> | null
}
type OwnerOption = { user_id: string; display_name: string | null; email: string | null }

/** Visible label: prefer profile display name, else email, else short id. */
function formatLeadOwnerLabel(o: Pick<OwnerOption, 'display_name' | 'email' | 'user_id'>): string {
  const n = o.display_name?.trim()
  if (n) return n
  const e = o.email?.trim()
  if (e) return e
  return `User ${o.user_id.slice(0, 8)}…`
}

type TemplateExperience = {
  company_name: string
  start_year: number
  end_year: number | null
  job_location?: string | null
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON block found in AI response')
    return JSON.parse(match[0])
  }
}

function drawWrapped(doc: jsPDF, text: string, x: number, y: number, maxWidth: number, lineHeight = 5): number {
  const lines = doc.splitTextToSize(text, maxWidth)
  lines.forEach((line: string) => {
    doc.text(line, x, y)
    y += lineHeight
  })
  return y
}

async function buildResumePdf(payload: GeneratedResume): Promise<Blob> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const left = 14
  const width = 182
  let y = 16

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(payload.candidate.name || 'Candidate', left, y)
  y += 7

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  if (payload.candidate.headline?.trim()) {
    y = drawWrapped(doc, payload.candidate.headline.trim(), left, y, width, 4.8)
    y += 2
  }
  doc.setFontSize(9)
  doc.setTextColor(55)
  const contact1 = [payload.candidate.location, payload.candidate.website].filter(Boolean).join(' · ')
  const contact2 = [payload.candidate.phone, payload.candidate.email].filter(Boolean).join(' · ')
  if (contact1) {
    y = drawWrapped(doc, contact1, left, y, width, 4.2)
    y += 1
  }
  if (contact2) {
    y = drawWrapped(doc, contact2, left, y, width, 4.2)
    y += 1
  }
  doc.setTextColor(0)
  y += 2

  doc.setDrawColor(200)
  doc.line(left, y, left + width, y)
  y += 6

  const ensureSpace = (needed = 20) => {
    if (y + needed > 280) {
      doc.addPage()
      y = 16
    }
  }

  const addSection = (title: string, body: string) => {
    if (!body.trim()) return
    ensureSpace(18)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.text(title.toUpperCase(), left, y)
    y += 4
    doc.setDrawColor(200)
    doc.line(left, y, left + width, y)
    y += 4
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    y = drawWrapped(doc, body, left, y, width, 4.8)
    y += 3
  }

  addSection('Professional summary', payload.candidate.summary ?? '')
  addSection('Core skills', payload.sections.core_skills_text ?? '')

  if (payload.experience.length) {
    ensureSpace(20)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.text('PROFESSIONAL EXPERIENCE', left, y)
    y += 4
    doc.setDrawColor(200)
    doc.line(left, y, left + width, y)
    y += 5

    payload.experience.forEach((exp) => {
      ensureSpace(24)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10.5)
      const cleanRole = sanitizeResumeRoleTitle(exp.role_title?.trim() ?? '')
      const titleLine = cleanRole ? `${cleanRole} – ${exp.company_name}` : exp.company_name
      y = drawWrapped(doc, titleLine, left, y, width, 5)
      y += 1
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(55)
      const years = formatResumeYearRange(exp.start_year, exp.end_year)
      const meta = exp.job_location?.trim() ? `${years} | ${exp.job_location.trim()}` : years
      y = drawWrapped(doc, meta, left, y, width, 4.2)
      doc.setTextColor(0)
      y += 3

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      exp.responsibilities.forEach((bullet) => {
        ensureSpace(8)
        doc.text('•', left, y)
        y = drawWrapped(doc, bullet, left + 4, y, width - 4, 4.8)
      })
      y += 2
    })
  }

  addSection('Education', payload.sections.education_text ?? '')
  return doc.output('blob')
}

function slugify(input: string): string {
  const clean = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return clean || 'resume'
}

function buildFallbackGeneratedResume(args: {
  template: ResumeTemplateOption
  experiences: TemplateExperience[]
  bulletPointsPerJob: number
  title: string
  targetCompanyName: string | null
  jobDescription: string
}): GeneratedResume {
  const { template, experiences, bulletPointsPerJob, title, targetCompanyName, jobDescription } = args
  const jd = jobDescription.toLowerCase()

  const keywordPairs = [
    ['WordPress', /wordpress/],
    ['WooCommerce', /woocommerce/],
    ['Technical SEO', /technical seo|seo|schema|crawl/],
    ['Performance Optimization', /performance|core web vitals|site speed/],
    ['Google Analytics (GA4)', /ga4|google analytics/],
    ['Google Tag Manager', /gtm|tag manager/],
    ['A/B Testing', /a\/b|ab test|experiment/],
    ['CRM Integrations', /crm|integration|automation/],
    ['PHP', /\bphp\b/],
    ['MySQL', /mysql/],
  ] as const

  const matchedSkills = keywordPairs.filter(([, rx]) => rx.test(jd)).map(([name]) => name)
  const skills = matchedSkills.length ? matchedSkills : ['Web Development', 'Technical Troubleshooting', 'Performance Optimization']

  const bulletVariants = [
    (skill: string) =>
      `Maintained and extended web properties with recurring ${skill.toLowerCase()} work, custom implementations, and steady collaboration with stakeholders on priorities and releases.`,
    (skill: string) =>
      `Designed and shipped improvements spanning ${skill.toLowerCase()}, clearer UX patterns, and more reliable deployment and iteration workflows.`,
    (skill: string) =>
      `Modernized legacy surfaces by strengthening ${skill.toLowerCase()} practices, security-minded defaults, and performance-focused updates across the stack.`,
    (skill: string) =>
      `Partnered with cross-functional teams to align ${skill.toLowerCase()} delivery with roadmap goals, documentation, and sustainable engineering habits.`,
  ] as const

  const generatedExperience: GeneratedExperience[] = experiences.map((exp) => {
    const responsibilities = Array.from({ length: bulletPointsPerJob }).map((_, idx) => {
      const skill = skills[idx % skills.length]
      const pick = bulletVariants[(idx + exp.company_name.length) % bulletVariants.length]
      return pick(skill)
    })

    return {
      company_name: exp.company_name,
      start_year: exp.start_year,
      end_year: exp.end_year,
      role_title: '',
      responsibilities,
      job_location: exp.job_location?.trim() || null,
    }
  })

  const educationFromTemplate = formatTemplateEducationText(template.settings)

  const experienceFinal = finalizeExperienceRoleTitles(generatedExperience, title)

  return {
    generated_at: new Date().toISOString(),
    candidate: {
      name: template.candidate_name,
      headline: template.headline,
      summary: (() => {
        const top = skills.slice(0, 4).join(', ')
        const also = skills.length > 4 ? ` Additional depth across ${skills.slice(4, 7).join(', ')}.` : ''
        return (
          `Hands-on web and digital delivery leader with a track record of architecting, building, and maintaining production systems where ${top} matter.` +
          ` Deep expertise in those areas plus pragmatic UX, performance, and maintainability.` +
          ` Known for modernizing workflows, tightening release quality, and shipping high-impact products without sacrificing reliability.` +
          ` Strong collaborator in fast-moving environments; aligns engineering decisions with user and business needs.${also}`
        )
      })(),
      email: template.email,
      phone: template.phone,
      website: template.website,
      location: template.location,
      profile_photo_url: template.profile_photo_url,
    },
    target: {
      company_name: targetCompanyName,
      role_title: title,
    },
    job_description: jobDescription,
    custom_prompt: '',
    sections: {
      core_skills_text: skills.join(' • '),
      education_text: educationFromTemplate || 'Education details available upon request.',
    },
    experience: experienceFinal,
  }
}

export default function LeadForm() {
  const navigate = useNavigate()
  const locationQuery = useLocation()
  const matchEdit = useMatch('/leads/:leadId/edit')
  const isEditMode = Boolean(matchEdit)
  const editLeadId = matchEdit?.params.leadId ?? null
  const { currentOrg } = useOrg()
  const { user } = useAuth()

  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  /** After step 3 save on new-lead flow; used for step 4 activity + idempotent re-save from step 3. */
  const [draftLeadId, setDraftLeadId] = useState<string | null>(null)
  const [editDataLoaded, setEditDataLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)

  const [companies, setCompanies] = useState<CompanyOption[]>([])
  const [contacts, setContacts] = useState<ContactOption[]>([])
  const [templates, setTemplates] = useState<ResumeTemplateOption[]>([])
  const [owners, setOwners] = useState<OwnerOption[]>([])
  const [templateExperiences, setTemplateExperiences] = useState<TemplateExperience[]>([])

  // Step 1: opportunity
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('indeed')
  const [jobUrl, setJobUrl] = useState('')
  const [jobType, setJobType] = useState('full_time')
  const [workMode, setWorkMode] = useState('remote')
  const [compensationType, setCompensationType] = useState('salary')
  const [compensationValue, setCompensationValue] = useState('')
  const [location, setLocation] = useState('Remote')
  const [ownerUserId, setOwnerUserId] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [status, setStatus] = useState('new')

  // Step 2: company + contact
  const [companyMode, setCompanyMode] = useState<'existing' | 'new'>('new')
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [newCompanyName, setNewCompanyName] = useState('')

  const [contactMode, setContactMode] = useState<'none' | 'existing' | 'new'>('none')
  const [selectedContactId, setSelectedContactId] = useState('')
  const [newContactName, setNewContactName] = useState('')
  const [newContactEmail, setNewContactEmail] = useState('')

  // Step 3: resume builder
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [bulletPointsPerJob, setBulletPointsPerJob] = useState(4)
  const [generatedResume, setGeneratedResume] = useState<GeneratedResume | null>(null)
  const [prefillLoaded, setPrefillLoaded] = useState(false)
  const resumeEditorRef = useRef<ResumeRichEditorHandle>(null)

  // Cover letter state
  const [coverLetterPrompt, setCoverLetterPrompt] = useState('')
  const [generatedCoverLetter, setGeneratedCoverLetter] = useState<GeneratedCoverLetter | null>(null)
  const [generatingCoverLetter, setGeneratingCoverLetter] = useState(false)
  const coverLetterEditorRef = useRef<ResumeRichEditorHandle>(null)

  const handleResumeHtmlChange = useCallback((html: string) => {
    setGeneratedResume((prev) => (prev ? { ...prev, document_html: html } : prev))
  }, [])

  const handleCoverLetterHtmlChange = useCallback((html: string) => {
    setGeneratedCoverLetter((prev) => (prev ? { ...prev, content_html: html } : prev))
  }, [])

  const exportResumePdfBlob = useCallback(async (): Promise<Blob> => {
    if (!generatedResume) throw new Error('No resume draft')
    const printRoot = resumeEditorRef.current?.getPrintRoot()
    if (printRoot) {
      try {
        return await buildResumePdfFromElement(printRoot)
      } catch (e) {
        console.warn('HTML-based PDF export failed, using structured fallback', e)
      }
    }
    return buildResumePdf(generatedResume)
  }, [generatedResume])

  // Step 4: first attempt
  const [attemptType, setAttemptType] = useState('application')
  const [attemptChannel, setAttemptChannel] = useState('indeed')
  const [attemptStatus, setAttemptStatus] = useState('completed')
  const [attemptContent, setAttemptContent] = useState('')
  const [attemptExternalUrl, setAttemptExternalUrl] = useState('')
  const [attemptNextFollowUpDate, setAttemptNextFollowUpDate] = useState('')

  useEffect(() => {
    if (!currentOrg?.id) return

    supabase
      .from('companies')
      .select('id, name')
      .eq('org_id', currentOrg.id)
      .order('name')
      .then(({ data }) => setCompanies((data as CompanyOption[]) ?? []))

    supabase
      .from('contacts')
      .select('id, name, email, company_id')
      .eq('org_id', currentOrg.id)
      .order('name')
      .then(({ data }) => setContacts((data as ContactOption[]) ?? []))

    supabase
      .from('resume_templates')
      .select('id, name, candidate_name, headline, summary, email, phone, website, location, profile_photo_url, settings')
      .eq('org_id', currentOrg.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        const rows = (data as ResumeTemplateOption[]) ?? []
        setTemplates(rows)
        if (!isEditMode && !selectedTemplateId && rows[0]) setSelectedTemplateId(rows[0].id)
      })

    supabase
      .from('organization_users')
      .select('user_id')
      .eq('org_id', currentOrg.id)
      .then(async ({ data: ouRows }) => {
        const uids = [...new Set((ouRows ?? []).map((r: { user_id: string }) => r.user_id))]
        if (uids.length === 0) {
          setOwners([])
          return
        }
        const { data: profs } = await supabase.from('profiles').select('id, display_name, email').in('id', uids)
        const byId = new Map((profs ?? []).map((p: { id: string; display_name: string | null; email: string | null }) => [p.id, p]))
        const rows: OwnerOption[] = uids.map((uid) => {
          const p = byId.get(uid)
          return { user_id: uid, display_name: p?.display_name ?? null, email: p?.email ?? null }
        })
        rows.sort((a, b) => formatLeadOwnerLabel(a).localeCompare(formatLeadOwnerLabel(b), undefined, { sensitivity: 'base' }))
        setOwners(rows)
      })
  }, [currentOrg?.id, selectedTemplateId, isEditMode])

  useEffect(() => {
    if (!ownerUserId && user?.id) setOwnerUserId(user.id)
  }, [ownerUserId, user?.id])

  useEffect(() => {
    if (!isEditMode || !editLeadId || !currentOrg?.id || editDataLoaded) return
    ;(async () => {
      const { data: leadRow, error } = await supabase
        .from('leads')
        .select(
          'id, company_id, title, source, job_url, job_type, work_mode, compensation_type, compensation_value, location, job_description, owner_user_id, next_follow_up_at, meta',
        )
        .eq('id', editLeadId)
        .eq('org_id', currentOrg.id)
        .single()

      if (error || !leadRow) {
        alert('Lead not found or you do not have access.')
        navigate('/leads')
        return
      }

      const row = leadRow as {
        company_id: string | null
        title: string
        source: string
        job_url: string | null
        job_type: string | null
        work_mode: string | null
        compensation_type: string | null
        compensation_value: string | null
        location: string | null
        job_description: string | null
        owner_user_id: string | null
        next_follow_up_at: string | null
        meta: Record<string, unknown> | null
      }

      setTitle(row.title ?? '')
      setSource(row.source ?? 'indeed')
      setJobUrl(row.job_url ?? '')
      setJobType(row.job_type ?? 'full_time')
      setWorkMode(row.work_mode ?? 'remote')
      setCompensationType(row.compensation_type ?? 'salary')
      setCompensationValue(row.compensation_value ?? '')
      setLocation(row.location ?? 'Remote')
      setJobDescription(row.job_description ?? '')
      if (row.owner_user_id) setOwnerUserId(row.owner_user_id)
      if (row.next_follow_up_at) setAttemptNextFollowUpDate(row.next_follow_up_at.slice(0, 10))

      const meta = row.meta ?? {}
      const tid = typeof meta.resume_template_id === 'string' ? meta.resume_template_id : ''
      if (tid) setSelectedTemplateId(tid)
      const rg = meta.resume_generation as { bullet_points_per_job?: number } | undefined
      if (typeof rg?.bullet_points_per_job === 'number') setBulletPointsPerJob(rg.bullet_points_per_job)

      if (row.company_id) {
        setCompanyMode('existing')
        setSelectedCompanyId(row.company_id)
      } else {
        setCompanyMode('new')
        setNewCompanyName('')
      }

      const { data: lcRows } = await supabase.from('lead_contacts').select('contact_id, is_primary').eq('lead_id', editLeadId)
      const list = (lcRows ?? []) as { contact_id: string; is_primary: boolean }[]
      const primary = list.find((r) => r.is_primary) ?? list[0]
      if (primary?.contact_id) {
        setContactMode('existing')
        setSelectedContactId(primary.contact_id)
      } else {
        setContactMode('none')
      }

      const { data: docRow } = await supabase
        .from('resume_documents')
        .select('content_json, document_html')
        .eq('lead_id', editLeadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (docRow?.content_json && typeof docRow.content_json === 'object') {
        const cj = docRow.content_json as GeneratedResume
        const html = (docRow.document_html as string | null) ?? cj.document_html ?? undefined
        setGeneratedResume(normalizeGeneratedResume({ ...cj, document_html: html ?? cj.document_html }))
      }

      const { data: clDocRow } = await supabase
        .from('cover_letter_documents')
        .select('content_json, content_html, prompt')
        .eq('lead_id', editLeadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (clDocRow?.content_json && typeof clDocRow.content_json === 'object') {
        const clJson = clDocRow.content_json as GeneratedCoverLetter
        const clHtml = (clDocRow.content_html as string | null) ?? clJson.content_html ?? undefined
        setGeneratedCoverLetter({ ...clJson, content_html: clHtml ?? clJson.content_html })
        if (clDocRow.prompt) setCoverLetterPrompt(String(clDocRow.prompt))
      }

      setAttemptType('follow_up')
      setAttemptChannel('')
      setAttemptExternalUrl('')
      setAttemptContent('')
      setEditDataLoaded(true)
    })()
  }, [isEditMode, editLeadId, currentOrg?.id, editDataLoaded, navigate])

  useEffect(() => {
    if (!currentOrg?.id || prefillLoaded) return
    const params = new URLSearchParams(locationQuery.search)
    const sourceLeadId = params.get('from_lead')
    const requestedStep = params.get('step')

    if (!sourceLeadId) {
      setPrefillLoaded(true)
      return
    }

    ;(async () => {
      const { data, error } = await supabase
        .from('leads')
        .select('title, source, job_url, job_type, work_mode, compensation_type, compensation_value, location, job_description, status, companies(name)')
        .eq('id', sourceLeadId)
        .eq('org_id', currentOrg.id)
        .single()

      if (!error && data) {
        const lead = data as {
          title: string
          source: string
          job_url: string | null
          job_type: string | null
          work_mode: string | null
          compensation_type: string | null
          compensation_value: string | null
          location: string | null
          job_description: string | null
          status: string | null
          companies: { name: string } | { name: string }[] | null
        }

        const company = Array.isArray(lead.companies) ? lead.companies[0]?.name : lead.companies?.name

        setTitle(lead.title ?? '')
        setSource(lead.source ?? 'indeed')
        setJobUrl(lead.job_url ?? '')
        setJobType(lead.job_type ?? 'full_time')
        setWorkMode(lead.work_mode ?? 'remote')
        setCompensationType(lead.compensation_type ?? 'salary')
        setCompensationValue(lead.compensation_value ?? '')
        setLocation(lead.location ?? 'Remote')
        setJobDescription(lead.job_description ?? '')
        setStatus(lead.status ?? 'new')

        if (company) {
          setCompanyMode('new')
          setNewCompanyName(company)
        }

        if (requestedStep === '3') setStep(3)
      }

      setPrefillLoaded(true)
    })()
  }, [currentOrg?.id, locationQuery.search, prefillLoaded])

  useEffect(() => {
    if (!selectedTemplateId) {
      setTemplateExperiences([])
      return
    }
    supabase
      .from('resume_template_experiences')
      .select('company_name, start_year, end_year, job_location')
      .eq('template_id', selectedTemplateId)
      .order('sort_order', { ascending: true })
      .then(({ data }) => setTemplateExperiences((data as TemplateExperience[]) ?? []))
  }, [selectedTemplateId])

  useEffect(() => {
    if (isEditMode && step > 3) setStep(3)
  }, [isEditMode, step])

  const filteredContacts = useMemo(() => {
    if (!selectedCompanyId) return contacts
    return contacts.filter((c) => c.company_id === selectedCompanyId)
  }, [contacts, selectedCompanyId])

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  )

  const targetCompanyName = useMemo(() => {
    if (companyMode === 'new' && newCompanyName.trim()) return newCompanyName.trim()
    if (companyMode === 'existing' && selectedCompanyId) {
      return companies.find((c) => c.id === selectedCompanyId)?.name ?? null
    }
    return null
  }, [companyMode, newCompanyName, selectedCompanyId, companies])

  const canNextFromStep1 = title.trim().length > 0
  const canNextFromStep2 =
    (companyMode === 'existing' && !!selectedCompanyId) ||
    (companyMode === 'new' && newCompanyName.trim().length > 0) ||
    contactMode !== 'none'
  const canNextFromStep3 = isEditMode || !!generatedResume

  const generateResumePreview = async () => {
    if (!currentOrg?.id || !selectedTemplate || !jobDescription.trim()) {
      alert('Please choose a template and provide the job description first.')
      return
    }

    setGenerating(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('No auth session available')

      const uni = String(selectedTemplate.settings?.candidate_university ?? '').trim()
      const uniSubject = String(selectedTemplate.settings?.candidate_university_subject ?? '').trim()
      const uniYears = String(selectedTemplate.settings?.candidate_university_years ?? '').trim()
      const prompt = [
        'You are generating a highly tailored resume draft for one candidate.',
        ...resumeFullDraftInstructionLines(bulletPointsPerJob),
        '',
        'Use the job description and target role to optimize fit.',
        'Return STRICT JSON with this shape:',
        '{"summary":"...","core_skills_text":"...","education_text":"...","experience":[{"company_name":"...","start_year":2020,"end_year":2022,"role_title":"...","responsibilities":["...","..."]}]}',
        'The experience array must have one object per row in EMPLOYMENT INPUTS, in the same order, using the same company_name, start_year, end_year, and job_location values.',
        'summary: reusable across employers—no target job title, no hiring company name, no "this role/your posting". Mirror the job description’s skills and themes in a classic multi-sentence summary (mixed openings; not every sentence starting with "I").',
        'For education_text, incorporate the candidate university name, subject/degree, and years when provided; keep wording concise and professional.',
        '',
        `Candidate: ${selectedTemplate.candidate_name}`,
        `Candidate location: ${selectedTemplate.location ?? 'N/A'}`,
        `Candidate email: ${selectedTemplate.email ?? 'N/A'}`,
        `Candidate phone: ${selectedTemplate.phone ?? 'N/A'}`,
        `Candidate website: ${selectedTemplate.website ?? 'N/A'}`,
        `Candidate university / school: ${uni || 'N/A'}`,
        `Candidate subject / degree: ${uniSubject || 'N/A'}`,
        `Candidate university years: ${uniYears || 'N/A'}`,
        `Target company: ${targetCompanyName ?? 'N/A'}`,
        `Target role: ${title}`,
        '(Target company and target role are for tailoring only—do not paste them into the summary; keep the summary employer-agnostic.)',
        '',
        'JOB DESCRIPTION:',
        jobDescription,
        '',
        'EMPLOYMENT INPUTS (company, optional job location, start year, end year or null for present):',
        JSON.stringify(
          templateExperiences.map((e) => ({
            company_name: e.company_name,
            job_location: e.job_location?.trim() || null,
            start_year: e.start_year,
            end_year: e.end_year,
          })),
        ),
      ].join('\n')

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`
      const callAi = async (message: string) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ message, orgId: currentOrg.id, history: [] }),
        })
        const data = await res.json()
        if (data?.error) throw new Error(data.error)
        return String(data?.message ?? '')
      }

      let raw = await callAi(prompt)
      let parsed: Record<string, unknown>
      try {
        parsed = extractJson(raw) as Record<string, unknown>
      } catch {
        raw = await callAi(`${prompt}\n\nIMPORTANT: Respond with JSON only. No markdown, no commentary.`)
        parsed = extractJson(raw) as Record<string, unknown>
      }

      const aiExp = Array.isArray(parsed.experience) ? (parsed.experience as Record<string, unknown>[]) : []

      const experiences: GeneratedExperience[] = finalizeExperienceRoleTitles(
        templateExperiences.map((tmpl, idx) => {
          const item = aiExp[idx] ?? {}
          const rawBullets = Array.isArray(item.responsibilities)
            ? item.responsibilities.map((r) => String(r)).filter(Boolean)
            : []
          const responsibilities = rawBullets.slice(0, bulletPointsPerJob)
          return {
            company_name: tmpl.company_name,
            start_year: tmpl.start_year,
            end_year: tmpl.end_year,
            role_title: sanitizeResumeRoleTitle(String(item.role_title ?? '')),
            responsibilities,
            job_location: tmpl.job_location?.trim() || null,
          }
        }),
        title,
      )

      const fallbackEducation =
        formatTemplateEducationText(selectedTemplate.settings) || String(selectedTemplate.settings?.education_text ?? '')

      const next: GeneratedResume = {
        generated_at: new Date().toISOString(),
        candidate: {
          name: selectedTemplate.candidate_name,
          headline: selectedTemplate.headline,
          summary: String(parsed.summary ?? selectedTemplate.summary ?? ''),
          email: selectedTemplate.email,
          phone: selectedTemplate.phone,
          website: selectedTemplate.website,
          location: selectedTemplate.location,
          profile_photo_url: selectedTemplate.profile_photo_url,
        },
        target: {
          company_name: targetCompanyName,
          role_title: title,
        },
        job_description: jobDescription,
        custom_prompt: '',
        sections: {
          core_skills_text: String(parsed.core_skills_text ?? selectedTemplate.settings?.core_skills_text ?? ''),
          education_text: String(parsed.education_text ?? fallbackEducation),
        },
        experience: experiences,
      }

      setGeneratedResume(normalizeGeneratedResume(next))
    } catch (err) {
      const fallback = buildFallbackGeneratedResume({
        template: selectedTemplate,
        experiences: templateExperiences,
        bulletPointsPerJob,
        title,
        targetCompanyName,
        jobDescription,
      })
      setGeneratedResume(normalizeGeneratedResume(fallback))
      alert(`AI service was unavailable, so we generated a dynamic fallback draft from this lead instead: ${(err as Error).message}`)
    } finally {
      setGenerating(false)
    }
  }

  const downloadGeneratedPdf = async () => {
    if (!generatedResume) return
    try {
      const blob = await exportResumePdfBlob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${slugify(title)}-resume-preview.pdf`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Could not build PDF: ${(e as Error).message}`)
    }
  }

  const generateCoverLetterPreview = async () => {
    if (!currentOrg?.id || !selectedTemplate || !jobDescription.trim()) {
      alert('Please choose a template and provide the job description first.')
      return
    }

    setGeneratingCoverLetter(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('No auth session available')

      const prompt = [
        ...coverLetterInstructionLines(),
        '',
        `Candidate name: ${selectedTemplate.candidate_name}`,
        `Candidate location: ${selectedTemplate.location ?? 'N/A'}`,
        `Candidate email: ${selectedTemplate.email ?? 'N/A'}`,
        `Candidate phone: ${selectedTemplate.phone ?? 'N/A'}`,
        `Candidate website: ${selectedTemplate.website ?? 'N/A'}`,
        `Target company: ${targetCompanyName ?? 'N/A'}`,
        `Target role: ${title}`,
        '',
        'JOB DESCRIPTION:',
        jobDescription,
        '',
        ...(coverLetterPrompt.trim()
          ? [
              'SPECIFIC REQUIREMENTS / INSTRUCTIONS FROM THE USER:',
              coverLetterPrompt.trim(),
              '',
              'Address ALL of the above requirements in the cover letter.',
            ]
          : []),
        ...(generatedResume
          ? [
              '',
              'CANDIDATE RESUME SUMMARY (for context — do not repeat verbatim):',
              `Professional summary: ${generatedResume.candidate.summary ?? ''}`,
              `Core skills: ${generatedResume.sections.core_skills_text}`,
              `Experience companies: ${generatedResume.experience.map((e) => `${e.role_title} at ${e.company_name}`).join(', ')}`,
            ]
          : []),
      ].join('\n')

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ message: prompt, orgId: currentOrg.id, history: [] }),
      })
      const data = await res.json()
      if (data?.error) throw new Error(data.error)

      const bodyText = String(data?.message ?? '').trim()

      const cl: GeneratedCoverLetter = {
        generated_at: new Date().toISOString(),
        candidate: {
          name: selectedTemplate.candidate_name,
          email: selectedTemplate.email,
          phone: selectedTemplate.phone,
          website: selectedTemplate.website,
          location: selectedTemplate.location,
        },
        target: {
          company_name: targetCompanyName,
          role_title: title,
        },
        job_description: jobDescription,
        prompt: coverLetterPrompt,
        content_text: bodyText,
      }

      setGeneratedCoverLetter({ ...cl, content_html: coverLetterToHtml(cl) })
    } catch (err) {
      console.error(err)
      alert(`Could not generate cover letter: ${(err as Error).message}`)
    } finally {
      setGeneratingCoverLetter(false)
    }
  }

  const downloadCoverLetterPdf = async () => {
    if (!generatedCoverLetter) return
    try {
      const printRoot = coverLetterEditorRef.current?.getPrintRoot()
      if (!printRoot) throw new Error('Editor not ready')
      const blob = await buildCoverLetterPdfFromElement(printRoot)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${slugify(title)}-cover-letter.pdf`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Could not build cover letter PDF: ${(e as Error).message}`)
    }
  }

  /** Insert or update lead + company/contact links + optional resume PDF. Returns lead id and resolved primary contact id. */
  const persistLeadFromWizard = async (existingLeadId: string | null): Promise<{ leadId: string; contactId: string | null }> => {
    if (!currentOrg?.id) throw new Error('No organization')
    const { data: userResult } = await supabase.auth.getUser()
    const userId = userResult?.user?.id ?? null

    let companyId: string | null = null
    if (companyMode === 'existing' && selectedCompanyId) {
      companyId = selectedCompanyId
    } else if (companyMode === 'new' && newCompanyName.trim()) {
      const { data: createdCompany, error: companyErr } = await supabase
        .from('companies')
        .insert({ org_id: currentOrg.id, name: newCompanyName.trim(), sourced_from_lead: true })
        .select('id')
        .single()
      if (companyErr) throw companyErr
      companyId = (createdCompany as { id: string }).id
    }

    let contactId: string | null = null
    if (contactMode === 'existing' && selectedContactId) {
      contactId = selectedContactId
    } else if (contactMode === 'new' && newContactName.trim()) {
      const { data: createdContact, error: contactErr } = await supabase
        .from('contacts')
        .insert({
          org_id: currentOrg.id,
          company_id: companyId,
          type: 'lead',
          name: newContactName.trim(),
          email: newContactEmail.trim() || null,
          sourced_from_lead: true,
        })
        .select('id')
        .single()
      if (contactErr) throw contactErr
      contactId = (createdContact as { id: string }).id
    }

    const leadMetaBase: Record<string, unknown> = {
      resume_template_id: selectedTemplateId || null,
      compensation_type: compensationType,
      resume_generation: {
        bullet_points_per_job: bulletPointsPerJob,
      },
    }

    let leadId: string

    if (existingLeadId) {
      const { data: metaRow } = await supabase.from('leads').select('meta').eq('id', existingLeadId).eq('org_id', currentOrg.id).single()
      const prevMeta = (metaRow?.meta as Record<string, unknown>) ?? {}
      const leadMeta: Record<string, unknown> = { ...prevMeta, ...leadMetaBase }

      const updatePayload: Record<string, unknown> = {
        company_id: companyId,
        title: title.trim(),
        source,
        job_url: jobUrl.trim() || null,
        job_type: jobType,
        work_mode: workMode,
        compensation_value: compensationValue.trim() || null,
        compensation_type: compensationType,
        location: location.trim() || null,
        job_description: jobDescription.trim() || null,
        owner_user_id: ownerUserId || userId,
        meta: leadMeta,
        updated_at: new Date().toISOString(),
      }

      const { error: updateErr } = await supabase.from('leads').update(updatePayload).eq('id', existingLeadId).eq('org_id', currentOrg.id)
      if (updateErr) throw updateErr
      leadId = existingLeadId

      if (contactId) {
        const { data: prim } = await supabase.from('lead_contacts').select('id').eq('lead_id', leadId).eq('is_primary', true).maybeSingle()
        const primRow = prim as { id: string } | null
        if (primRow?.id) {
          await supabase.from('lead_contacts').update({ contact_id: contactId }).eq('id', primRow.id)
        } else {
          await supabase.from('lead_contacts').insert({
            lead_id: leadId,
            contact_id: contactId,
            role: 'target',
            is_primary: true,
          })
        }
      }
    } else {
      const { data: createdLead, error: leadErr } = await supabase
        .from('leads')
        .insert({
          org_id: currentOrg.id,
          company_id: companyId,
          title: title.trim(),
          source,
          status,
          job_url: jobUrl.trim() || null,
          job_type: jobType,
          work_mode: workMode,
          compensation_value: compensationValue.trim() || null,
          compensation_type: compensationType,
          location: location.trim() || null,
          job_description: jobDescription.trim() || null,
          owner_user_id: ownerUserId || userId,
          next_follow_up_at: null,
          meta: leadMetaBase,
          created_by: userId,
        })
        .select('id')
        .single()

      if (leadErr) throw leadErr
      leadId = (createdLead as { id: string }).id

      if (contactId) {
        await supabase.from('lead_contacts').insert({
          lead_id: leadId,
          contact_id: contactId,
          role: 'target',
          is_primary: true,
        })
      }
    }

    if (generatedResume) {
      const latestHtml = resumeEditorRef.current?.getHtml() ?? generatedResume.document_html ?? null
      const resumeSnapshot: GeneratedResume = { ...generatedResume, document_html: latestHtml }

      const pdfBlob = await exportResumePdfBlob()
      const ts = Date.now()
      const path = `${currentOrg.id}/${leadId}/${ts}-${slugify(title)}.pdf`

      const { error: uploadErr } = await supabase.storage
        .from('lead-resumes')
        .upload(path, pdfBlob, { contentType: 'application/pdf', upsert: false })
      if (uploadErr) throw uploadErr

      const { data: signed } = await supabase.storage.from('lead-resumes').createSignedUrl(path, 60 * 60 * 24 * 7)

      const { error: resumeErr } = await supabase.from('resume_documents').insert({
        org_id: currentOrg.id,
        lead_id: leadId,
        template_id: selectedTemplateId || null,
        candidate_name: resumeSnapshot.candidate.name,
        company_name: resumeSnapshot.target.company_name,
        role_title: resumeSnapshot.target.role_title,
        job_description: resumeSnapshot.job_description,
        render_format: 'pdf',
        file_path: path,
        file_url: signed?.signedUrl ?? null,
        content_json: resumeSnapshot,
        document_html: latestHtml,
        created_by: userId,
      })
      if (resumeErr) throw resumeErr
    }

    if (generatedCoverLetter) {
      const latestClHtml = coverLetterEditorRef.current?.getHtml() ?? generatedCoverLetter.content_html ?? null
      const clSnapshot: GeneratedCoverLetter = { ...generatedCoverLetter, content_html: latestClHtml }

      let clPdfBlob: Blob | null = null
      const clPrintRoot = coverLetterEditorRef.current?.getPrintRoot()
      if (clPrintRoot) {
        try {
          clPdfBlob = await buildCoverLetterPdfFromElement(clPrintRoot)
        } catch (e) {
          console.warn('Cover letter PDF export failed', e)
        }
      }

      let clFilePath: string | null = null
      let clFileUrl: string | null = null

      if (clPdfBlob) {
        const clTs = Date.now()
        clFilePath = `${currentOrg.id}/${leadId}/${clTs}-${slugify(title)}-cover-letter.pdf`
        const { error: clUploadErr } = await supabase.storage
          .from('lead-cover-letters')
          .upload(clFilePath, clPdfBlob, { contentType: 'application/pdf', upsert: false })
        if (clUploadErr) console.warn('Cover letter upload error:', clUploadErr)
        else {
          const { data: clSigned } = await supabase.storage.from('lead-cover-letters').createSignedUrl(clFilePath, 60 * 60 * 24 * 7)
          clFileUrl = clSigned?.signedUrl ?? null
        }
      }

      const { error: clErr } = await supabase.from('cover_letter_documents').insert({
        org_id: currentOrg.id,
        lead_id: leadId,
        template_id: selectedTemplateId || null,
        candidate_name: clSnapshot.candidate.name,
        company_name: clSnapshot.target.company_name,
        role_title: clSnapshot.target.role_title,
        job_description: clSnapshot.job_description,
        prompt: clSnapshot.prompt || null,
        content_text: clSnapshot.content_text,
        content_html: latestClHtml,
        render_format: 'pdf',
        file_path: clFilePath,
        file_url: clFileUrl,
        content_json: clSnapshot,
        created_by: userId,
      })
      if (clErr) console.warn('Cover letter document insert error:', clErr)
    }

    return { leadId, contactId }
  }

  const handleSaveLeadFromStep3 = async () => {
    if (!currentOrg?.id || !title.trim()) return
    if (!selectedTemplateId.trim()) {
      alert(isEditMode ? 'Select a resume template before saving.' : 'Select a resume template before creating this lead.')
      return
    }
    setSaving(true)
    try {
      if (isEditMode && editLeadId) {
        await persistLeadFromWizard(editLeadId)
        navigate(`/leads/${editLeadId}`)
        return
      }
      const { leadId } = await persistLeadFromWizard(draftLeadId)
      setDraftLeadId(leadId)
      setStep(4)
    } catch (err) {
      console.error(err)
      alert(`Could not save lead: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleStep4Skip = () => {
    if (!draftLeadId) return
    navigate(`/leads/${draftLeadId}`)
  }

  const handleStep4SaveChanges = async () => {
    if (!draftLeadId || !currentOrg?.id) return
    if (!attemptContent.trim() && !attemptExternalUrl.trim()) {
      alert('Add notes or an external URL to log this activity, or use Skip activity.')
      return
    }
    setSaving(true)
    try {
      const { data: userResult } = await supabase.auth.getUser()
      const userId = userResult?.user?.id ?? null

      const { data: lcRows } = await supabase
        .from('lead_contacts')
        .select('contact_id')
        .eq('lead_id', draftLeadId)
        .order('is_primary', { ascending: false })
        .limit(1)
      const primaryContactId = (lcRows?.[0] as { contact_id: string } | undefined)?.contact_id ?? null

      const attemptedAt = new Date().toISOString()
      const { error: attemptErr } = await supabase.from('lead_attempts').insert({
        lead_id: draftLeadId,
        org_id: currentOrg.id,
        contact_id: primaryContactId,
        attempt_type: attemptType,
        channel: attemptChannel || null,
        status: attemptStatus,
        content: attemptContent.trim() || null,
        external_url: attemptExternalUrl.trim() || null,
        attempted_at: attemptedAt,
        next_follow_up_at: attemptNextFollowUpDate ? new Date(`${attemptNextFollowUpDate}T09:00:00`).toISOString() : null,
        created_by: userId,
      })
      if (attemptErr) throw attemptErr

      const leadPatch: Record<string, unknown> = { last_activity_at: attemptedAt }
      if (attemptNextFollowUpDate.trim()) {
        leadPatch.next_follow_up_at = new Date(`${attemptNextFollowUpDate}T09:00:00`).toISOString()
      }
      await supabase.from('leads').update(leadPatch).eq('id', draftLeadId).eq('org_id', currentOrg.id)

      navigate(`/leads/${draftLeadId}`)
    } catch (err) {
      console.error(err)
      alert(`Could not save activity: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl" data-testid="lead-form-page">
      <Link
        to={isEditMode && editLeadId ? `/leads/${editLeadId}` : '/leads'}
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> {isEditMode ? 'Lead details' : 'Leads'}
      </Link>

      <h1 className="text-xl font-semibold text-white mb-1">{isEditMode ? 'Edit lead' : 'New lead wizard'}</h1>
      <p className="text-sm text-gray-400 mb-6">
        {isEditMode
          ? 'Update opportunity details, company, and resume. Status can only be changed on the lead details page.'
          : 'Step 3 saves the lead and resume. Step 4 is optional — log an activity or skip to the lead page.'}
      </p>

      <div className="flex gap-2 mb-6 text-xs">
        {(isEditMode ? [1, 2, 3] : [1, 2, 3, 4]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(s)}
            disabled={!isEditMode && s === 4 && !draftLeadId}
            className={`px-3 py-1.5 rounded border ${step === s ? 'border-accent text-accent' : 'border-border text-gray-400 hover:text-gray-200'} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            Step {s}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-lg text-white font-medium">1) Opportunity</h2>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Role title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Senior Web Developer"
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
          </div>

          <div className={`grid grid-cols-1 gap-3 ${isEditMode ? '' : 'md:grid-cols-2'}`}>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Source</label>
              <select value={source} onChange={(e) => setSource(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="indeed">Indeed</option>
                <option value="linkedin">LinkedIn</option>
                <option value="upwork">Upwork</option>
                <option value="outbound">Outbound</option>
                <option value="referral">Referral</option>
                <option value="other">Other</option>
              </select>
            </div>
            {!isEditMode && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Lead status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                  <option value="new">New</option>
                  <option value="researching">Researching</option>
                  <option value="applying">Applying</option>
                  <option value="applied">Applied</option>
                  <option value="follow_up">Follow-up</option>
                  <option value="interview">Interview</option>
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Job URL</label>
            <input value={jobUrl} onChange={(e) => setJobUrl(e.target.value)} placeholder="https://..."
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Job type</label>
              <select value={jobType} onChange={(e) => setJobType(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="full_time">Full-time</option>
                <option value="contract">Contract</option>
                <option value="part_time">Part-time</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Work mode</label>
              <select value={workMode} onChange={(e) => setWorkMode(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">On-site</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Lead owner</label>
              <select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="">Unassigned</option>
                {owners.map((o) => (
                  <option key={o.user_id} value={o.user_id}>
                    {formatLeadOwnerLabel(o)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Compensation type</label>
              <select value={compensationType} onChange={(e) => setCompensationType(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="salary">Salary</option>
                <option value="hourly">Hourly</option>
                <option value="fixed">Fixed amount</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Compensation value (range or amount)</label>
              <input value={compensationValue} onChange={(e) => setCompensationValue(e.target.value)} placeholder="e.g. $120k-$150k or $70/hr"
                className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Location</label>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Remote"
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Job description</label>
            <textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={8} placeholder="Paste job description here"
              className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
          </div>

          <div className="flex justify-end">
            <button type="button" disabled={!canNextFromStep1} onClick={() => setStep(2)}
              className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50">
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <h2 className="text-lg text-white font-medium">2) Company + contacts</h2>

          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm text-gray-300 font-medium">Company</p>
            <div className="flex gap-2 text-sm">
              <button type="button" onClick={() => setCompanyMode('new')} className={`px-3 py-1.5 rounded ${companyMode === 'new' ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300'}`}>New</button>
              <button type="button" onClick={() => setCompanyMode('existing')} className={`px-3 py-1.5 rounded ${companyMode === 'existing' ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300'}`}>Existing</button>
            </div>

            {companyMode === 'existing' ? (
              <select value={selectedCompanyId} onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="">Select company…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <input value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)} placeholder="New company name"
                className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
            )}
          </div>

          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm text-gray-300 font-medium">Primary contact (optional)</p>
            <div className="flex gap-2 text-sm flex-wrap">
              <button type="button" onClick={() => setContactMode('none')} className={`px-3 py-1.5 rounded ${contactMode === 'none' ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300'}`}>None</button>
              <button type="button" onClick={() => setContactMode('new')} className={`px-3 py-1.5 rounded ${contactMode === 'new' ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300'}`}>New</button>
              <button type="button" onClick={() => setContactMode('existing')} className={`px-3 py-1.5 rounded ${contactMode === 'existing' ? 'bg-accent text-white' : 'bg-surface-muted text-gray-300'}`}>Existing</button>
            </div>

            {contactMode === 'existing' && (
              <select value={selectedContactId} onChange={(e) => setSelectedContactId(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="">Select contact…</option>
                {filteredContacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ''}</option>)}
              </select>
            )}

            {contactMode === 'new' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={newContactName} onChange={(e) => setNewContactName(e.target.value)} placeholder="Contact name"
                  className="rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
                <input value={newContactEmail} onChange={(e) => setNewContactEmail(e.target.value)} placeholder="Contact email"
                  className="rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button type="button" onClick={() => setStep(1)} className="px-4 py-2.5 rounded-lg border border-border text-gray-300">Back</button>
            <button type="button" disabled={!canNextFromStep2} onClick={() => setStep(3)} className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50">Next</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <h2 className="text-lg text-white font-medium">3) Build resume</h2>
          <p className="text-sm text-gray-400">
            Pick a template, set bullets per job, generate a draft tailored to the job description, then edit the document below or download PDF.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-300">Template</label>
                <Link to="/admin/resume-templates" target="_blank" className="text-xs text-accent hover:underline">Manage templates</Link>
              </div>
              <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                <option value="">Select template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">How many bullet points per job?</label>
              <select value={String(bulletPointsPerJob)} onChange={(e) => setBulletPointsPerJob(Number(e.target.value))}
                className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
                {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={generateResumePreview} disabled={generating || !selectedTemplateId || !jobDescription.trim()}
              className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50">
              {generating ? 'Generating…' : 'Generate resume draft'}
            </button>
          </div>

          {generatedResume && (
            <div className="rounded-lg border border-border p-4 bg-surface-elevated/40">
              <div className="mb-4">
                <p className="text-sm text-gray-200 font-medium">Edit your resume</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Click and type like a document. Use the toolbar for bullets, bold, and headings—Download PDF is on the right end of the toolbar.
                </p>
              </div>

              <div className="pb-2">
                <ResumeRichEditor
                  ref={resumeEditorRef}
                  remountKey={generatedResume.generated_at}
                  initialHtml={generatedResume.document_html ?? resumeToHtml(generatedResume)}
                  onHtmlChange={handleResumeHtmlChange}
                  toolbarTrailing={
                    <button
                      type="button"
                      onClick={downloadGeneratedPdf}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm font-medium"
                    >
                      <Download className="w-4 h-4" /> Download PDF
                    </button>
                  }
                />
              </div>
            </div>
          )}

          {/* Cover letter section */}
          <div className="rounded-lg border border-border p-4 bg-surface-elevated/40 mt-6">
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-4 h-4 text-accent" />
                <p className="text-sm text-gray-200 font-medium">Cover letter</p>
              </div>
              <p className="text-xs text-gray-500">
                Optional — generate a cover letter tailored to the job description. Add specific requirements below (e.g., questions the employer wants answered).
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Prompt / requirements (optional)</label>
                <textarea
                  value={coverLetterPrompt}
                  onChange={(e) => setCoverLetterPrompt(e.target.value)}
                  rows={4}
                  placeholder="e.g., Answer these questions: 1) Describe a UI change that was more complex than expected. 2) What front-end practice do you think is over-emphasized? Also mention your favorite hobby."
                  className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white text-sm"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void generateCoverLetterPreview()}
                  disabled={generatingCoverLetter || !selectedTemplateId || !jobDescription.trim()}
                  className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50 text-sm"
                >
                  {generatingCoverLetter ? 'Generating…' : generatedCoverLetter ? 'Regenerate cover letter' : 'Generate cover letter'}
                </button>
              </div>

              {generatedCoverLetter && (
                <div className="pt-2">
                  <div className="mb-2">
                    <p className="text-xs text-gray-500">
                      Edit the cover letter below. Download PDF is on the right end of the toolbar.
                    </p>
                  </div>
                  <ResumeRichEditor
                    ref={coverLetterEditorRef}
                    remountKey={generatedCoverLetter.generated_at}
                    initialHtml={generatedCoverLetter.content_html ?? coverLetterToHtml(generatedCoverLetter)}
                    onHtmlChange={handleCoverLetterHtmlChange}
                    toolbarTrailing={
                      <button
                        type="button"
                        onClick={() => void downloadCoverLetterPdf()}
                        className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm font-medium"
                      >
                        <Download className="w-4 h-4" /> Download PDF
                      </button>
                    }
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-between">
            <button type="button" onClick={() => setStep(2)} className="px-4 py-2.5 rounded-lg border border-border text-gray-300">Back</button>
            <button
              type="button"
              disabled={!canNextFromStep3 || saving}
              onClick={() => void handleSaveLeadFromStep3()}
              className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50"
            >
              {saving
                ? 'Saving…'
                : isEditMode
                  ? 'Save changes'
                  : draftLeadId
                    ? 'Update & continue'
                    : 'Save Lead & Continue'}
            </button>
          </div>
        </div>
      )}

      {!isEditMode && step === 4 && (
        <div className="space-y-4">
          <h2 className="text-lg text-white font-medium">4) Log activity (optional)</h2>
          <p className="text-sm text-gray-500">
            The lead is already saved. Add a quick activity below, or skip to open the lead page.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select value={attemptType} onChange={(e) => setAttemptType(e.target.value)} className="rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
              <option value="application">Application</option>
              <option value="email_outreach">Email outreach</option>
              <option value="linkedin_message">LinkedIn message</option>
              <option value="upwork_proposal">Upwork proposal</option>
              <option value="follow_up">Follow-up</option>
              <option value="call">Call</option>
              <option value="meeting">Meeting</option>
              <option value="inbound">They reached out (inbound)</option>
              <option value="appointment">Appointment booked</option>
              <option value="other">Other</option>
            </select>
            <input value={attemptChannel} onChange={(e) => setAttemptChannel(e.target.value)} placeholder="Channel (Indeed, Email, LinkedIn…)"
              className="rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
            <select value={attemptStatus} onChange={(e) => setAttemptStatus(e.target.value)} className="rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white">
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="replied">Replied</option>
              <option value="interview">Interview</option>
            </select>
          </div>
          <input type="date" value={attemptNextFollowUpDate} onChange={(e) => setAttemptNextFollowUpDate(e.target.value)}
            className="rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
          <input value={attemptExternalUrl} onChange={(e) => setAttemptExternalUrl(e.target.value)} placeholder="External URL (application page, linkedin thread, etc.)"
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />
          <textarea value={attemptContent} onChange={(e) => setAttemptContent(e.target.value)} rows={6} placeholder="What was sent / notes"
            className="w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white" />

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            <button type="button" onClick={() => setStep(3)} className="px-4 py-2.5 rounded-lg border border-border text-gray-300 w-full sm:w-auto">
              Back
            </button>
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto sm:justify-end">
              <button
                type="button"
                disabled={saving}
                onClick={handleStep4Skip}
                className="px-4 py-2.5 rounded-lg border border-border text-gray-200 hover:bg-surface-muted font-medium disabled:opacity-50"
              >
                Skip activity
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleStep4SaveChanges()}
                className="px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
