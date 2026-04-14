import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { Plus, FileText, Search } from 'lucide-react'

type InvoiceRow = {
  id: string
  direction: 'outbound' | 'inbound'
  number: string | null
  prefix: string | null
  status: string
  issue_date: string | null
  due_date: string | null
  total: number
  amount_due: number
  currency_id: string | null
  created_at: string
  companies: { name: string } | { name: string }[] | null
  projects: { name: string } | { name: string }[] | null
}

type InvoiceStatus = 'all' | 'draft' | 'sent' | 'unpaid' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'

type DirectionTab = 'outbound' | 'inbound'

const STATUS_FILTERS: { id: InvoiceStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'sent', label: 'Sent' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'partially_paid', label: 'Partially Paid' },
  { id: 'paid', label: 'Paid' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'cancelled', label: 'Cancelled' },
]

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  draft: { label: 'Draft', classes: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
  sent: { label: 'Sent', classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  unpaid: { label: 'Unpaid', classes: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  partially_paid: { label: 'Partially Paid', classes: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  paid: { label: 'Paid', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
  overdue: { label: 'Overdue', classes: 'bg-red-500/20 text-red-400 border-red-500/30' },
  cancelled: { label: 'Cancelled', classes: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 ${config.classes}`}>
      {config.label}
    </span>
  )
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(amount / 100)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function companyName(companies: InvoiceRow['companies']): string {
  if (!companies) return '—'
  if (Array.isArray(companies)) return companies[0]?.name ?? '—'
  return companies.name
}

function projectName(projects: InvoiceRow['projects']): string {
  if (!projects) return '—'
  if (Array.isArray(projects)) return projects[0]?.name ?? '—'
  return projects.name
}

function invoiceNumber(inv: InvoiceRow): string {
  const prefix = inv.prefix ?? 'INV'
  return inv.number ? `${prefix}-${inv.number}` : '—'
}

export default function InvoicesList() {
  const { currentOrg, isVendor } = useOrg()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [directionTab, setDirectionTab] = useState<DirectionTab>(isVendor ? 'inbound' : 'outbound')
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!currentOrg?.id || !user?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      let query = supabase
        .from('invoices')
        .select('id, direction, number, prefix, status, issue_date, due_date, total, amount_due, currency_id, created_at, companies(name), projects(name)')
        .eq('org_id', currentOrg.id)
        .eq('direction', directionTab)
        .order('created_at', { ascending: false })

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter)
      }

      const { data, error } = await query
      if (!cancelled) {
        setInvoices(error ? [] : (data as InvoiceRow[]) ?? [])
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentOrg?.id, user?.id, directionTab, statusFilter])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return invoices
    return invoices.filter((inv) => {
      const num = invoiceNumber(inv).toLowerCase()
      const company = companyName(inv.companies).toLowerCase()
      const project = projectName(inv.projects).toLowerCase()
      return num.includes(q) || company.includes(q) || project.includes(q) || inv.status.includes(q)
    })
  }, [invoices, search])

  const isOutbound = directionTab === 'outbound'
  const entityLabel = isOutbound ? 'Invoice' : 'Bill'
  const entityLabelPlural = isOutbound ? 'Invoices' : 'Bills'
  const counterpartyLabel = isOutbound ? 'Client' : 'Vendor'

  return (
    <div className="p-4 md:p-6" data-testid="invoices-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold text-white">{entityLabelPlural}</h1>
        {!isVendor && (
          <Link
            to={`/invoices/new?direction=${directionTab}`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
            data-testid="invoice-create"
          >
            <Plus className="w-4 h-4" />
            New {entityLabel.toLowerCase()}
          </Link>
        )}
      </div>

      {/* Direction tabs — vendors only see Bills */}
      {!isVendor && (
        <div className="flex gap-1 mb-4 border-b border-border">
          <button
            type="button"
            onClick={() => { setDirectionTab('outbound'); setStatusFilter('all') }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              directionTab === 'outbound' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            Invoices
          </button>
          <button
            type="button"
            onClick={() => { setDirectionTab('inbound'); setStatusFilter('all') }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              directionTab === 'inbound' ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            Bills
          </button>
        </div>
      )}

      {/* Status filter pills */}
      <div className="flex flex-wrap gap-1 mb-4 border-b border-border pb-3">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatusFilter(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              statusFilter === f.id
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${entityLabelPlural.toLowerCase()}…`}
          className="w-full rounded-lg border border-border bg-surface-muted pl-10 pr-4 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-surface-muted text-sm">Loading…</div>
      ) : invoices.length === 0 && statusFilter === 'all' ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No {entityLabelPlural.toLowerCase()} yet</p>
          <p className="text-sm mt-1">
            {isVendor
              ? `${entityLabelPlural} from your clients will appear here.`
              : `Create ${entityLabel === 'Invoice' ? 'an' : 'a'} ${entityLabel.toLowerCase()} to get started.`}
          </p>
          {!isVendor && (
            <Link to={`/invoices/new?direction=${directionTab}`} className="inline-block mt-4 text-accent hover:underline">
              Create {entityLabel.toLowerCase()}
            </Link>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <p className="font-medium text-gray-200">No {entityLabelPlural.toLowerCase()} found</p>
          <p className="text-sm mt-1">Try another filter or clear your search.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          {/* Table header — hidden on mobile */}
          <div className="hidden md:grid md:grid-cols-[minmax(80px,1fr)_minmax(120px,2fr)_minmax(100px,1.5fr)_100px_100px_100px_100px_100px] gap-2 px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider bg-surface-muted/50 border-b border-border">
            <span>#</span>
            <span>{counterpartyLabel}</span>
            <span>Project</span>
            <span>Status</span>
            <span className="text-right">Total</span>
            <span className="text-right">Due</span>
            <span>Issued</span>
            <span>Due Date</span>
          </div>

          <ul className="divide-y divide-border" data-testid="invoice-list">
            {filtered.map((inv) => (
              <li key={inv.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/invoices/${inv.id}`)}
                  className="w-full text-left hover:bg-surface-muted transition-colors"
                >
                  {/* Desktop row */}
                  <div className="hidden md:grid md:grid-cols-[minmax(80px,1fr)_minmax(120px,2fr)_minmax(100px,1.5fr)_100px_100px_100px_100px_100px] gap-2 items-center px-4 py-3">
                    <span className="text-sm font-medium text-white truncate">{invoiceNumber(inv)}</span>
                    <span className="text-sm text-gray-300 truncate">{companyName(inv.companies)}</span>
                    <span className="text-sm text-gray-400 truncate">{projectName(inv.projects)}</span>
                    <StatusBadge status={inv.status} />
                    <span className="text-sm text-white text-right tabular-nums">{formatCurrency(inv.total)}</span>
                    <span className="text-sm text-gray-300 text-right tabular-nums">{formatCurrency(inv.amount_due)}</span>
                    <span className="text-xs text-gray-400">{formatDate(inv.issue_date)}</span>
                    <span className="text-xs text-gray-400">{formatDate(inv.due_date)}</span>
                  </div>

                  {/* Mobile row */}
                  <div className="md:hidden p-4 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white truncate">{invoiceNumber(inv)}</span>
                      <StatusBadge status={inv.status} />
                    </div>
                    <p className="text-sm text-gray-300 truncate">{companyName(inv.companies)}</p>
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span>Total: <span className="text-white">{formatCurrency(inv.total)}</span></span>
                      <span>Due: <span className="text-gray-200">{formatCurrency(inv.amount_due)}</span></span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>Issued {formatDate(inv.issue_date)}</span>
                      <span>Due {formatDate(inv.due_date)}</span>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
