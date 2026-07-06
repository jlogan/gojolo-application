import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'

type Vendor = { user_id: string; profiles: { display_name: string | null; email: string | null } | null }
type Project = { id: string; name: string }
type VendorProfile = { id: string; vendor_user_id: string; default_billing_type: 'hourly' | 'fixed'; default_hourly_rate: number | null; default_fixed_amount: number | null; effective_from: string; effective_to: string | null; notes: string | null }
type ProjectProfile = { id: string; vendor_user_id: string; project_id: string; billing_type: 'hourly' | 'fixed'; hourly_rate: number | null; fixed_amount: number | null; effective_from: string; effective_to: string | null; notes: string | null }

function profileName(row: Vendor['profiles']) {
  return row?.display_name || row?.email || 'Vendor'
}
function today() { return new Date().toISOString().split('T')[0] }

export default function VendorBillingSettings() {
  const { currentOrg, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [profiles, setProfiles] = useState<VendorProfile[]>([])
  const [projectProfiles, setProjectProfiles] = useState<ProjectProfile[]>([])
  const [vendorId, setVendorId] = useState('')
  const [billingType, setBillingType] = useState<'hourly' | 'fixed'>('hourly')
  const [hourlyRate, setHourlyRate] = useState('')
  const [fixedAmount, setFixedAmount] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(today())
  const [notes, setNotes] = useState('')
  const [overrideProjectId, setOverrideProjectId] = useState('')
  const [overrideType, setOverrideType] = useState<'hourly' | 'fixed'>('hourly')
  const [overrideHourlyRate, setOverrideHourlyRate] = useState('')
  const [overrideFixedAmount, setOverrideFixedAmount] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!currentOrg?.id) return
    setLoading(true)
    const [vendorResult, projectResult, profileResult, projectProfileResult] = await Promise.all([
      supabase
        .from('organization_users')
        .select('user_id')
        .eq('org_id', currentOrg.id)
        .order('user_id'),
      supabase.from('projects').select('id, name').eq('org_id', currentOrg.id).order('name'),
      supabase.from('vendor_billing_profiles').select('*').eq('org_id', currentOrg.id).order('effective_from', { ascending: false }),
      supabase.from('vendor_project_billing_profiles').select('*').eq('org_id', currentOrg.id).order('effective_from', { ascending: false }),
    ])
    const firstError = vendorResult.error || projectResult.error || profileResult.error || projectProfileResult.error
    if (firstError) setMessage(firstError.message)

    const vendorUserIds = ((vendorResult.data ?? []) as { user_id: string }[]).map((row) => row.user_id)
    let vendorProfileMap = new Map<string, { display_name: string | null; email: string | null }>()
    if (vendorUserIds.length > 0) {
      const { data: profileRows, error: vendorProfileError } = await supabase
        .from('profiles')
        .select('id, display_name, email')
        .in('id', vendorUserIds)
      if (vendorProfileError) setMessage(vendorProfileError.message)
      vendorProfileMap = new Map((profileRows ?? []).map((profile) => [profile.id, { display_name: profile.display_name, email: profile.email }]))
    }

    setVendors(((vendorResult.data ?? []) as { user_id: string }[]).map((row) => ({
      user_id: row.user_id,
      profiles: vendorProfileMap.get(row.user_id) ?? null,
    })).sort((a, b) => profileName(a.profiles).localeCompare(profileName(b.profiles))))
    setProjects((projectResult.data ?? []) as Project[])
    setProfiles((profileResult.data ?? []) as VendorProfile[])
    setProjectProfiles((projectProfileResult.data ?? []) as ProjectProfile[])
    setLoading(false)
  }

  useEffect(() => { load() }, [currentOrg?.id])

  const activeProfileVendorIds = useMemo(() => new Set(profiles.filter((p) => !p.effective_to).map((p) => p.vendor_user_id)), [profiles])
  const billableVendors = useMemo(() => vendors.filter((vendor) => activeProfileVendorIds.has(vendor.user_id)), [vendors, activeProfileVendorIds])
  const addableUsers = useMemo(() => vendors.filter((vendor) => !activeProfileVendorIds.has(vendor.user_id)), [vendors, activeProfileVendorIds])
  const selectedVendor = useMemo(() => vendors.find((vendor) => vendor.user_id === vendorId) ?? null, [vendors, vendorId])
  const selectedProfile = useMemo(() => profiles.find((p) => p.vendor_user_id === vendorId && !p.effective_to), [profiles, vendorId])
  const vendorOverrides = useMemo(() => projectProfiles.filter((p) => p.vendor_user_id === vendorId && !p.effective_to), [projectProfiles, vendorId])

  useEffect(() => {
    setOverrideProjectId('')
    setOverrideType('hourly')
    setOverrideHourlyRate('')
    setOverrideFixedAmount('')

    if (!vendorId || !selectedProfile) {
      setBillingType('hourly')
      setHourlyRate('')
      setFixedAmount('')
      setEffectiveFrom(today())
      setNotes('')
      return
    }

    setBillingType(selectedProfile.default_billing_type)
    setHourlyRate(selectedProfile.default_hourly_rate?.toString() ?? '')
    setFixedAmount(selectedProfile.default_fixed_amount?.toString() ?? '')
    setEffectiveFrom(today())
    setNotes(selectedProfile.notes ?? '')
  }, [vendorId, selectedProfile?.id])

  const saveDefault = async (e: FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !vendorId || !user?.id) return
    if (billingType === 'hourly' && !hourlyRate) return setMessage('Hourly vendors need an hourly rate.')
    if (billingType === 'fixed' && !fixedAmount) return setMessage('Fixed vendors need a weekly fixed amount.')
    setSaving(true)
    setMessage(null)
    if (selectedProfile) {
      await supabase.from('vendor_billing_profiles').update({ effective_to: effectiveFrom }).eq('id', selectedProfile.id)
    }
    const { error } = await supabase.from('vendor_billing_profiles').insert({
      org_id: currentOrg.id,
      vendor_user_id: vendorId,
      default_billing_type: billingType,
      default_hourly_rate: billingType === 'hourly' ? Number(hourlyRate) : null,
      default_fixed_amount: billingType === 'fixed' ? Number(fixedAmount) : null,
      effective_from: effectiveFrom,
      notes: notes.trim() || null,
      created_by: user.id,
    })
    setSaving(false)
    if (error) setMessage(error.message)
    else {
      setMessage('Vendor billing profile saved.')
      await load()
    }
  }

  const saveOverride = async (e: FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !vendorId || !overrideProjectId || !user?.id) return
    if (overrideType === 'hourly' && !overrideHourlyRate) return setMessage('Hourly overrides need a rate.')
    if (overrideType === 'fixed' && !overrideFixedAmount) return setMessage('Fixed overrides need a weekly amount.')
    setSaving(true)
    setMessage(null)
    const existing = projectProfiles.find((p) => p.vendor_user_id === vendorId && p.project_id === overrideProjectId && !p.effective_to)
    if (existing) await supabase.from('vendor_project_billing_profiles').update({ effective_to: today() }).eq('id', existing.id)
    const { error } = await supabase.from('vendor_project_billing_profiles').insert({
      org_id: currentOrg.id,
      vendor_user_id: vendorId,
      project_id: overrideProjectId,
      billing_type: overrideType,
      hourly_rate: overrideType === 'hourly' ? Number(overrideHourlyRate) : null,
      fixed_amount: overrideType === 'fixed' ? Number(overrideFixedAmount) : null,
      effective_from: today(),
      created_by: user.id,
    })
    setSaving(false)
    if (error) setMessage(error.message)
    else {
      setMessage('Project override saved.')
      setOverrideProjectId(''); setOverrideHourlyRate(''); setOverrideFixedAmount('')
      await load()
    }
  }

  if (!isOrgAdmin) return <div className="p-6 text-gray-300">Only admins can manage vendor billing.</div>

  return (
    <div className="p-4 md:p-6 max-w-5xl" data-testid="vendor-billing-settings">
      <h1 className="text-xl font-semibold text-white mb-1">Vendor Billing Setup</h1>
      <p className="text-sm text-gray-400 mb-5">Set billable team members/vendors as hourly or fixed weekly. This does not change their GoJolo role; admins can also be configured for vendor bills. Project overrides win over the default and changes are effective-dated for historical bills.</p>
      {message && <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">{message}</div>}

      <div className="rounded-lg border border-border bg-surface-elevated p-4 mb-4 space-y-4">
        <div>
          <h2 className="font-medium text-white">Step 1: Choose who should receive bills</h2>
          <p className="text-xs text-gray-500 mt-1">Only users added here will have bill profiles and be included in vendor bill generation. This is separate from their GoJolo role.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Billable vendors</label>
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white">
              <option value="">Select billable vendor...</option>
              {billableVendors.map((vendor) => <option key={vendor.user_id} value={vendor.user_id}>{profileName(vendor.profiles)}</option>)}
              {selectedVendor && !activeProfileVendorIds.has(selectedVendor.user_id) && <option value={selectedVendor.user_id}>{profileName(selectedVendor.profiles)} (new)</option>}
            </select>
            {!loading && billableVendors.length === 0 && (
              <p className="text-xs text-amber-300 mt-2">No billable vendors added yet. Choose a user on the right to start their billing profile.</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Add user to billable vendors</label>
            <select value="" onChange={(e) => e.target.value && setVendorId(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white">
              <option value="">Choose an org user...</option>
              {addableUsers.map((vendor) => <option key={vendor.user_id} value={vendor.user_id}>{profileName(vendor.profiles)}</option>)}
            </select>
            {!loading && vendors.length === 0 && (
              <p className="text-xs text-amber-300 mt-2">No organization users found. Add the person to the org first, then return here.</p>
            )}
          </div>
        </div>
        {loading && <p className="text-xs text-gray-500">Loading...</p>}
      </div>

      {vendorId && (
        <div className="grid gap-4 lg:grid-cols-2">
          <form onSubmit={saveDefault} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
            <h2 className="font-medium text-white">Step 2: Set billing profile{selectedVendor ? ` for ${profileName(selectedVendor.profiles)}` : ''}</h2>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setBillingType('hourly')} className={`rounded-lg border px-3 py-2 text-sm ${billingType === 'hourly' ? 'border-accent text-white bg-accent/20' : 'border-border text-gray-400'}`}>Hourly</button>
              <button type="button" onClick={() => setBillingType('fixed')} className={`rounded-lg border px-3 py-2 text-sm ${billingType === 'fixed' ? 'border-accent text-white bg-accent/20' : 'border-border text-gray-400'}`}>Fixed weekly</button>
            </div>
            {billingType === 'hourly' ? (
              <div><label className="block text-xs text-gray-500 mb-1">Hourly rate</label><input value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} type="number" step="0.01" min="0" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white" /></div>
            ) : (
              <div><label className="block text-xs text-gray-500 mb-1">Weekly fixed amount</label><input value={fixedAmount} onChange={(e) => setFixedAmount(e.target.value)} type="number" step="0.01" min="0" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white" /></div>
            )}
            <div><label className="block text-xs text-gray-500 mb-1">Effective from</label><input value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} type="date" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Notes</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white" rows={3} /></div>
            <button disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">Save default</button>
          </form>

          <form onSubmit={saveOverride} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
            <h2 className="font-medium text-white">Project override</h2>
            <div><label className="block text-xs text-gray-500 mb-1">Project</label><select value={overrideProjectId} onChange={(e) => setOverrideProjectId(e.target.value)} className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white"><option value="">Select project...</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setOverrideType('hourly')} className={`rounded-lg border px-3 py-2 text-sm ${overrideType === 'hourly' ? 'border-accent text-white bg-accent/20' : 'border-border text-gray-400'}`}>Hourly</button>
              <button type="button" onClick={() => setOverrideType('fixed')} className={`rounded-lg border px-3 py-2 text-sm ${overrideType === 'fixed' ? 'border-accent text-white bg-accent/20' : 'border-border text-gray-400'}`}>Fixed weekly</button>
            </div>
            {overrideType === 'hourly' ? <div><label className="block text-xs text-gray-500 mb-1">Override hourly rate</label><input value={overrideHourlyRate} onChange={(e) => setOverrideHourlyRate(e.target.value)} type="number" step="0.01" min="0" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white" /></div> : <div><label className="block text-xs text-gray-500 mb-1">Override weekly amount</label><input value={overrideFixedAmount} onChange={(e) => setOverrideFixedAmount(e.target.value)} type="number" step="0.01" min="0" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-white" /></div>}
            <button disabled={saving || !overrideProjectId} className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">Save override</button>
          </form>
        </div>
      )}

      {vendorId && vendorOverrides.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-surface-elevated overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted/70 text-xs uppercase text-gray-500"><tr><th className="px-4 py-3 text-left">Project</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-right">Rate / Amount</th></tr></thead>
            <tbody className="divide-y divide-border">{vendorOverrides.map((o) => <tr key={o.id}><td className="px-4 py-3 text-gray-200">{projects.find((p) => p.id === o.project_id)?.name ?? 'Project'}</td><td className="px-4 py-3 text-gray-300">{o.billing_type}</td><td className="px-4 py-3 text-right text-white">${Number(o.billing_type === 'hourly' ? o.hourly_rate : o.fixed_amount).toFixed(2)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
