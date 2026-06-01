import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, GripVertical, Plus, Trash2, Upload } from 'lucide-react'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { PhotoCropModal } from '@/components/resume/PhotoCropModal'

type ResumeTemplate = {
  id: string
  name: string
  candidate_name: string
  email: string | null
  phone: string | null
  website: string | null
  location: string | null
  profile_photo_url: string | null
  settings: Record<string, unknown> | null
}

type TemplateExperience = {
  id: string
  template_id: string
  sort_order: number
  company_name: string
  /** Empty until the user enters a year (new rows do not default to the current year). */
  start_year: number | ''
  end_year: number | null
  job_location: string | null
}

type TemplateForm = {
  name: string
  candidate_name: string
  location: string
  email: string
  phone: string
  website: string
  candidate_university: string
  candidate_university_years: string
  candidate_university_subject: string
  profile_photo_url: string
}

const emptyForm: TemplateForm = {
  name: '',
  candidate_name: '',
  location: '',
  email: '',
  phone: '',
  website: '',
  candidate_university: '',
  candidate_university_years: '',
  candidate_university_subject: '',
  profile_photo_url: '',
}

function sanitizeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/(^-|-$)/g, '')
}

/**
 * Persist featured jobs via DB RPC (single transaction). Client-side delete/insert/update was fragile:
 * PostgREST updates can match 0 rows without error, then orphan deletes wiped real rows; split requests also
 * committed template saves while experience writes failed.
 */
async function saveResumeTemplateExperiencesViaRpc(templateId: string, experiences: TemplateExperience[]) {
  const hasBlankCompany = experiences.some((e) => !e.company_name.trim())
  if (experiences.length > 0 && hasBlankCompany) {
    throw new Error(
      'Each featured job must have a company name. Fill in the company field or remove empty job rows before saving.',
    )
  }

  const withCompany = experiences.filter((e) => e.company_name.trim().length > 0)

  const items = withCompany.map((exp) => {
    const start_year = exp.start_year === '' ? NaN : Number(exp.start_year)
    if (!Number.isFinite(start_year)) {
      throw new Error('Each job needs a valid start year.')
    }
    const end_year = exp.end_year != null ? Number(exp.end_year) : null
    if (end_year != null && !Number.isFinite(end_year)) {
      throw new Error('End year must be a valid number or left empty for present.')
    }
    return {
      company_name: exp.company_name.trim(),
      start_year,
      end_year,
      job_location: exp.job_location?.trim() || null,
    }
  })

  const { error } = await supabase.rpc('save_resume_template_experiences', {
    p_template_id: templateId,
    p_items: items,
  })

  if (error) throw new Error(error.message)
}

function SortableExperienceRow({
  exp,
  index,
  onPatch,
  onRemove,
}: {
  exp: TemplateExperience
  index: number
  onPatch: (idx: number, patch: Partial<TemplateExperience>) => void
  onRemove: (idx: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: exp.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
    boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.35)' : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border border-border bg-surface-muted/30 p-2 ${isDragging ? 'ring-2 ring-accent/60' : ''}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
        <div className="md:col-span-1 flex md:justify-center">
          <button
            type="button"
            className="p-2 rounded-md border border-border text-gray-400 hover:text-white hover:bg-surface-muted cursor-grab active:cursor-grabbing touch-none"
            title="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="w-4 h-4" />
          </button>
        </div>
        <input
          value={exp.company_name}
          onChange={(e) => onPatch(index, { company_name: e.target.value })}
          placeholder="Company name"
          className="md:col-span-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
        />
        <input
          value={exp.job_location ?? ''}
          onChange={(e) => onPatch(index, { job_location: e.target.value || null })}
          placeholder="Job location (e.g. Atlanta, GA)"
          className="md:col-span-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
        />
        <input
          type="number"
          value={exp.start_year === '' ? '' : exp.start_year}
          onChange={(e) => {
            const v = e.target.value
            onPatch(index, { start_year: v === '' ? '' : Number(v) })
          }}
          placeholder="Start year"
          className="md:col-span-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
        />
        <div className="md:col-span-3 flex items-center gap-2">
          <input
            type="number"
            value={exp.end_year ?? ''}
            onChange={(e) => onPatch(index, { end_year: e.target.value ? Number(e.target.value) : null })}
            placeholder="Present"
            className="flex-1 rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
          />
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="p-2 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 shrink-0"
            aria-label="Remove job"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ResumeTemplatesPage({ embeddedInAdmin = false }: { embeddedInAdmin?: boolean }) {
  const { currentOrg } = useOrg()

  const [templates, setTemplates] = useState<ResumeTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [form, setForm] = useState<TemplateForm>(emptyForm)
  const [experiences, setExperiences] = useState<TemplateExperience[]>([])

  const [mode, setMode] = useState<'list' | 'edit'>('list')
  const [cropOpen, setCropOpen] = useState(false)
  const [cropSrc, setCropSrc] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const loadTemplates = async () => {
    if (!currentOrg?.id) return
    setLoading(true)

    const { data, error } = await supabase
      .from('resume_templates')
      .select('id, name, candidate_name, email, phone, website, location, profile_photo_url, settings')
      .eq('org_id', currentOrg.id)
      .order('created_at', { ascending: false })

    if (error) {
      alert(error.message)
      setLoading(false)
      return
    }

    setTemplates((data as ResumeTemplate[]) ?? [])
    setLoading(false)
  }

  const loadExperiences = async (templateId: string) => {
    const { data, error } = await supabase
      .from('resume_template_experiences')
      .select('id, template_id, sort_order, company_name, start_year, end_year, job_location')
      .eq('template_id', templateId)
      .order('sort_order', { ascending: true })

    if (error) {
      alert(error.message)
      return
    }

    const rows = (data as TemplateExperience[]) ?? []
    setExperiences(rows.map((e) => ({ ...e, job_location: e.job_location ?? null })))
  }

  useEffect(() => {
    loadTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id])

  const openNew = () => {
    setSelectedTemplateId(null)
    setForm(emptyForm)
    setExperiences([])
    setMode('edit')
  }

  const openEdit = async (template: ResumeTemplate) => {
    setSelectedTemplateId(template.id)
    setForm({
      name: template.name ?? '',
      candidate_name: template.candidate_name ?? '',
      location: template.location ?? '',
      email: template.email ?? '',
      phone: template.phone ?? '',
      website: template.website ?? '',
      candidate_university: String(template.settings?.candidate_university ?? ''),
      candidate_university_years: String(template.settings?.candidate_university_years ?? ''),
      candidate_university_subject: String(template.settings?.candidate_university_subject ?? ''),
      profile_photo_url: template.profile_photo_url ?? '',
    })
    await loadExperiences(template.id)
    setMode('edit')
  }

  const handlePhotoUpload = async (file: File | Blob, suggestedName = 'candidate-photo.jpg') => {
    if (!currentOrg?.id || !selectedTemplateId) {
      alert('Please save the template first before uploading a photo.')
      return
    }

    setUploadingPhoto(true)
    try {
      const ext = suggestedName.includes('.') ? suggestedName.split('.').pop() : 'jpg'
      const safeName = sanitizeFileName(suggestedName || `photo.${ext}`)
      const path = `${currentOrg.id}/${selectedTemplateId}/candidate-photo-${Date.now()}-${safeName}`
      const contentType = file instanceof File ? file.type || 'image/jpeg' : 'image/jpeg'

      const { error: uploadErr } = await supabase.storage
        .from('resume-template-assets')
        .upload(path, file, { upsert: true, contentType })

      if (uploadErr) throw uploadErr

      const { data } = supabase.storage.from('resume-template-assets').getPublicUrl(path)
      const publicUrl = data.publicUrl

      const { error: updateErr } = await supabase
        .from('resume_templates')
        .update({ profile_photo_url: publicUrl })
        .eq('id', selectedTemplateId)
        .eq('org_id', currentOrg.id)

      if (updateErr) throw updateErr

      setForm((prev) => ({ ...prev, profile_photo_url: publicUrl }))
      await loadTemplates()
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setUploadingPhoto(false)
    }
  }

  const openPhotoCropFromFile = (file: File) => {
    if (!selectedTemplateId) {
      alert('Please save the template first before uploading a photo.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setCropSrc(String(reader.result ?? ''))
      setCropOpen(true)
    }
    reader.readAsDataURL(file)
  }

  const addExperience = () => {
    if (!selectedTemplateId) return
    setExperiences((prev) => [
      ...prev,
      {
        id: `tmp-${Date.now()}-${Math.random()}`,
        template_id: selectedTemplateId,
        sort_order: prev.length,
        company_name: '',
        start_year: '',
        end_year: null,
        job_location: null,
      },
    ])
  }

  const removeExperience = (idx: number) => {
    setExperiences((prev) => prev.filter((_, i) => i !== idx))
  }

  const patchExperience = (idx: number, patch: Partial<TemplateExperience>) => {
    setExperiences((prev) => {
      const copy = [...prev]
      copy[idx] = { ...copy[idx], ...patch }
      return copy
    })
  }

  const handleExperienceDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setExperiences((items) => {
      const oldIndex = items.findIndex((i) => i.id === active.id)
      const newIndex = items.findIndex((i) => i.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return items
      return arrayMove(items, oldIndex, newIndex)
    })
  }

  const saveTemplate = async () => {
    if (!currentOrg?.id) return

    if (!form.name.trim() || !form.candidate_name.trim() || !form.location.trim() || !form.email.trim() || !form.phone.trim()) {
      alert('Please complete all required fields.')
      return
    }

    setSaving(true)
    try {
      const prevSettings =
        selectedTemplateId != null
          ? ((templates.find((t) => t.id === selectedTemplateId)?.settings as Record<string, unknown>) ?? {})
          : {}

      const payload = {
        org_id: currentOrg.id,
        name: form.name.trim(),
        candidate_name: form.candidate_name.trim(),
        location: form.location.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        website: form.website.trim() || null,
        headline: null,
        summary: null,
        linkedin_url: null,
        github_url: null,
        profile_photo_url: form.profile_photo_url.trim() || null,
        settings: {
          ...prevSettings,
          candidate_university: form.candidate_university.trim() || null,
          candidate_university_years: form.candidate_university_years.trim() || null,
          candidate_university_subject: form.candidate_university_subject.trim() || null,
        },
      }

      let templateId = selectedTemplateId

      if (templateId) {
        const { error } = await supabase
          .from('resume_templates')
          .update(payload)
          .eq('id', templateId)
          .eq('org_id', currentOrg.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase
          .from('resume_templates')
          .insert(payload)
          .select('id')
          .single()
        if (error) throw error
        templateId = data?.id ?? null
        setSelectedTemplateId(templateId)
      }

      if (!templateId) throw new Error('Template save failed (missing template id).')

      await saveResumeTemplateExperiencesViaRpc(templateId, experiences)

      await loadTemplates()
      setMode('list')
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const deleteTemplate = async (templateId: string) => {
    if (!currentOrg?.id || !confirm('Delete this template?')) return

    const { error } = await supabase
      .from('resume_templates')
      .delete()
      .eq('id', templateId)
      .eq('org_id', currentOrg.id)

    if (error) {
      alert(error.message)
      return
    }

    if (selectedTemplateId === templateId) {
      setSelectedTemplateId(null)
      setMode('list')
      setForm(emptyForm)
      setExperiences([])
    }

    await loadTemplates()
  }

  return (
    <div className={`${embeddedInAdmin ? '' : 'p-4 md:p-6 max-w-6xl'}`} data-testid="resume-templates-page">
      {!embeddedInAdmin && (
        <Link to="/admin" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-4">
          <ArrowLeft className="w-4 h-4" /> Admin
        </Link>
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Resume Templates</h1>
          <p className="text-sm text-gray-400">Manage templates used in Lead Wizard Step 3.</p>
        </div>
        {mode === 'list' && (
          <button onClick={openNew} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-foreground">
            <Plus className="w-4 h-4" /> Add template
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading templates…</p>
      ) : mode === 'list' ? (
        <div className="space-y-3">
          {templates.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface-elevated p-6 text-center">
              <p className="text-white font-medium">No resume templates yet</p>
              <p className="text-sm text-gray-400 mt-1">Create your first template to power AI resume generation.</p>
              <button onClick={openNew} className="mt-4 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-foreground">
                <Plus className="w-4 h-4" /> Add template
              </button>
            </div>
          ) : (
            templates.map((template) => (
              <div key={template.id} className="rounded-lg border border-border bg-surface-elevated p-4 flex items-start justify-between gap-4">
                <div>
                  <p className="text-white font-medium">{template.name}</p>
                  <p className="text-sm text-gray-400">{template.candidate_name} • {template.location ?? 'No location set'}</p>
                  <p className="text-xs text-gray-500 mt-1">{template.email ?? 'No email'} • {template.phone ?? 'No phone'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => openEdit(template)} className="px-3 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted text-sm">
                    Edit
                  </button>
                  <button onClick={() => deleteTemplate(template.id)} className="px-3 py-2 rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm inline-flex items-center gap-1">
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-elevated p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-300 font-medium">{selectedTemplateId ? 'Edit template' : 'New template'}</p>
            <button onClick={() => setMode('list')} className="text-sm text-gray-400 hover:text-gray-200">Back to list</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Template Name *</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Candidate Name *</label>
              <input value={form.candidate_name} onChange={(e) => setForm({ ...form, candidate_name: e.target.value })} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Candidate Location *</label>
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Candidate Email *</label>
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Candidate Phone Number *</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Candidate Website (optional)</label>
              <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white" />
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-sm text-gray-200 font-medium">Education (optional)</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-400 mb-1">University / school name</label>
                <input
                  value={form.candidate_university}
                  onChange={(e) => setForm({ ...form, candidate_university: e.target.value })}
                  placeholder="e.g. University of South Carolina"
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Subject / degree</label>
                <input
                  value={form.candidate_university_subject}
                  onChange={(e) => setForm({ ...form, candidate_university_subject: e.target.value })}
                  placeholder="e.g. B.S. Computer Science"
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Year(s)</label>
                <input
                  value={form.candidate_university_years}
                  onChange={(e) => setForm({ ...form, candidate_university_years: e.target.value })}
                  placeholder="e.g. 2014 – 2018"
                  className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-white"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border p-3 bg-surface-muted/20 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-200 font-medium">Candidate photo (optional)</p>
              <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-border text-sm text-gray-200 hover:bg-surface-muted cursor-pointer">
                <Upload className="w-4 h-4" />
                {uploadingPhoto ? 'Uploading…' : 'Upload photo'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  disabled={uploadingPhoto || !selectedTemplateId}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) openPhotoCropFromFile(file)
                    e.currentTarget.value = ''
                  }}
                />
              </label>
            </div>
            {!selectedTemplateId && <p className="text-xs text-gray-500">Save template first, then upload candidate photo.</p>}
            {form.profile_photo_url ? (
              <img src={form.profile_photo_url} alt="Candidate" className="h-28 w-28 object-cover rounded border border-border aspect-square" />
            ) : (
              <p className="text-xs text-gray-500">No photo uploaded yet.</p>
            )}
            <p className="text-xs text-gray-500">Photos are cropped to a square before upload.</p>
          </div>

          <PhotoCropModal
            imageSrc={cropSrc ?? ''}
            open={cropOpen && !!cropSrc}
            onClose={() => {
              setCropOpen(false)
              setCropSrc(null)
            }}
            onCropped={(blob) => handlePhotoUpload(blob, 'candidate-photo.jpg')}
          />

          {selectedTemplateId && (
            <div className="rounded-lg border border-border p-3 bg-surface-muted/20 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-200 font-medium">Featured job history</p>
                <button type="button" onClick={addExperience} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                  <Plus className="w-3 h-3" /> Add job
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Company, location, and dates are saved here. Job titles and bullets are generated from the lead&apos;s job description. Drag the handle to reorder how jobs appear on the resume.
              </p>

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleExperienceDragEnd}>
                <SortableContext items={experiences.map((e) => e.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {experiences.length === 0 && <p className="text-xs text-gray-500">No jobs added yet.</p>}
                    {experiences.map((exp, idx) => (
                      <SortableExperienceRow
                        key={exp.id}
                        exp={exp}
                        index={idx}
                        onPatch={patchExperience}
                        onRemove={removeExperience}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {!selectedTemplateId && (
            <p className="text-xs text-gray-500">Save template first, then add featured job history entries.</p>
          )}

          <div className="flex justify-end">
            <button disabled={saving} onClick={saveTemplate} className="px-4 py-2 rounded-lg bg-accent text-accent-foreground disabled:opacity-50">
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
