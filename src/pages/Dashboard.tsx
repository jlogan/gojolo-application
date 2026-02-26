import { useOrg } from '@/contexts/OrgContext'

export default function Dashboard() {
  const { currentOrg } = useOrg()

  return (
    <div className="p-4 md:p-6" data-testid="dashboard-page">
      <h1 className="text-xl font-semibold text-white mb-2">
        Welcome to {currentOrg?.name ?? 'jolo'}
      </h1>
      <p className="text-gray-400 text-sm">
        Use the sidebar to open Contacts, Companies, or switch to Chat mode.
      </p>
    </div>
  )
}
