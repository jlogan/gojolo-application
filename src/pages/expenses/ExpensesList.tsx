import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { Plus, Receipt, Search } from 'lucide-react'

type ExpenseRow = {
  id: string
  name: string
  category: string | null
  amount: number
  currency_id: string | null
  expense_date: string | null
  billable: boolean
  invoice_id: string | null
  payment_method: string | null
  note: string | null
  created_at: string
  projects: { name: string } | { name: string }[] | null
  invoices: { number: string | null; prefix: string | null } | { number: string | null; prefix: string | null }[] | null
}

type FilterTab = 'all' | 'billable' | 'billed' | 'non_billable'

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'billable', label: 'Billable' },
  { id: 'billed', label: 'Billed' },
  { id: 'non_billable', label: 'Non-billable' },
]

const CATEGORY_CONFIG: Record<string, { label: string; classes: string }> = {
  general: { label: 'General', classes: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
  travel: { label: 'Travel', classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  software: { label: 'Software', classes: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  hardware: { label: 'Hardware', classes: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  subcontractor: { label: 'Subcontractor', classes: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  office: { label: 'Office', classes: 'bg-teal-500/20 text-teal-400 border-teal-500/30' },
  other: { label: 'Other', classes: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
}

function CategoryBadge({ category }: { category: string | null }) {
  const key = (category ?? 'general').toLowerCase()
  const config = CATEGORY_CONFIG[key] ?? CATEGORY_CONFIG.other
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 ${config.classes}`}>
      {config.label}
    </span>
  )
}

function BillableBadge({ billable, invoiceId }: { billable: boolean; invoiceId: string | null }) {
  if (invoiceId) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 bg-green-500/20 text-green-400 border-green-500/30">
        Billed
      </span>
    )
  }
  if (billable) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 bg-blue-500/20 text-blue-400 border-blue-500/30">
        Billable
      </span>
    )
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 bg-gray-500/20 text-gray-400 border-gray-500/30">
      Non-billable
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

function projectName(projects: ExpenseRow['projects']): string {
  if (!projects) return '—'
  if (Array.isArray(projects)) return projects[0]?.name ?? '—'
  return projects.name
}

function invoiceLabel(invoices: ExpenseRow['invoices']): string | null {
  if (!invoices) return null
  const inv = Array.isArray(invoices) ? invoices[0] : invoices
  if (!inv) return null
  const prefix = inv.prefix ?? 'INV'
  return inv.number ? `${prefix}-${inv.number}` : 'Invoice'
}

export default function ExpensesList() {
  const { currentOrg } = useOrg()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [expenses, setExpenses] = useState<ExpenseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!currentOrg?.id || !user?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      let query = supabase
        .from('expenses')
        .select('id, name, category, amount, currency_id, expense_date, billable, invoice_id, payment_method, note, created_at, projects(name), invoices(number, prefix)')
        .eq('org_id', currentOrg.id)
        .order('expense_date', { ascending: false })

      if (filterTab === 'billable') {
        query = query.eq('billable', true).is('invoice_id', null)
      } else if (filterTab === 'billed') {
        query = query.not('invoice_id', 'is', null)
      } else if (filterTab === 'non_billable') {
        query = query.eq('billable', false)
      }

      const { data, error } = await query
      if (!cancelled) {
        setExpenses(error ? [] : (data as ExpenseRow[]) ?? [])
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentOrg?.id, user?.id, filterTab])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return expenses
    return expenses.filter((exp) => {
      const name = exp.name.toLowerCase()
      const cat = (exp.category ?? '').toLowerCase()
      const project = projectName(exp.projects).toLowerCase()
      return name.includes(q) || cat.includes(q) || project.includes(q)
    })
  }, [expenses, search])

  return (
    <div className="p-4 md:p-6" data-testid="expenses-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold text-white">Expenses</h1>
        <Link
          to="/expenses/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
          data-testid="expense-create"
        >
          <Plus className="w-4 h-4" />
          New expense
        </Link>
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1 mb-4 border-b border-border pb-3">
        {FILTER_TABS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilterTab(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filterTab === f.id
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
          placeholder="Search expenses…"
          className="w-full rounded-lg border border-border bg-surface-muted pl-10 pr-4 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-surface-muted text-sm">Loading…</div>
      ) : expenses.length === 0 && filterTab === 'all' ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <Receipt className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No expenses yet</p>
          <p className="text-sm mt-1">Add an expense to get started.</p>
          <Link to="/expenses/new" className="inline-block mt-4 text-accent hover:underline">
            Add expense
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <p className="font-medium text-gray-200">No expenses found</p>
          <p className="text-sm mt-1">Try another filter or clear your search.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          {/* Table header — hidden on mobile */}
          <div className="hidden md:grid md:grid-cols-[2fr_100px_100px_120px_1.5fr_100px_100px] gap-2 px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider bg-surface-muted/50 border-b border-border">
            <span>Name</span>
            <span>Category</span>
            <span className="text-right">Amount</span>
            <span>Date</span>
            <span>Project</span>
            <span>Billable</span>
            <span>Invoice</span>
          </div>

          <ul className="divide-y divide-border" data-testid="expense-list">
            {filtered.map((exp) => {
              const invLabel = invoiceLabel(exp.invoices)
              return (
                <li key={exp.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/expenses/${exp.id}/edit`)}
                    className="w-full text-left hover:bg-surface-muted transition-colors"
                  >
                    {/* Desktop row */}
                    <div className="hidden md:grid md:grid-cols-[2fr_100px_100px_120px_1.5fr_100px_100px] gap-2 items-center px-4 py-3">
                      <span className="text-sm font-medium text-white truncate">{exp.name}</span>
                      <CategoryBadge category={exp.category} />
                      <span className="text-sm text-white text-right tabular-nums">{formatCurrency(exp.amount)}</span>
                      <span className="text-xs text-gray-400">{formatDate(exp.expense_date)}</span>
                      <span className="text-sm text-gray-400 truncate">{projectName(exp.projects)}</span>
                      <BillableBadge billable={exp.billable} invoiceId={exp.invoice_id} />
                      {exp.invoice_id && invLabel ? (
                        <Link
                          to={`/invoices/${exp.invoice_id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-accent hover:underline truncate"
                        >
                          {invLabel}
                        </Link>
                      ) : (
                        <span className="text-xs text-gray-500">—</span>
                      )}
                    </div>

                    {/* Mobile row */}
                    <div className="md:hidden p-4 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-white truncate">{exp.name}</span>
                        <BillableBadge billable={exp.billable} invoiceId={exp.invoice_id} />
                      </div>
                      <div className="flex items-center gap-2">
                        <CategoryBadge category={exp.category} />
                        <span className="text-sm text-gray-400 truncate">{projectName(exp.projects)}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-gray-400">
                        <span>Amount: <span className="text-white">{formatCurrency(exp.amount)}</span></span>
                        <span>{formatDate(exp.expense_date)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
