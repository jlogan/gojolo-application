import { useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useOrg, type Organization } from '@/contexts/OrgContext'
import { LayoutGrid, Plus } from 'lucide-react'

export default function WorkspacePicker() {
  const {
    memberships,
    currentOrg,
    setCurrentOrg,
    isPlatformAdmin,
    allOrganizations,
  } = useOrg()
  const navigate = useNavigate()

  const orgsToShow: Organization[] = isPlatformAdmin ? allOrganizations : memberships.map((m) => m.org)
  const sortedOrgs = [...orgsToShow].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )

  useEffect(() => {
    if (memberships.length === 1 && !isPlatformAdmin) {
      setCurrentOrg(memberships[0].org)
      navigate('/', { replace: true })
    }
  }, [memberships, isPlatformAdmin, setCurrentOrg, navigate])

  const handleSelect = (org: Organization) => {
    setCurrentOrg(org)
    navigate('/', { replace: true })
  }

  if (memberships.length === 0 && !isPlatformAdmin) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center bg-surface px-4"
        data-testid="workspace-picker-page"
      >
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-white mb-1">Choose a workspace</h1>
          <p className="text-gray-400 text-sm mt-4" data-testid="workspace-none">
            You don&apos;t have access to any workspace yet. Contact an admin to get invited.
          </p>
        </div>
      </div>
    )
  }

  if (memberships.length === 1 && !isPlatformAdmin) {
    return null
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-surface px-4 py-8"
      data-testid="workspace-picker-page"
    >
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold text-white mb-1">
          {isPlatformAdmin ? 'All workspaces' : 'Choose a workspace'}
        </h1>
        <p className="text-gray-400 text-sm mb-6">
          {isPlatformAdmin
            ? 'Switch to any organization to manage it, or add a new one from Admin.'
            : 'Select an organization to continue.'}
        </p>

        <ul className="space-y-2" role="list" data-testid="workspace-list">
          {sortedOrgs.map((org) => (
            <li key={org.id}>
              <button
                type="button"
                onClick={() => handleSelect(org)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                  currentOrg?.id === org.id
                    ? 'bg-surface-elevated border-accent text-white'
                    : 'bg-surface-muted border-border text-gray-200 hover:border-gray-500'
                }`}
                data-testid={`workspace-${org.slug}`}
              >
                <LayoutGrid
                  className={`w-5 h-5 shrink-0 ${
                    currentOrg?.id === org.id ? 'text-accent' : 'text-gray-500'
                  }`}
                />
                <span className="font-medium">{org.name}</span>
              </button>
            </li>
          ))}
        </ul>

        {isPlatformAdmin && (
          <Link
            to="/admin"
            className="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-dashed border-border text-gray-400 hover:border-accent/50 hover:text-accent transition-colors text-sm font-medium"
            data-testid="workspace-add-org"
          >
            <Plus className="w-4 h-4" />
            Add organization (Admin)
          </Link>
        )}
      </div>
    </div>
  )
}
