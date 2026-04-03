import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { Plus, Target, Search } from 'lucide-react'

type LeadRow = {
  id: string
  title: string
  source: string
  status: string
  created_at: string
  companies: { name: string } | { name: string }[] | null
}

type LeadActivityStats = { count: number; lastAt: string | null }

type LeadFilter = 'untouched' | 'active' | 'stale' | 'closed_lost' | 'closed_won'

const FILTERS: { id: LeadFilter; label: string }[] = [
  { id: 'untouched', label: 'Untouched' },
  { id: 'active', label: 'Active' },
  { id: 'stale', label: 'Stale' },
  { id: 'closed_lost', label: 'Closed Lost' },
  { id: 'closed_won', label: 'Closed Won' },
]

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  researching: 'Researching',
  applying: 'Applying',
  applied: 'Applied',
  follow_up: 'Follow-up',
  interview: 'Interview',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
}

function prettyStatus(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function prettySource(source: string): string {
  return source.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function lastActivityLabel(stats: LeadActivityStats): string {
  if (stats.count === 0 || !stats.lastAt) return 'Never'
  return new Date(stats.lastAt).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' })
}

function leadMatchesFilter(lead: LeadRow, stats: LeadActivityStats, filter: LeadFilter, now: number): boolean {
  const closedLost = lead.status === 'closed_lost'
  const closedWon = lead.status === 'closed_won'
  const isClosed = closedLost || closedWon

  if (filter === 'closed_lost') return closedLost
  if (filter === 'closed_won') return closedWon

  const hasActivity = stats.count > 0
  const lastMs = stats.lastAt ? new Date(stats.lastAt).getTime() : 0

  if (filter === 'untouched') return !hasActivity

  if (filter === 'active') {
    if (isClosed || !hasActivity || !stats.lastAt) return false
    return now - lastMs <= FOURTEEN_DAYS_MS
  }

  if (filter === 'stale') {
    if (isClosed || !hasActivity || !stats.lastAt) return false
    return now - lastMs > FOURTEEN_DAYS_MS
  }

  return false
}

export default function LeadsList() {
  const { currentOrg } = useOrg()
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [activityByLead, setActivityByLead] = useState<Map<string, LeadActivityStats>>(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<LeadFilter>('untouched')

  useEffect(() => {
    if (!currentOrg?.id) return
    let cancelled = false
    setLoading(true)

    Promise.all([
      supabase
        .from('leads')
        .select('id, title, source, status, created_at, companies(name)')
        .eq('org_id', currentOrg.id),
      supabase.from('lead_attempts').select('lead_id, attempted_at').eq('org_id', currentOrg.id),
    ]).then(([leadsRes, attRes]) => {
      if (cancelled) return

      const attempts = (attRes.data ?? []) as { lead_id: string; attempted_at: string }[]
      const map = new Map<string, LeadActivityStats>()
      for (const a of attempts) {
        const cur = map.get(a.lead_id) ?? { count: 0, lastAt: null }
        cur.count += 1
        const t = new Date(a.attempted_at).getTime()
        const prev = cur.lastAt ? new Date(cur.lastAt).getTime() : 0
        if (t >= prev) cur.lastAt = a.attempted_at
        map.set(a.lead_id, cur)
      }
      setActivityByLead(map)
      setLeads(leadsRes.error ? [] : (leadsRes.data as LeadRow[]) ?? [])
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [currentOrg?.id])

  const filtered = useMemo(() => {
    const stat = (id: string) => activityByLead.get(id) ?? { count: 0, lastAt: null }
    const now = Date.now()
    const q = search.trim().toLowerCase()

    let rows = leads.filter((l) => leadMatchesFilter(l, stat(l.id), filter, now))

    if (q) {
      rows = rows.filter((l) => {
        const company = Array.isArray(l.companies) ? l.companies[0]?.name : l.companies?.name
        return (
          l.title.toLowerCase().includes(q) ||
          (company ?? '').toLowerCase().includes(q) ||
          l.status.toLowerCase().includes(q) ||
          l.source.toLowerCase().includes(q)
        )
      })
    }

    rows.sort((a, b) => {
      const sa = stat(a.id)
      const sb = stat(b.id)
      const ta = sa.lastAt ?? a.created_at
      const tb = sb.lastAt ?? b.created_at
      return new Date(tb).getTime() - new Date(ta).getTime()
    })

    return rows
  }, [leads, activityByLead, filter, search])

  return (
    <div className="p-4 md:p-6" data-testid="leads-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold text-white">Leads</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/leads/templates" className="inline-flex items-center px-3 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted">
            Resume templates
          </Link>
          <Link
            to="/leads/new"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" />
            New lead
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-4 border-b border-border pb-3">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === f.id ? 'border-accent text-accent bg-accent/10' : 'border-border text-gray-400 hover:text-gray-200'
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
          placeholder="Search leads, companies, source…"
          className="w-full rounded-lg border border-border bg-surface-muted pl-10 pr-4 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {loading ? (
        <div className="text-surface-muted text-sm">Loading…</div>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <Target className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No leads yet</p>
          <p className="text-sm mt-1">Create a lead to start tracking applications and outreach.</p>
          <Link to="/leads/new" className="inline-block mt-4 text-accent hover:underline">
            Start lead wizard
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400">
          <p className="font-medium text-gray-200">No leads in this view</p>
          <p className="text-sm mt-1">Try another filter or clear your search.</p>
        </div>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden" data-testid="lead-list">
          {filtered.map((lead) => {
            const company = Array.isArray(lead.companies) ? lead.companies[0]?.name : lead.companies?.name
            const stats = activityByLead.get(lead.id) ?? { count: 0, lastAt: null }
            return (
              <li key={lead.id}>
                <Link to={`/leads/${lead.id}`} className="flex items-center gap-3 p-4 hover:bg-surface-muted transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-white truncate">{lead.title}</p>
                    <p className="text-sm text-gray-400 truncate mt-0.5">
                      {company ?? 'No company'} • {prettySource(lead.source)} • {prettyStatus(lead.status)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1 sm:hidden">
                      Last activity: <span className="text-gray-300">{lastActivityLabel(stats)}</span>
                    </p>
                  </div>
                  <div className="shrink-0 text-right hidden sm:block text-xs">
                    <p className="text-gray-400">
                      Last activity: <span className="text-gray-200">{lastActivityLabel(stats)}</span>
                    </p>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
