import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import Login from '@/pages/Login'
import WorkspacePicker from '@/pages/WorkspacePicker'
import AppShell from '@/components/AppShell'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface" data-testid="auth-loading">
        <div className="animate-pulse text-surface-muted">Loading…</div>
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function RequireOrg({ children }: { children: React.ReactNode }) {
  const { currentOrg, memberships, loading } = useOrg()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface" data-testid="org-loading">
        <div className="animate-pulse text-surface-muted">Loading workspace…</div>
      </div>
    )
  }
  if (memberships.length === 0) return <Navigate to="/workspace" replace />
  if (!currentOrg) return <Navigate to="/workspace" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/workspace"
        element={
          <RequireAuth>
            <WorkspacePicker />
          </RequireAuth>
        }
      />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <RequireOrg>
              <AppShell />
            </RequireOrg>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
