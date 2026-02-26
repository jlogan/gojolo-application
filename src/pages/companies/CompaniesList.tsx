import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { Plus, Building2 } from 'lucide-react'

export type Company = {
  id: string
  org_id: string
  name: string
  industry: string | null
  meta: Record<string, unknown> | null
  created_at: string
}

export default function CompaniesList() {
  const { currentOrg } = useOrg()
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!currentOrg?.id) return
    let cancelled = false
    setLoading(true)
    supabase
      .from('companies')
      .select('id, org_id, name, industry, meta, created_at')
      .eq('org_id', currentOrg.id)
      .order('name')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error(error)
          setCompanies([])
        } else {
          setCompanies((data as Company[]) ?? [])
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentOrg?.id])

  return (
    <div className="p-4 md:p-6" data-testid="companies-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <h1 className="text-xl font-semibold text-white">Companies</h1>
        <Link
          to="/companies/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90"
          data-testid="company-create"
        >
          <Plus className="w-4 h-4" />
          Add company
        </Link>
      </div>

      {loading ? (
        <div className="text-surface-muted text-sm" data-testid="companies-loading">
          Loading…
        </div>
      ) : companies.length === 0 ? (
        <div
          className="rounded-lg border border-border bg-surface-muted/50 p-8 text-center text-gray-400"
          data-testid="companies-empty"
        >
          <Building2 className="w-10 h-10 mx-auto mb-3 opacity-60" />
          <p className="font-medium text-gray-200">No companies yet</p>
          <p className="text-sm mt-1">Add a company to get started.</p>
          <Link
            to="/companies/new"
            className="inline-block mt-4 text-accent hover:underline"
            data-testid="company-create-empty"
          >
            Add company
          </Link>
        </div>
      ) : (
        <ul
          className="rounded-lg border border-border divide-y divide-border overflow-hidden"
          data-testid="company-list"
        >
          {companies.map((c) => (
            <li key={c.id}>
              <Link
                to={`/companies/${c.id}`}
                className="flex items-center gap-4 p-4 hover:bg-surface-muted transition-colors"
                data-testid={`company-row-${c.id}`}
              >
                <div className="w-10 h-10 rounded-lg bg-surface-muted flex items-center justify-center shrink-0">
                  <Building2 className="w-5 h-5 text-surface-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white truncate">{c.name}</p>
                  {c.industry && (
                    <p className="text-sm text-surface-muted truncate">{c.industry}</p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
