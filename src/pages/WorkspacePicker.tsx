import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { LayoutGrid } from 'lucide-react'

export default function WorkspacePicker() {
  const { memberships, currentOrg, setCurrentOrg } = useOrg()
  const navigate = useNavigate()

  const sortedMemberships = [...memberships].sort((a, b) =>
    a.org.name.localeCompare(b.org.name, undefined, { sensitivity: 'base' })
  )

  useEffect(() => {
    if (memberships.length === 1) {
      setCurrentOrg(memberships[0].org)
      navigate('/', { replace: true })
    }
  }, [memberships, setCurrentOrg, navigate])

  const handleSelect = (orgId: string) => {
    const m = memberships.find((x) => x.org.id === orgId)
    if (m) {
      setCurrentOrg(m.org)
      navigate('/', { replace: true })
    }
  }

  if (memberships.length === 0) {
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

  if (memberships.length === 1) {
    return null
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-surface px-4"
      data-testid="workspace-picker-page"
    >
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold text-white mb-1">Choose a workspace</h1>
        <p className="text-gray-400 text-sm mb-6">Select an organization to continue.</p>

        <ul className="space-y-2" role="list" data-testid="workspace-list">
          {sortedMemberships.map(({ org }) => (
            <li key={org.id}>
              <button
                type="button"
                onClick={() => handleSelect(org.id)}
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
      </div>
    </div>
  )
}
