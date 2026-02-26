import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOrg, type Organization } from '@/contexts/OrgContext'
import { Building2, Search, ArrowRight } from 'lucide-react'

export default function OrganizationsList() {
  const { currentOrg, setCurrentOrg, isPlatformAdmin, memberships, allOrganizations } = useOrg()
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')

  const orgs: Organization[] = isPlatformAdmin ? allOrganizations : memberships.map((m) => m.org)
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return [...orgs].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return orgs
      .filter((o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [orgs, filter])

  const handleSwitch = (org: Organization) => {
    setCurrentOrg(org)
    navigate('/', { replace: true })
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl" data-testid="organizations-list-page">
      <h1 className="text-xl font-semibold text-white mb-2">Organizations</h1>
      <p className="text-gray-400 text-sm mb-4">
        {isPlatformAdmin
          ? 'All organizations. Switch to any to manage it.'
          : 'Organizations you have access to. Switch to work in a different workspace.'}
      </p>

      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or slug…"
          className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-border bg-surface-muted text-gray-200 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
          data-testid="organizations-filter"
        />
      </div>

      <div className="rounded-lg border border-border bg-surface-elevated overflow-hidden">
        <table className="w-full text-left text-sm" data-testid="organizations-table">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 font-medium text-gray-400">Name</th>
              <th className="px-4 py-3 font-medium text-gray-400">Slug</th>
              <th className="px-4 py-3 font-medium text-gray-400 w-40">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                  {filter ? 'No organizations match the filter.' : 'No organizations.'}
                </td>
              </tr>
            ) : (
              filtered.map((org) => (
                <tr key={org.id} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-gray-500 shrink-0" />
                      <span className="font-medium text-gray-200">{org.name}</span>
                      {currentOrg?.id === org.id && (
                        <span className="text-xs px-2 py-0.5 rounded bg-accent/20 text-accent">Current</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{org.slug}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleSwitch(org)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 text-sm font-medium transition-colors"
                      data-testid={`org-switch-${org.slug}`}
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                      Switch to this organization
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
