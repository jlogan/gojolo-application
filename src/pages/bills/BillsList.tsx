import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, Search, Settings } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'

type BillRow = {
  id: string
  number: number | null
  prefix: string | null
  status: string
  issue_date: string | null
  paid_date: string | null
  total: number | null
  amount_due: number | null
  billing_period_start: string | null
  billing_period_end: string | null
  billing_source: string | null
  created_at: string
  vendor_user_id: string | null
  projects: { name: string } | { name: string }[] | null
}

type ProfileRow = { id: string; display_name: string | null; email: string | null }
type StatusFilter = 'all' | 'draft' | 'approved' | 'paid' | 'cancelled'

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'approved', label: 'Unpaid' },
  { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' },
]

const STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  approved: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  paid: 'bg-green-500/20 text-green-300 border-green-500/30',
  cancelled: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
}

function formatCurrency(amount: number | null | undefined) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(amount ?? 0))
}

function formatDate(date: string | null | undefined) {
  if (!date) return '-'
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function billNumber(bill: BillRow) {
  const prefix = (bill.prefix ?? 'BILL-').replace(/-+$/, '')
  return bill.number ? `${prefix}-${String(bill.number).padStart(4, '0')}` : '-'
}

function projectName(projects: BillRow['projects']) {
  if (!projects) return '-'
  return Array.isArray(projects) ? projects[0]?.name ?? '-' : projects.name
}

export default function BillsList() {
  const { currentOrg, isVendor, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [bills, setBills] = useState<BillRow[]>([])
  const [profiles, setProfiles] = useState<Record<string, ProfileRow>>({})
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!currentOrg?.id || !user?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      let query = supabase
        .from('invoices')
        .select('id, number, prefix, status, issue_date, paid_date, total, amount_due, billing_period_start, billing_period_end, billing_source, created_at, vendor_user_id, projects(name)')
        .eq('org_id', currentOrg.id)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false })

      if (isVendor) query = query.eq('vendor_user_id', user.id)
      if (status !== 'all') query = query.eq('status', status)

      const { data, error } = await query
      if (cancelled) return
      if (error) {
        setBills([])
        setProfiles({})
        setLoading(false)
        return
      }

      const rows = (data ?? []) as unknown as BillRow[]
      setBills(rows)
      const vendorIds = [...new Set(rows.map((b) => b.vendor_user_id).filter(Boolean))] as string[]
      if (vendorIds.length) {
        const { data: profileRows } = await supabase.from('profiles').select('id, display_name, email').in('id', vendorIds)
        if (!cancelled) {
          setProfiles(Object.fromEntries(((profileRows ?? []) as ProfileRow[]).map((p) => [p.id, p])))
        }
      } else {
        setProfiles({})
      }
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [currentOrg?.id, user?.id, isVendor, status])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return bills
    return bills.filter((bill) => {
      const vendor = bill.vendor_user_id ? profiles[bill.vendor_user_id] : null
      return [billNumber(bill), projectName(bill.projects), vendor?.display_name, vendor?.email, bill.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    })
  }, [bills, profiles, search])

  return (
    <div className="p-4 md:p-6" data-testid="bills-page">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-white">Bills</h1>
          <p className="text-sm text-gray-400">Vendor bills generated every Monday at 6:00 AM Eastern for the previous Monday-Sunday week.</p>
        </div>
        {isOrgAdmin && (
          <Link to="/admin/vendor-billing" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-gray-200 hover:bg-surface-muted">
            <Settings className="w-4 h-4" /> Vendor billing setup
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 mb-4 border-b border-border pb-3">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatus(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              status === f.id
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search vendor, project, bill number..."
          className="w-full rounded-lg border border-border bg-surface-muted pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="rounded-lg border border-border overflow-hidden bg-surface-elevated">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading bills...</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-gray-400">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-60" />
            <p className="text-white font-medium">No bills yet</p>
            <p className="text-sm mt-1">Bills will appear after the Monday morning vendor billing run.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted/70 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Bill</th>
                  <th className="px-4 py-3 text-left">Vendor</th>
                  <th className="px-4 py-3 text-left">Project</th>
                  <th className="px-4 py-3 text-left">Period</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((bill) => {
                  const vendor = bill.vendor_user_id ? profiles[bill.vendor_user_id] : null
                  return (
                    <tr key={bill.id} className="hover:bg-surface-muted/40">
                      <td className="px-4 py-3"><Link to={`/bills/${bill.id}`} className="text-accent hover:underline font-medium">{billNumber(bill)}</Link></td>
                      <td className="px-4 py-3 text-gray-200">{vendor?.display_name || vendor?.email || 'Vendor'}</td>
                      <td className="px-4 py-3 text-gray-300">{projectName(bill.projects)}</td>
                      <td className="px-4 py-3 text-gray-400">{formatDate(bill.billing_period_start)} - {formatDate(bill.billing_period_end)}</td>
                      <td className="px-4 py-3"><span className={`inline-flex px-2 py-0.5 rounded-full border text-xs ${STATUS_CLASSES[bill.status] ?? STATUS_CLASSES.draft}`}>{bill.status}</span></td>
                      <td className="px-4 py-3 text-right text-white font-medium">{formatCurrency(bill.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
