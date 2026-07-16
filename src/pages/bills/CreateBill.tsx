import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'

type OrgUser = { user_id: string; profiles: { display_name: string | null; email: string | null } | null }
type Project = { id: string; name: string }

function profileName(row: OrgUser['profiles']) {
  return row?.display_name || row?.email || 'User'
}

function today() {
  return new Date().toISOString().split('T')[0]
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

export default function CreateBill() {
  const { currentOrg, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [users, setUsers] = useState<OrgUser[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [currencyId, setCurrencyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [vendorUserId, setVendorUserId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [issueDate, setIssueDate] = useState(today())
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [notes, setNotes] = useState('')

  const lineTotal = useMemo(() => {
    const qty = parseFloat(quantity) || 0
    const rate = parseFloat(unitPrice) || 0
    return roundMoney(qty * rate)
  }, [quantity, unitPrice])

  useEffect(() => {
    if (!currentOrg?.id) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      const [userResult, projectResult, currencyResult] = await Promise.all([
        supabase.from('organization_users').select('user_id').eq('org_id', currentOrg.id).order('user_id'),
        supabase.from('projects').select('id, name').eq('org_id', currentOrg.id).order('name'),
        supabase.from('currencies').select('id').eq('org_id', currentOrg.id).eq('is_default', true).maybeSingle(),
      ])

      if (cancelled) return

      const userIds = ((userResult.data ?? []) as { user_id: string }[]).map((row) => row.user_id)
      let profileMap = new Map<string, { display_name: string | null; email: string | null }>()
      if (userIds.length > 0) {
        const { data: profileRows } = await supabase
          .from('profiles')
          .select('id, display_name, email')
          .in('id', userIds)
        profileMap = new Map((profileRows ?? []).map((profile) => [profile.id, { display_name: profile.display_name, email: profile.email }]))
      }

      setUsers(
        userIds
          .map((userId) => ({
            user_id: userId,
            profiles: profileMap.get(userId) ?? null,
          }))
          .sort((a, b) => profileName(a.profiles).localeCompare(profileName(b.profiles))),
      )
      setProjects((projectResult.data ?? []) as Project[])
      setCurrencyId((currencyResult.data as { id: string } | null)?.id ?? null)
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [currentOrg?.id])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !user?.id) return

    if (!vendorUserId) {
      setError('Select a vendor.')
      return
    }
    if (!description.trim()) {
      setError('Enter a line item description.')
      return
    }
    if (!periodStart || !periodEnd) {
      setError('Enter the billing period start and end dates.')
      return
    }
    const qty = parseFloat(quantity)
    const rate = parseFloat(unitPrice)
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter a valid quantity.')
      return
    }
    if (!Number.isFinite(rate) || rate < 0) {
      setError('Enter a valid unit price.')
      return
    }

    setError(null)
    setSaving(true)

    try {
      const subtotal = roundMoney(qty * rate)
      const { data: nextNum, error: numErr } = await supabase.rpc('next_invoice_number', {
        p_org_id: currentOrg.id,
        p_direction: 'inbound',
      })
      if (numErr || nextNum == null) {
        setError(numErr?.message ?? 'Failed to get next bill number.')
        setSaving(false)
        return
      }

      const { data: insertedBill, error: insertErr } = await supabase
        .from('invoices')
        .insert({
          org_id: currentOrg.id,
          direction: 'inbound',
          number: nextNum,
          prefix: 'BILL-',
          status: 'draft',
          vendor_user_id: vendorUserId,
          project_id: projectId || null,
          issue_date: issueDate,
          currency_id: currencyId,
          subtotal,
          tax_total: 0,
          discount_type: 'percent',
          discount_value: 0,
          discount_total: 0,
          adjustment: 0,
          total: subtotal,
          amount_paid: 0,
          amount_due: subtotal,
          billing_period_start: periodStart,
          billing_period_end: periodEnd,
          billing_source: 'manual',
          notes: notes.trim() || null,
          created_by: user.id,
        })
        .select('id')
        .single()

      if (insertErr || !insertedBill) {
        setError(insertErr?.message ?? 'Failed to create bill.')
        setSaving(false)
        return
      }

      const billId = (insertedBill as { id: string }).id
      const { error: itemsErr } = await supabase.from('invoice_items').insert({
        invoice_id: billId,
        description: description.trim(),
        long_description: null,
        quantity: qty,
        unit_price: rate,
        unit: null,
        tax_amount: 0,
        subtotal,
        total: subtotal,
        sort_order: 0,
        time_log_ids: [],
      })

      if (itemsErr) {
        setError(itemsErr.message)
        setSaving(false)
        return
      }

      navigate(`/bills/${billId}`)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  if (!isOrgAdmin) {
    return <div className="p-6 text-gray-300">Only admins can create bills.</div>
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto" data-testid="create-bill-page">
      <Link to="/bills" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to bills
      </Link>

      <h1 className="text-xl font-semibold text-white mb-1">Create bill</h1>
      <p className="text-sm text-gray-400 mb-5">Create a manual vendor bill as a draft.</p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-surface-elevated p-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Vendor</label>
            <select
              value={vendorUserId}
              onChange={(e) => setVendorUserId(e.target.value)}
              required
              disabled={loading || saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            >
              <option value="">Select vendor...</option>
              {users.map((orgUser) => (
                <option key={orgUser.user_id} value={orgUser.user_id}>
                  {profileName(orgUser.profiles)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Project (optional)</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={loading || saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Issue date</label>
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
              disabled={saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Billing period start</label>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              required
              disabled={saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Billing period end</label>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              required
              disabled={saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            disabled={saving}
            placeholder="Line item description"
            className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500"
          />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Quantity</label>
            <input
              type="number"
              min="0"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              disabled={saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Unit price</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              required
              disabled={saving}
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Amount</label>
            <div className="w-full rounded-lg border border-border bg-surface-muted/60 px-3 py-2 text-sm text-white">
              {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(lineTotal)}
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            disabled={saving}
            className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white placeholder-gray-500"
            placeholder="Optional notes for this bill"
          />
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="submit"
            disabled={saving || loading}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create bill'}
          </button>
          <Link to="/bills" className="px-4 py-2 rounded-lg border border-border text-sm text-gray-300 hover:text-white">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
