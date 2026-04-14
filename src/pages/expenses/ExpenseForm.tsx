import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Upload } from 'lucide-react'

type ProjectOption = { id: string; name: string }

const CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'travel', label: 'Travel' },
  { value: 'software', label: 'Software' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'subcontractor', label: 'Subcontractor' },
  { value: 'office', label: 'Office' },
  { value: 'other', label: 'Other' },
]

type ExpenseFormData = {
  name: string
  category: string
  amount: string
  expense_date: string
  project_id: string
  billable: boolean
  payment_method: string
  note: string
}

const EMPTY_FORM: ExpenseFormData = {
  name: '',
  category: 'general',
  amount: '',
  expense_date: new Date().toISOString().split('T')[0],
  project_id: '',
  billable: false,
  payment_method: '',
  note: '',
}

export default function ExpenseForm() {
  const { id } = useParams<{ id: string }>()
  const isEdit = Boolean(id)
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [form, setForm] = useState<ExpenseFormData>(EMPTY_FORM)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [existingReceipt, setExistingReceipt] = useState<string | null>(null)

  // Load projects for dropdown
  useEffect(() => {
    if (!currentOrg?.id) return
    supabase
      .from('projects')
      .select('id, name')
      .eq('org_id', currentOrg.id)
      .order('name')
      .then(({ data }) => setProjects((data as ProjectOption[]) ?? []))
  }, [currentOrg?.id])

  // Load existing expense for editing
  useEffect(() => {
    if (!id || !currentOrg?.id) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      const { data, error: fetchError } = await supabase
        .from('expenses')
        .select('*')
        .eq('id', id)
        .eq('org_id', currentOrg.id)
        .single()

      if (cancelled) return

      if (fetchError || !data) {
        setError('Expense not found.')
        setLoading(false)
        return
      }

      setForm({
        name: data.name ?? '',
        category: data.category ?? 'general',
        amount: data.amount ? (data.amount / 100).toFixed(2) : '',
        expense_date: data.expense_date ?? '',
        project_id: data.project_id ?? '',
        billable: data.billable ?? false,
        payment_method: data.payment_method ?? '',
        note: data.note ?? '',
      })
      setExistingReceipt(data.receipt_path ?? null)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id, currentOrg?.id])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target
    if (type === 'checkbox') {
      setForm((prev) => ({ ...prev, [name]: (e.target as HTMLInputElement).checked }))
    } else {
      setForm((prev) => ({ ...prev, [name]: value }))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !user?.id) return

    setError(null)
    setSaving(true)

    try {
      // Parse amount to cents
      const amountCents = Math.round(parseFloat(form.amount || '0') * 100)
      if (isNaN(amountCents) || amountCents < 0) {
        setError('Please enter a valid amount.')
        setSaving(false)
        return
      }

      // Upload receipt if provided
      let receiptPath = existingReceipt
      if (receiptFile) {
        const ext = receiptFile.name.split('.').pop()
        const path = `${currentOrg.id}/receipts/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('expense-receipts')
          .upload(path, receiptFile, { upsert: false })
        if (uploadError) {
          console.warn('Receipt upload failed:', uploadError.message)
          // Don't block save — receipt is optional
        } else {
          receiptPath = path
        }
      }

      const payload = {
        org_id: currentOrg.id,
        name: form.name.trim(),
        category: form.category,
        amount: amountCents,
        expense_date: form.expense_date || null,
        project_id: form.project_id || null,
        billable: form.billable,
        payment_method: form.payment_method.trim() || null,
        note: form.note.trim() || null,
        receipt_path: receiptPath,
        ...(isEdit ? {} : { created_by: user.id }),
      }

      if (isEdit && id) {
        const { error: updateError } = await supabase
          .from('expenses')
          .update(payload)
          .eq('id', id)
          .eq('org_id', currentOrg.id)
        if (updateError) throw updateError
      } else {
        const { error: insertError } = await supabase
          .from('expenses')
          .insert(payload)
        if (insertError) throw insertError
      }

      navigate('/expenses')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save expense.'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const inputClasses = 'w-full rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent'
  const labelClasses = 'block text-sm font-medium text-gray-300 mb-1.5'

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="text-surface-muted text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl" data-testid="expense-form-page">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={() => navigate('/expenses')}
          className="p-2 rounded-lg hover:bg-surface-muted transition-colors"
          aria-label="Back to expenses"
        >
          <ArrowLeft className="w-5 h-5 text-gray-400" />
        </button>
        <h1 className="text-xl font-semibold text-white">
          {isEdit ? 'Edit Expense' : 'New Expense'}
        </h1>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name */}
        <div>
          <label htmlFor="name" className={labelClasses}>Name *</label>
          <input
            id="name"
            name="name"
            type="text"
            required
            value={form.name}
            onChange={handleChange}
            placeholder="e.g. Flight to NYC"
            className={inputClasses}
            data-testid="expense-name"
          />
        </div>

        {/* Category + Amount row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="category" className={labelClasses}>Category</label>
            <select
              id="category"
              name="category"
              value={form.category}
              onChange={handleChange}
              className={inputClasses}
              data-testid="expense-category"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="amount" className={labelClasses}>Amount *</label>
            <input
              id="amount"
              name="amount"
              type="number"
              step="0.01"
              min="0"
              required
              value={form.amount}
              onChange={handleChange}
              placeholder="0.00"
              className={inputClasses}
              data-testid="expense-amount"
            />
          </div>
        </div>

        {/* Date + Project row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="expense_date" className={labelClasses}>Date</label>
            <input
              id="expense_date"
              name="expense_date"
              type="date"
              value={form.expense_date}
              onChange={handleChange}
              className={inputClasses}
              data-testid="expense-date"
            />
          </div>
          <div>
            <label htmlFor="project_id" className={labelClasses}>Project</label>
            <select
              id="project_id"
              name="project_id"
              value={form.project_id}
              onChange={handleChange}
              className={inputClasses}
              data-testid="expense-project"
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Billable + Payment method row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
          <div>
            <label htmlFor="payment_method" className={labelClasses}>Payment Method</label>
            <input
              id="payment_method"
              name="payment_method"
              type="text"
              value={form.payment_method}
              onChange={handleChange}
              placeholder="e.g. Credit card, Bank transfer"
              className={inputClasses}
              data-testid="expense-payment-method"
            />
          </div>
          <div className="flex items-center gap-3 pb-1">
            <input
              id="billable"
              name="billable"
              type="checkbox"
              checked={form.billable}
              onChange={handleChange}
              className="w-4 h-4 rounded border-border bg-surface-muted text-accent focus:ring-accent"
              data-testid="expense-billable"
            />
            <label htmlFor="billable" className="text-sm text-gray-300">
              Billable to client
            </label>
          </div>
        </div>

        {/* Receipt upload */}
        <div>
          <label className={labelClasses}>Receipt</label>
          <div className="flex items-center gap-3">
            <label
              htmlFor="receipt"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-surface-muted text-sm text-gray-300 hover:bg-surface-muted/80 cursor-pointer transition-colors"
            >
              <Upload className="w-4 h-4" />
              {receiptFile ? receiptFile.name : 'Upload receipt'}
            </label>
            <input
              id="receipt"
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
              data-testid="expense-receipt"
            />
            {existingReceipt && !receiptFile && (
              <span className="text-xs text-gray-500">Existing receipt attached</span>
            )}
          </div>
        </div>

        {/* Note */}
        <div>
          <label htmlFor="note" className={labelClasses}>Note</label>
          <textarea
            id="note"
            name="note"
            rows={3}
            value={form.note}
            onChange={handleChange}
            placeholder="Optional notes…"
            className={inputClasses}
            data-testid="expense-note"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 disabled:opacity-50"
            data-testid="expense-save"
          >
            {saving ? 'Saving…' : isEdit ? 'Update Expense' : 'Create Expense'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/expenses')}
            className="px-4 py-2.5 rounded-lg border border-border text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-muted transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
